import { describe, expect, it } from "vitest";

import {
  conversationIdFromPath,
  createAccessLog,
  redactUrl,
} from "../../scripts/registry/access-log.mjs";

describe("redactUrl", () => {
  it("deletes the session key an upgrade carries in the query", () => {
    expect(
      redactUrl("/backend/abc/sockets/events/c1?session_api_key=secret&x=1"),
    ).toBe("/backend/abc/sockets/events/c1?x=1");
  });

  it("keeps the parameters that carry no credential", () => {
    expect(redactUrl("/backend/abc/api/settings?limit=5")).toBe(
      "/backend/abc/api/settings?limit=5",
    );
  });

  it("redacts by shape, not by one exact spelling", () => {
    // The invariant is "no credential is ever written". One exact parameter
    // name only holds it while every caller spells it that way.
    for (const name of [
      "SESSION_API_KEY",
      "token",
      "api_key",
      "authorization",
    ]) {
      expect(redactUrl(`/backend/abc/x?${name}=SECRET`)).toBe("/backend/abc/x");
    }
  });

  it("drops the fragment, which never reaches a server anyway", () => {
    expect(redactUrl("/backend/abc/x#session_api_key=SECRET")).toBe(
      "/backend/abc/x",
    );
  });

  it("logs one shape whether or not anything was redacted", () => {
    // Returning the raw string when nothing matched logged the same request
    // two different ways, and `conversationIdFromPath` then read a different
    // path in each.
    expect(
      redactUrl("/backend/abc/api/conversations/c1?a=b&session_api_key=x"),
    ).toBe("/backend/abc/api/conversations/c1?a=b");
    expect(redactUrl("/backend/abc/api/conversations/c1?a=b")).toBe(
      "/backend/abc/api/conversations/c1?a=b",
    );
  });

  it("normalises a request target the parser can still read", () => {
    expect(redactUrl("%")).toBe("/%");
  });

  it("returns a target the parser rejects unchanged, rather than dropping the line", () => {
    // A URL the parser refuses is one the proxy refused too, and losing the
    // line would hide a request that did reach it.
    expect(redactUrl("//%")).toBe("//%");
  });
});

describe("conversationIdFromPath", () => {
  it.each([
    ["/backend/abc/api/conversations/conv-77/events/search", "conv-77"],
    ["/backend/abc/sockets/events/conv-77?latest_event_id=-1", "conv-77"],
    ["/backend/abc/api/conversations", null],
    ["/backend/abc/api/settings", null],
  ])("%s -> %s", (pathname, expected) => {
    expect(conversationIdFromPath(pathname)).toBe(expected);
  });
});

describe("createAccessLog", () => {
  it("refuses to start without a file, rather than discarding the record", () => {
    // The guard is for the ingress, which passes a path resolved at runtime;
    // TypeScript already stops this call, so the cast is the point of the test.
    expect(() => createAccessLog({} as never)).toThrow(/requires a file/);
  });

  it("warns once when the file is unwritable, then stays quiet", () => {
    const warnings: unknown[][] = [];
    const log = createAccessLog({
      file: "/nonexistent-volume/evidence/proxy-access.jsonl",
      append: () => {
        throw new Error("read-only volume");
      },
      warn: (...args: unknown[]) => warnings.push(args),
    });

    log.record({ url: "/backend/abc/api/settings", method: "GET" });
    log.record({ url: "/backend/abc/api/settings", method: "GET" });

    expect(warnings).toHaveLength(1);
  });
});
