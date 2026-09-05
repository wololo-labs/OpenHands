/**
 * The `/api/registry/*` REST surface, served in-process by the ingress.
 *
 *   GET    /api/registry            list entries          (session-key auth)
 *   POST   /api/registry/register   signed enrolment      (signature auth)
 *   POST   /api/registry/:id/approve  { host }            (session-key auth)
 *   POST   /api/registry/:id/revoke                       (session-key auth)
 *   DELETE /api/registry/:id          forget an entry     (session-key auth)
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
  const details =
    error instanceof RegistryError ? (error.details ?? null) : null;
  if (status >= 500) {
    console.error(`[registry] ${code}:`, error);
  }
  sendJson(res, status, { error: code, message, ...(details ? { details } : {}) });
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
  maxPendingEntries,
  maxNoncesPerFingerprint,
  maxEntries,
}) {
  if (!sessionKey) {
    throw new Error("createRegistry requires sessionKey");
  }

  const store = createStore(provider);
  const enrolment = createEnrolment({
    store,
    allowlist: preSeededFingerprints,
    ...(now ? { now } : {}),
    // Named rather than rest-spread: a spread also forwards `store` and
    // `allowlist`, so a caller could hand the enrolment a different store than
    // the routes read from and every registration would "succeed" into
    // nowhere.
    ...(maxPendingEntries !== undefined ? { maxPendingEntries } : {}),
    ...(maxNoncesPerFingerprint !== undefined
      ? { maxNoncesPerFingerprint }
      : {}),
    ...(maxEntries !== undefined ? { maxEntries } : {}),
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

      // An approval has to name the address it is approving. Without it the
      // operator reads the queue, the entry re-registers somewhere else --
      // still `pending`, so nothing looks different -- and the approval that
      // lands ratifies a host nobody looked at. Revocation needs no such
      // check: withdrawing trust is safe whatever the entry now says.
      let expectedHost = null;
      if (verb === "approve") {
        const body = await readJsonBody(req, maxBodyBytes);
        if (typeof body?.host !== "string" || body.host.trim() === "") {
          throw new RegistryError(
            400,
            "host_required",
            "approve must name the host it is approving",
          );
        }
        expectedHost = normaliseHost(body.host);
      }

      // Compared inside the store's lock, against the entry as it is at the
      // moment of writing. Reading it here and then writing was a race the
      // check could not win: a registration already in flight moved the host
      // between the two, and the approval ratified the address the operator
      // never saw.
      const entry = await store.mutate(id, (current) => {
        if (!current) {
          throw new RegistryError(404, "not_found", `no entry with id ${id}`);
        }
        if (expectedHost !== null && current.host !== expectedHost) {
          throw new RegistryError(
            409,
            "entry_changed",
            `${current.name} now answers on ${current.host}, not ` +
              `${expectedHost}; review it again before approving`,
            { host: current.host },
          );
        }
        return {
          ...current,
          state: verb === "approve" ? "active" : "revoked",
        };
      });
      sendJson(res, 200, { entry });
      return;
    }

    // Revocation withdraws trust but keeps the entry, which is right for an
    // operator decision and wrong for junk: a flood's leavings would sit in
    // the settings document forever, read in full on every registration.
    const entryPath = pathname.match(/^\/api\/registry\/([^/]+)$/);
    if (entryPath && method === "DELETE") {
      requireSessionKey(req);
      const [, id] = entryPath;
      // Decided inside the store's lock. Reading the entry, finding it not
      // revoked and then deleting it in a second call discards a revoke that
      // lands in between: the machine is deleted anyway and re-enrols clean,
      // straight back to `active` if its fingerprint is pre-seeded.
      await store.removeIf(id, (existing) => {
        if (!existing) {
          throw new RegistryError(404, "not_found", `no entry with id ${id}`);
        }
        // A revoked entry is the record of a decision, not junk. Forgetting
        // one un-revokes the machine, so tidying up after a flood would
        // quietly re-arm every host an operator had decommissioned, which is
        // the opposite of "revocation is final". What a flood leaves behind
        // is `pending`, and that deletes.
        if (existing.state === "revoked") {
          throw new RegistryError(
            409,
            "entry_revoked",
            `${existing.name} is revoked, and revoked entries are kept on ` +
              "purpose; approve it if you want it back",
          );
        }
      });
      sendJson(res, 200, { id });
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
