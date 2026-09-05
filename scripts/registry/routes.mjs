/**
 * The `/api/registry/*` REST surface, served in-process by the ingress.
 *
 *   GET    /api/registry            list entries          (session-key auth)
 *   POST   /api/registry/register   signed enrolment      (signature auth)
 *   POST   /api/registry/:id/approve  { host }            (session-key auth)
 *   POST   /api/registry/:id/revoke                       (session-key auth)
 *
 * Approve names the host it is approving and answers 409 if the entry has
 * moved since, so the decision is bound to what the operator actually read.
 *
 * Registration is deliberately the one route with no session key: a freshly
 * provisioned node has its own host key but none of the master's credentials.
 */

import { createEnrolment } from "./enrolment.mjs";
import { createInlineProvider } from "./providers/inline.mjs";
import { secretMatches } from "./session-key.mjs";
import { createStore, normaliseHost, RegistryError } from "./store.mjs";

const REGISTRY_PREFIX = "/api/registry";
const SIGNATURE_HEADER = "x-registry-signature";
const SESSION_KEY_HEADER = "x-session-api-key";
const DEFAULT_MAX_BODY_BYTES = 64 * 1024;

export function isRegistryRequest(req) {
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  return (
    pathname === REGISTRY_PREFIX || pathname.startsWith(`${REGISTRY_PREFIX}/`)
  );
}

function sendJson(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": payload.length,
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

function sendError(res, error) {
  const status = error instanceof RegistryError ? error.status : 500;
  const code = error instanceof RegistryError ? error.code : "internal_error";
  const message =
    error instanceof RegistryError ? error.message : "internal registry error";
  if (status >= 500) {
    console.error(`[registry] ${code}:`, error);
  }
  sendJson(res, status, { error: code, message });
}

async function readJsonBody(req, maxBodyBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBodyBytes) {
      throw new RegistryError(
        413,
        "body_too_large",
        "request body is too large",
      );
    }
    chunks.push(chunk);
  }
  if (size === 0) {
    throw new RegistryError(400, "invalid_body", "request body is required");
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RegistryError(400, "invalid_body", "request body must be JSON");
  }
}

/**
 * Assembles provider -> store -> enrolment -> HTTP handler from the ingress
 * configuration. `handle()` resolves once the response has been written.
 *
 * @param {{
 *   agentServerUrl?: string,
 *   sessionKey: string,
 *   preSeededFingerprints?: string[],
 *   fetchImpl?: typeof globalThis.fetch,
 *   maxBodyBytes?: number,
 *   provider?: any,
 *   now?: () => number,
 * }} options
 */
export function createRegistry({
  agentServerUrl,
  sessionKey,
  preSeededFingerprints = [],
  fetchImpl,
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
  provider = createInlineProvider({
    baseUrl: agentServerUrl,
    sessionKey,
    fetchImpl,
  }),
  now,
}) {
  if (!sessionKey) {
    throw new Error("createRegistry requires sessionKey");
  }

  const store = createStore(provider);
  const enrolment = createEnrolment({
    store,
    allowlist: preSeededFingerprints,
    ...(now ? { now } : {}),
  });

  function requireSessionKey(req) {
    if (!secretMatches(req.headers[SESSION_KEY_HEADER], sessionKey)) {
      throw new RegistryError(401, "unauthorized", "a session key is required");
    }
  }

  async function route(req, res) {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    const method = req.method ?? "GET";

    if (pathname === REGISTRY_PREFIX) {
      if (method !== "GET") {
        throw new RegistryError(405, "method_not_allowed", "use GET");
      }
      requireSessionKey(req);
      sendJson(res, 200, { entries: await store.list() });
      return;
    }

    if (pathname === `${REGISTRY_PREFIX}/register`) {
      if (method !== "POST") {
        throw new RegistryError(405, "method_not_allowed", "use POST");
      }
      const body = await readJsonBody(req, maxBodyBytes);
      const { entry, created } = await enrolment.register(
        body,
        req.headers[SIGNATURE_HEADER],
      );
      sendJson(res, created ? 201 : 200, { id: entry.id, state: entry.state });
      return;
    }

    const action = pathname.match(
      /^\/api\/registry\/([^/]+)\/(approve|revoke)$/,
    );
    if (action) {
      if (method !== "POST") {
        throw new RegistryError(405, "method_not_allowed", "use POST");
      }
      requireSessionKey(req);
      const [, id, verb] = action;

      if (verb === "approve") {
        // An approval has to name the address it is approving. Without it the
        // operator reads the queue, the entry re-registers somewhere else --
        // still `pending`, so nothing looks different -- and the approval that
        // lands ratifies a host nobody looked at. Revocation needs no such
        // check: withdrawing trust is safe whatever the entry now says.
        const body = await readJsonBody(req, maxBodyBytes);
        const expected = body?.host;
        if (typeof expected !== "string" || expected.trim() === "") {
          throw new RegistryError(
            400,
            "host_required",
            "approve must name the host it is approving",
          );
        }
        const entry = await store.get(id);
        if (!entry) {
          throw new RegistryError(404, "not_found", `no entry with id ${id}`);
        }
        if (entry.host !== normaliseHost(expected)) {
          throw new RegistryError(
            409,
            "entry_changed",
            `${entry.name} now answers on ${entry.host}, not ${expected}; ` +
              "review it again before approving",
          );
        }
      }

      const entry = await store.setState(
        id,
        verb === "approve" ? "active" : "revoked",
      );
      sendJson(res, 200, { entry });
      return;
    }

    throw new RegistryError(
      404,
      "not_found",
      `no registry route for ${pathname}`,
    );
  }

  return {
    store,
    enrolment,
    async handle(req, res) {
      try {
        await route(req, res);
      } catch (error) {
        if (res.headersSent) {
          res.destroy();
          return;
        }
        sendError(res, error);
      }
    },
  };
}
