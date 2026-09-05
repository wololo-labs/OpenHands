import { describe, expect, it, vi } from "vitest";

import {
  resolveWebSocketAuth,
  sendWebSocketAuth,
} from "#/utils/websocket-auth";

/**
 * The two halves of a socket's credential have to move together. Sending the
 * frame to a fleet backend hands that machine this origin's key inside a
 * payload the proxy cannot rewrite; sending only the frame means the proxy
 * refuses the handshake and the socket never opens.
 */
describe("resolveWebSocketAuth", () => {
  const KEY = "the-origins-session-key";
  const fleetConversation = `${window.location.origin}/backend/abc123/api/conversations/x`;

  it("moves the key onto the handshake for a fleet backend", () => {
    const auth = resolveWebSocketAuth(
      "ws://canvas.example/backend/abc123/sockets/events",
      fleetConversation,
      KEY,
    );

    expect(auth.url).toContain(`session_api_key=${encodeURIComponent(KEY)}`);
    expect(auth.sendFrame).toBe(false);
  });

  it("appends to an existing query string rather than replacing it", () => {
    const auth = resolveWebSocketAuth(
      "ws://canvas.example/backend/abc123/sockets/events?resend_mode=all",
      fleetConversation,
      KEY,
    );

    expect(auth.url).toContain("resend_mode=all");
    expect(auth.url).toContain("session_api_key=");
  });

  it("leaves a non-fleet socket on the frame, untouched", () => {
    const auth = resolveWebSocketAuth(
      "ws://canvas.example/sockets/events",
      "http://canvas.example",
      KEY,
    );

    expect(auth.url).toBe("ws://canvas.example/sockets/events");
    expect(auth.sendFrame).toBe(true);
  });

  it("leaves a backend on another host on the frame", () => {
    // Its path looks like the proxy's, but that host is not this proxy: it
    // expects the frame, and its URL is not somewhere this key belongs.
    const auth = resolveWebSocketAuth(
      "ws://elsewhere.example/backend/abc123/sockets",
      "https://elsewhere.example/backend/abc123",
      KEY,
    );

    expect(auth.url).not.toContain("session_api_key");
    expect(auth.sendFrame).toBe(true);
  });

  it("adds nothing when there is no key to present", () => {
    const auth = resolveWebSocketAuth("ws://x/y", fleetConversation, null);

    expect(auth.url).toBe("ws://x/y");
    expect(auth.sendFrame).toBe(true);
  });
});

describe("sendWebSocketAuth", () => {
  it("sends the key as an auth frame", () => {
    const send = vi.fn();
    sendWebSocketAuth({ send }, "a-key");

    expect(JSON.parse(send.mock.calls[0][0] as string)).toEqual({
      type: "auth",
      session_api_key: "a-key",
    });
  });

  it("sends nothing without a key", () => {
    const send = vi.fn();
    sendWebSocketAuth({ send }, null);

    expect(send).not.toHaveBeenCalled();
  });
});
