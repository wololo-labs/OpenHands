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
 * The caller is authenticated with the *master's* session key, the one the
 * canvas already holds for this origin, and it is stripped before the request
 * goes out. Without that check this route would be strictly weaker than the
 * one it replaces: `/api/*` reaches an agent server that authenticates for
 * itself, whereas here the proxy satisfies the node's authentication on the
 * caller's behalf, so anyone who could reach the ingress would reach every
 * active fleet machine. The browser therefore sends the key it is entitled to
 * and receives none in return; the node's key never leaves this process.
 *
 * It fails closed: an unauthenticated caller is a 401, an unknown entry is a
 * 404, an entry that is not `active` is a 403, an entry with no credential
 * reference is a 403 unless the deployment opted in, and a credential the
 * provider cannot resolve is a 502. None of those fall back to proxying
 * without a credential.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { secretMatches } from "./registry/session-key.mjs";
import { RegistryError } from "./registry/store.mjs";

const execFileAsync = promisify(execFile);

export const BACKEND_PROXY_PREFIX = "/backend";
const SESSION_KEY_HEADER = "x-session-api-key";
// A browser cannot set a header on a WebSocket handshake, so the SDK's socket
// clients pass the key as a query parameter instead. It therefore has to be
// read, and stripped, on the same footing as the header.
const SESSION_KEY_QUERY = "session_api_key";
const SECRET_CACHE_TTL_MS = 60_000;
const ENTRY_CACHE_TTL_MS = 5_000;
const IDENTITY_CACHE_TTL_MS = 300_000;
const TAILSCALE_WHOIS_TIMEOUT_MS = 2_000;

/**
 * `/backend/<id>/rest?query` -> `{ id, path }`, or null when it is not ours.
 *
 * Returns null rather than throwing on a malformed id. This runs inside the
 * server's `request` and `upgrade` listeners, where an exception is not caught
 * by anything and takes the process down: `decodeURIComponent("%")` throws a
 * URIError, so `GET /backend/%` would otherwise kill the ingress from one
 * unauthenticated request. "Not ours" already falls through to the normal
 * route table, which answers 404.
 */
export function parseBackendProxyUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl ?? "/", "http://localhost");
  } catch {
    return null;
  }
  const segments = url.pathname.split("/");
  if (segments[1] !== "backend" || !segments[2]) return null;

  let id;
  try {
    id = decodeURIComponent(segments[2]);
  } catch {
    return null;
  }
  return {
    id,
    pathname: `/${segments.slice(3).join("/")}`,
    search: url.searchParams,
  };
}

/**
 * The credential the caller presented, from either channel. Returns "" rather
 * than null so the constant-time comparison always runs on a string.
 */
export function callerCredential(req, search) {
  const header = req?.headers?.[SESSION_KEY_HEADER];
  if (typeof header === "string" && header !== "") return header;
  return search?.get(SESSION_KEY_QUERY) ?? "";
}

/**
 * Rewrites the outgoing query string the way `applyCredential` rewrites the
 * outgoing headers. The caller's own key is always removed: without this it
 * rides to the fleet node in the URL on every WebSocket upgrade, which is the
 * leak the header stripping exists to prevent, just through the other channel.
 *
 * The resolved credential is only put *back* into the query for an upgrade,
 * where a browser cannot set a header. An ordinary request carries it in the
 * header instead, so it stays out of the fleet node's access log.
 */
export function applyCredentialToPath(
  pathname,
  search,
  credential,
  { inQuery = false } = {},
) {
  const params = new URLSearchParams(search ?? "");
  params.delete(SESSION_KEY_QUERY);
  if (credential && inQuery) params.set(SESSION_KEY_QUERY, credential);
  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}

export function isBackendProxyRequest(req) {
  return parseBackendProxyUrl(req.url) !== null;
}

/**
 * Every header a caller could carry a credential in. The browser reaches the
 * proxy on the canvas's own origin, so it attaches that origin's cookies to
 * these requests without being asked; forwarding them would hand a live canvas
 * credential to whichever machine the entry points at.
 */
const INBOUND_CREDENTIAL_HEADERS = Object.freeze([
  SESSION_KEY_HEADER,
  "authorization",
  "proxy-authorization",
  "cookie",
  "cookie2",
  "x-api-key",
]);

/**
 * Replaces any inbound credential with the one the proxy resolved. Stripping
 * unconditionally is the point of the exercise: a credential arriving from a
 * browser is the thing this proxy exists to remove, and it is removed whether
 * or not a replacement was resolved.
 */
export function applyCredential(headers, credential) {
  for (const header of INBOUND_CREDENTIAL_HEADERS) {
    delete headers[header];
  }
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
   * The master's session key. Every request to `/backend/:id/*` must carry it.
   * Required: a proxy that injects credentials without checking who is asking
   * is an open door to the whole fleet.
   */
  sessionKey,
  /**
   * Proxy entries that carry no credential reference at all. Off by default so
   * FR-020 holds as written -- a discovered entry with no credential would
   * otherwise be relayed to uncredentialed, which on an agent server that does
   * not authenticate makes this an open relay into the cluster.
   */
  allowUncredentialed = false,
  /**
   * Optional policy: `({ identity, entry }) => boolean`, applied after the
   * session-key check. When absent no identity is resolved at all, so the
   * `tailscale whois` subprocess only runs for a deployment that actually has
   * a policy to apply.
   */
  authorize = null,
  /**
   * Optional append-only wire record, from `createAccessLog`. Absent by
   * default so an ingress started the way it is today writes nothing new.
   * When present it sees the *inbound* URL, before any rewrite, which is the
   * only place a WebSocket upgrade's credential is visible -- see the
   * redaction note in access-log.mjs.
   */
  accessLog = null,
  resolveIdentity = createTailscaleIdentityResolver(),
  now = () => Date.now(),
}) {
  if (!sessionKey) {
    throw new Error("createBackendProxy requires sessionKey");
  }

  const secretCache = new Map();
  /** Entry list, valid while the store's revision and the TTL both hold. */
  let entryCache = null;

  function requireCaller(req, search) {
    if (!secretMatches(callerCredential(req, search), sessionKey)) {
      throw new RegistryError(401, "unauthorized", "a session key is required");
    }
  }

  /**
   * The entry list, cached. `store.get()` is a full `list()` behind the
   * scenes, so without this every proxied request pulls the whole settings
   * document from the agent server. The revision check makes an approval or a
   * revocation visible immediately rather than at the end of the TTL, which
   * matters because revocation is a security control.
   */
  async function lookupEntry(id) {
    const revision = store.getRevision?.() ?? null;
    const fresh =
      entryCache !== null &&
      entryCache.revision === revision &&
      now() - entryCache.at < ENTRY_CACHE_TTL_MS;

    if (!fresh) {
      entryCache = { entries: await store.list(), revision, at: now() };
    }
    return entryCache.entries.find((entry) => entry.id === id) ?? null;
  }

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

  async function resolveTarget(id, req, search) {
    // Before anything that touches the store: an unauthenticated caller must
    // not be able to probe which entry ids exist, or to make the proxy fetch
    // the settings document on their behalf.
    requireCaller(req, search);

    const entry = await lookupEntry(id);
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
    if (!entry.credRef && !allowUncredentialed) {
      throw new RegistryError(
        403,
        "no_credential",
        `${entry.name} has no credential reference; start the ingress with ` +
          "--registry-allow-uncredentialed to proxy entries like it",
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
      // Captured before anything rewrites it: the record has to be of what
      // the caller asked for, not of what the proxy turned it into.
      const inboundUrl = req.url;
      const parsed = parseBackendProxyUrl(inboundUrl);
      if (!parsed) {
        res.writeHead(404).end();
        return;
      }

      let target;
      try {
        target = await resolveTarget(parsed.id, req, parsed.search);
      } catch (error) {
        const status = error instanceof RegistryError ? error.status : 500;
        const code =
          error instanceof RegistryError ? error.code : "internal_error";
        const message =
          error instanceof RegistryError
            ? error.message
            : "backend proxy error";
        if (status >= 500) console.error(`[backend-proxy] ${code}:`, error);
        // A refusal is evidence too: "the node was never reached" is exactly
        // the claim this log has to be able to settle.
        accessLog?.record({
          url: inboundUrl,
          method: req.method,
          kind: "http",
          outcome: `refused:${status}`,
          error: code,
        });
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

      accessLog?.record({
        url: inboundUrl,
        method: req.method,
        kind: "http",
        entry: target.entry,
        credentialInjected: Boolean(target.credential),
      });

      req.url = applyCredentialToPath(
        parsed.pathname,
        parsed.search,
        target.credential,
      );
      applyCredential(req.headers, target.credential);
      proxy.proxyHttp(req, res, target.entry.host);
    },

    async handleUpgrade(req, socket, head) {
      const inboundUrl = req.url;
      const parsed = parseBackendProxyUrl(inboundUrl);
      if (!parsed) {
        socket.destroy();
        return;
      }

      let target;
      try {
        target = await resolveTarget(parsed.id, req, parsed.search);
      } catch (error) {
        accessLog?.record({
          url: inboundUrl,
          method: req.method,
          kind: "upgrade",
          outcome: "refused",
          error: error instanceof RegistryError ? error.code : "internal_error",
        });
        // There is no useful status line to send on a rejected upgrade.
        socket.destroy();
        return;
      }

      accessLog?.record({
        url: inboundUrl,
        method: req.method,
        kind: "upgrade",
        entry: target.entry,
        credentialInjected: Boolean(target.credential),
      });

      req.url = applyCredentialToPath(
        parsed.pathname,
        parsed.search,
        target.credential,
        { inQuery: true },
      );
      applyCredential(req.headers, target.credential);
      proxy.proxyWebSocket(req, socket, head, target.entry.host);
    },
  };
}
