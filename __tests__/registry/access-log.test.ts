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

  it("leaves a URL with nothing to redact byte-identical", () => {
    // The record is of what the caller asked for, so a URL that carries no
    // credential must not be normalised into a different string.
    expect(redactUrl("/backend/abc/api/settings?limit=5")).toBe(
      "/backend/abc/api/settings?limit=5",
    );
  });

  it("returns a malformed URL unchanged rather than dropping the line", () => {
    expect(redactUrl("%")).toBe("%");
    expect(redactUrl(undefined)).toBe("");
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
