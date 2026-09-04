/**
 * Credential-injecting proxy for fleet backends.
 *
 * `/backend/<entry id>/<path>` is proxied to that registry entry's host with
 * its session key resolved server-side and attached on the way out, so a
 * browser can drive a fleet machine it holds no credential for.
 *
 * A path prefix works as a backend base URL because the SDK's HTTP client
 * resolves request paths relative to it and the websocket helpers carry the
 * prefix through (the same shape as the existing `/runtime/<port>` proxy
 * deployments).
 *
 * It fails closed: an unknown entry is a 404, an entry that is not `active`
 * is a 403, and a credential the provider cannot resolve is a 502. None of
 * those fall back to proxying without a credential.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { RegistryError } from "./registry/store.mjs";

const execFileAsync = promisify(execFile);

export const BACKEND_PROXY_PREFIX = "/backend";
const SESSION_KEY_HEADER = "x-session-api-key";
const SECRET_CACHE_TTL_MS = 60_000;
const IDENTITY_CACHE_TTL_MS = 300_000;
const TAILSCALE_WHOIS_TIMEOUT_MS = 2_000;

/** `/backend/<id>/rest?query` -> `{ id, path }`, or null when it is not ours. */
export function parseBackendProxyUrl(rawUrl) {
  const url = new URL(rawUrl ?? "/", "http://localhost");
  const segments = url.pathname.split("/");
  if (segments[1] !== "backend" || !segments[2]) return null;
  return {
    id: decodeURIComponent(segments[2]),
    path: `/${segments.slice(3).join("/")}${url.search}`,
  };
}

export function isBackendProxyRequest(req) {
  return parseBackendProxyUrl(req.url) !== null;
}

/**
 * Replaces any inbound credential with the one the proxy resolved. Stripping
 * unconditionally is the point of the exercise: a key arriving from a browser
 * is the thing this proxy exists to remove.
 */
export function applyCredential(headers, credential) {
  delete headers[SESSION_KEY_HEADER];
  delete headers.authorization;
  if (credential) headers[SESSION_KEY_HEADER] = credential;
}

function remoteAddress(req) {
  const address = req.socket?.remoteAddress ?? "";
  // Node reports IPv4 peers on a dual-stack socket as ::ffff:10.0.0.1.
  return address.startsWith("::ffff:") ? address.slice(7) : address;
}

/**
 * Resolves the tailnet machine and user behind a source address. Returns null
 * whenever the answer is not available (no `tailscale` binary, not a tailnet
 * peer, lookup too slow) so a policy sees "unknown", never a wrong identity.
 *
 * @param {{
 *   binary?: string,
 *   run?: (file: string, args: string[], options?: object) => Promise<{ stdout: string }>,
 *   ttlMs?: number,
 *   now?: () => number,
 * }} [options]
 */
export function createTailscaleIdentityResolver({
  binary = "tailscale",
  run = execFileAsync,
  ttlMs = IDENTITY_CACHE_TTL_MS,
  now = () => Date.now(),
} = {}) {
  // ponytail: unbounded map keyed by peer address; a tailnet is small enough
  // that this stays tiny. Swap for an LRU if it ever fronts the open internet.
  const cache = new Map();

  return async function resolveIdentity(req) {
    const address = remoteAddress(req);
    if (!address) return null;

    const cached = cache.get(address);
    if (cached && now() - cached.at < ttlMs) return cached.identity;

    let identity = null;
    try {
      const { stdout } = await run(binary, ["whois", "--json", address], {
        timeout: TAILSCALE_WHOIS_TIMEOUT_MS,
      });
      const parsed = JSON.parse(stdout);
      identity = {
        address,
        machine: parsed?.Node?.Name ?? null,
        user: parsed?.UserProfile?.LoginName ?? null,
      };
    } catch {
      identity = null;
    }

    cache.set(address, { identity, at: now() });
    return identity;
  };
}

export function createBackendProxy({
  store,
  secrets,
  proxy,
  /**
   * Optional policy: `({ identity, entry }) => boolean`. When absent no
   * identity is resolved at all, so the `tailscale whois` subprocess only runs
   * for a deployment that actually has a policy to apply.
   */
  authorize = null,
  resolveIdentity = createTailscaleIdentityResolver(),
  now = () => Date.now(),
}) {
  const secretCache = new Map();

  async function resolveCredential(entry) {
    if (!entry.credRef) return null;
    if (!secrets) {
      throw new RegistryError(
        502,
        "no_secret_provider",
        `${entry.name} has a credential reference but no secret provider is configured`,
      );
    }

    const cached = secretCache.get(entry.credRef);
    if (cached && now() - cached.at < SECRET_CACHE_TTL_MS) return cached.value;

    let value;
    try {
      value = await secrets.get(entry.credRef);
    } catch (error) {
      throw new RegistryError(
        502,
        "credential_unavailable",
        `cannot resolve ${entry.credRef}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    secretCache.set(entry.credRef, { value, at: now() });
    return value;
  }

  async function resolveTarget(id, req) {
    const entry = await store.get(id);
    if (!entry) {
      throw new RegistryError(404, "not_found", `no backend with id ${id}`);
    }
    if (entry.state !== "active") {
      throw new RegistryError(
        403,
        "not_active",
        `${entry.name} is ${entry.state}, not active`,
      );
    }

    if (authorize) {
      const identity = await resolveIdentity(req);
      if (!(await authorize({ identity, entry }))) {
        throw new RegistryError(
          403,
          "forbidden",
          `caller may not reach ${entry.name}`,
        );
      }
    }

    return { entry, credential: await resolveCredential(entry) };
  }

  return {
    async handle(req, res) {
      const parsed = parseBackendProxyUrl(req.url);
      if (!parsed) {
        res.writeHead(404).end();
        return;
      }

      let target;
      try {
        target = await resolveTarget(parsed.id, req);
      } catch (error) {
        const status = error instanceof RegistryError ? error.status : 500;
        const code =
          error instanceof RegistryError ? error.code : "internal_error";
        const message =
          error instanceof RegistryError
            ? error.message
            : "backend proxy error";
        if (status >= 500) console.error(`[backend-proxy] ${code}:`, error);
        const body = Buffer.from(
          JSON.stringify({ error: code, message }),
          "utf8",
        );
        res.writeHead(status, {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Length": body.length,
          "Cache-Control": "no-store",
        });
        res.end(body);
        return;
      }

      req.url = parsed.path;
      applyCredential(req.headers, target.credential);
      proxy.proxyHttp(req, res, target.entry.host);
    },

    async handleUpgrade(req, socket, head) {
      const parsed = parseBackendProxyUrl(req.url);
      if (!parsed) {
        socket.destroy();
        return;
      }

      let target;
      try {
        target = await resolveTarget(parsed.id, req);
      } catch {
        // There is no useful status line to send on a rejected upgrade.
        socket.destroy();
        return;
      }

      req.url = parsed.path;
      applyCredential(req.headers, target.credential);
      proxy.proxyWebSocket(req, socket, head, target.entry.host);
    },
  };
}
