/**
 * Append-only access log for the fleet backend proxy.
 *
 * Every `/backend/:id/*` request is one JSON line. The proxy is the single
 * point every hop to a fleet node passes through, so this file is the wire
 * record: which entry was reached, whether a credential was injected, and
 * which conversation the request belonged to. It exists so an operator can
 * answer "did that machine do this work" from something other than the
 * machine's own account of itself.
 *
 * THE CREDENTIAL TRAP. A browser cannot set a header on a WebSocket
 * handshake, so the SDK passes the session key as a query parameter instead
 * (see `SESSION_KEY_QUERY` in proxy-backend.mjs). The inbound URL of every
 * upgrade therefore carries a live fleet credential, and the naive
 * `log(req.url)` writes it to disk in cleartext. `redactUrl` strips every
 * credential-shaped parameter before anything is written, and it is the only
 * way a URL enters a line here.
 *
 * Failures are swallowed after one warning: an unwritable evidence file must
 * degrade the record, never the proxy.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

/**
 * Query parameter names that may carry a credential.
 *
 * A predicate rather than a list of exact names. The proxy today reads only
 * `session_api_key`, but this file's invariant is "no credential is ever
 * written", and an invariant that holds only while every caller spells one
 * parameter one way is not an invariant. A hand-rolled client, a future SDK,
 * or an added `token=` leaks silently and permanently into an append-only
 * file, so anything that looks like a secret goes.
 */
const CREDENTIAL_PARAM_RE = /key|token|secret|auth|password|session|cred/i;

/**
 * The inbound URL with every credential-bearing query parameter removed, and
 * with the fragment dropped: a fragment never reaches a server, so anything
 * in one is noise at best and a credential a client misplaced at worst.
 *
 * Against a base URL almost any path-like request target parses, so the
 * unchanged-input branch is close to unreachable in practice; it stays for
 * the few targets `new URL` still refuses, because a URL the parser rejects
 * is one the proxy rejected too and dropping the line would hide a request
 * that did reach it.
 */
export function redactUrl(rawUrl) {
  const raw = String(rawUrl ?? "");
  let url;
  try {
    url = new URL(raw, "http://localhost");
  } catch {
    return raw;
  }
  for (const name of [...url.searchParams.keys()]) {
    if (CREDENTIAL_PARAM_RE.test(name)) url.searchParams.delete(name);
  }
  // Always reconstructed, never returned raw: otherwise the same request is
  // logged in two different shapes depending on whether anything was
  // redacted, and `conversationIdFromPath` reads a different path in each.
  const query = url.searchParams.toString();
  return query ? `${url.pathname}?${query}` : url.pathname;
}

/**
 * The conversation a proxied path belongs to, or null.
 *
 * Two shapes reach the proxy: the HTTP API's `/api/conversations/<id>/...`
 * and the event socket's `/sockets/events/<id>`. Correlating a commit to a
 * proxy line needs the id from both, because the socket carries the work and
 * the HTTP route carries the polling that observes it.
 */
export function conversationIdFromPath(pathname) {
  const match = String(pathname ?? "").match(
    /\/(?:conversations|sockets\/events)\/([^/?#]+)/,
  );
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

/**
 * @param {{
 *   file: string,
 *   now?: () => Date,
 *   append?: (file: string, line: string) => void,
 *   warn?: (...args: unknown[]) => void,
 * }} options
 */
export function createAccessLog({
  file,
  now = () => new Date(),
  // 0600: the log names every fleet machine an operator can reach and when.
  // The mode only applies on creation, which is the case that matters here.
  append = (target, line) => appendFileSync(target, line, { mode: 0o600 }),
  warn = console.warn,
} = {}) {
  if (!file) throw new Error("createAccessLog requires a file");

  try {
    mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  } catch {
    // Reported on the first failed write instead; a missing directory is not
    // worth refusing to start the ingress over.
  }

  let warned = false;

  return {
    file,
    /**
     * One line per request that reached `/backend/:id/*`, proxied or refused.
     * A refusal is evidence too: "the node was never reached" is exactly the
     * claim an access log has to be able to settle.
     */
    record({
      url,
      method,
      kind = "http",
      entry = null,
      credentialInjected = false,
      outcome = "proxied",
      error = null,
    }) {
      const safeUrl = redactUrl(url);
      const line = {
        ts: now().toISOString(),
        kind,
        method: method ?? null,
        url: safeUrl,
        conversationId: conversationIdFromPath(safeUrl),
        entryId: entry?.id ?? null,
        entryName: entry?.name ?? null,
        entryFingerprint: entry?.fingerprint ?? null,
        entryHost: entry?.host ?? null,
        credential: credentialInjected ? "injected" : "none",
        outcome,
        error,
      };
      try {
        append(file, `${JSON.stringify(line)}\n`);
      } catch (writeError) {
        if (!warned) {
          warned = true;
          warn(`[backend-proxy] access log unwritable at ${file}:`, writeError);
        }
      }
    },
  };
}
