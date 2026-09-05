import { isFleetProxyUrl } from "#/api/backend-registry/registry-source";

const WEBSOCKET_AUTH_TYPE = "auth";
const WEBSOCKET_SESSION_KEY_FIELD = "session_api_key";

/**
 * Guards against the one inconsistent pair the two-URL signature can express:
 * a fleet `conversationUrl` alongside a `wsUrl` somewhere else, which would
 * put the key in a third party's URL. Both callers derive one from the other,
 * so this should never fire -- it exists so it cannot start firing.
 */
function isSameHost(wsUrl: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    return new URL(wsUrl).host === window.location.host;
  } catch {
    return false;
  }
}

export function sendWebSocketAuth(
  socket: Pick<WebSocket, "send">,
  sessionApiKey: string | null | undefined,
): void {
  if (!sessionApiKey) {
    return;
  }

  socket.send(
    JSON.stringify({
      type: WEBSOCKET_AUTH_TYPE,
      [WEBSOCKET_SESSION_KEY_FIELD]: sessionApiKey,
    }),
  );
}

/**
 * How a socket to `conversationUrl` should present its credential.
 *
 * Most sockets authenticate with an `auth` frame once the connection is open.
 * A socket reaching a backend through this origin's fleet proxy cannot: the
 * proxy has to read the credential on the handshake to decide whether to
 * connect at all, and no proxy can act on a frame sent after the fact.
 *
 * The two halves have to move together, which is why this returns both rather
 * than leaving each caller to remember. Sending the frame as well would put
 * this origin's key inside a payload the proxy cannot rewrite, delivering it
 * verbatim to the fleet machine; sending only the frame means the handshake is
 * refused and the socket never opens at all.
 *
 * Lives here rather than at each call site because the app opens sockets from
 * three places, and the first version of this fix reached only two of them.
 */
export function resolveWebSocketAuth(
  /** The socket URL about to be opened (`ws:`/`wss:`). */
  wsUrl: string,
  /**
   * The backend URL that socket belongs to (`http:`/`https:`). Separate from
   * `wsUrl` because the proxy test is an origin comparison against this page,
   * and a `ws:` origin never equals an `http:` one.
   */
  conversationUrl: string | null | undefined,
  sessionApiKey: string | null | undefined,
): { url: string; sendFrame: boolean } {
  if (
    !sessionApiKey ||
    !isFleetProxyUrl(conversationUrl) ||
    !isSameHost(wsUrl)
  ) {
    return { url: wsUrl, sendFrame: true };
  }

  const separator = wsUrl.includes("?") ? "&" : "?";
  const credential = `${WEBSOCKET_SESSION_KEY_FIELD}=${encodeURIComponent(sessionApiKey)}`;
  return { url: `${wsUrl}${separator}${credential}`, sendFrame: false };
}
