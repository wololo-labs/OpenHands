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
 * `log(req.url)` writes it to disk in cleartext. `redactUrl` deletes that
 * parameter before anything is written, and it is the only way a URL enters
 * a line here.
 *
 * Failures are swallowed after one warning: an unwritable evidence file must
 * degrade the record, never the proxy.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

/** Query parameters that may carry a credential, stripped before writing. */
const REDACTED_QUERY_PARAMS = Object.freeze(["session_api_key"]);

/**
 * The inbound URL with every credential-bearing query parameter removed.
 *
 * Returns the input unchanged when it will not parse, because a malformed URL
 * cannot be carrying a parsed credential and dropping the line entirely would
 * hide a request that did reach the proxy.
 */
export function redactUrl(rawUrl) {
  const raw = String(rawUrl ?? "");
  let url;
  try {
    url = new URL(raw, "http://localhost");
  } catch {
    return raw;
  }
  let redacted = false;
  for (const param of REDACTED_QUERY_PARAMS) {
    if (url.searchParams.has(param)) {
      url.searchParams.delete(param);
      redacted = true;
    }
  }
  if (!redacted) return raw;
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
  append = (target, line) => appendFileSync(target, line, "utf8"),
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
