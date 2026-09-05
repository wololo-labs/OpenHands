import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { http, passthrough } from "msw";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { server as mswServer } from "#/mocks/node";
import { canonicalPayload } from "../../scripts/registry/enrolment.mjs";
import {
  createRegistry,
  isRegistryRequest,
} from "../../scripts/registry/routes.mjs";

const SESSION_KEY = "test-session-key";
const NOW_MS = Date.parse("2026-09-04T10:00:00.000Z");

type JsonResponse = { status: number; body: any };

async function listen(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // The suite-wide MSW handlers match `*/api/settings` and `*/api/registry` on
  // any origin, which would answer for these real sockets too. Let this origin
  // through so the test talks to the server it just started.
  mswServer.use(http.all(`${origin}/*`, () => passthrough()));
  return origin;
}

async function close(server: Server | undefined) {
  if (!server?.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function readBody(req: import("node:http").IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Stand-in for the agent server's settings API: authenticates the session
 * key, deep-merges `misc_settings_diff`, and keeps the result in memory.
 */
function createFakeAgentServer() {
  const state: { misc_settings: Record<string, unknown> } = {
    misc_settings: { app_preferences: { language: "en" } },
  };

  const server = createServer((req, res) => {
    void (async () => {
      if (req.headers["x-session-api-key"] !== SESSION_KEY) {
        res.writeHead(401).end();
        return;
      }
      if (req.url !== "/api/settings") {
        res.writeHead(404).end();
        return;
      }
      if (req.method === "PATCH") {
        const diff = JSON.parse(await readBody(req)).misc_settings_diff ?? {};
        state.misc_settings = { ...state.misc_settings, ...diff };
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(state));
    })();
  });

  return { server, state };
}

function sshPublicKeyLine(publicKey: KeyObject) {
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(12);
  const type = Buffer.from("ssh-ed25519", "utf8");
  const blob = Buffer.concat([
    Buffer.from([0, 0, 0, type.length]),
    type,
    Buffer.from([0, 0, 0, raw.length]),
    raw,
  ]);
  return `ssh-ed25519 ${blob.toString("base64")} test@fixture`;
}

function makeHostKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { pubkey: sshPublicKeyLine(publicKey), privateKey };
}

function registrationBody(
  pubkey: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    name: "hetzner",
    host: "https://claude-hetzner.example.ts.net:8443",
    pubkey,
    credRef: "openhands/hetzner/session-key",
    version: "1.44.0",
    nonce: `nonce-${Math.random()}`,
    ts: Math.floor(NOW_MS / 1000),
    ...overrides,
  };
}

async function json(
  url: string,
  init?: RequestInit & { body?: string },
): Promise<JsonResponse> {
  const response = await fetch(url, init);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

describe("isRegistryRequest", () => {
  it.each([
    ["/api/registry", true],
    ["/api/registry/register", true],
    ["/api/registry/abc/approve", true],
    ["/api/registry?refresh=1", true],
    ["/api/settings", false],
    ["/api/registryfoo", false],
    ["/", false],
  ])("%s -> %s", (url, expected) => {
    expect(isRegistryRequest({ url })).toBe(expected);
  });
});

describe("registry routes", () => {
  let agentServer: ReturnType<typeof createFakeAgentServer>;
  let agentServerUrl: string;
  let ingress: Server | undefined;
  let base: string;

  /** Mounts a registry the way scripts/ingress.mjs does. */
  async function mountRegistry(preSeededFingerprints: string[] = []) {
    const registry = createRegistry({
      agentServerUrl,
      sessionKey: SESSION_KEY,
      preSeededFingerprints,
      now: () => NOW_MS,
    });
    ingress = createServer((req, res) => {
      if (isRegistryRequest(req)) {
        registry.handle(req, res);
        return;
      }
      res.writeHead(404).end();
    });
    base = await listen(ingress);
    return registry;
  }

  beforeEach(async () => {
    ingress = undefined;
    agentServer = createFakeAgentServer();
    agentServerUrl = await listen(agentServer.server);
  });

  afterEach(async () => {
    await close(ingress);
    await close(agentServer.server);
  });

  it("refuses to start without a session key", () => {
    expect(() =>
      createRegistry({ agentServerUrl, sessionKey: "" }),
    ).toThrowError(/sessionKey/);
  });

  it("returns 401 on GET /api/registry without a session key", async () => {
    await mountRegistry();

    const response = await json(`${base}/api/registry`);

    expect(response.status).toBe(401);
    expect(response.body.error).toBe("unauthorized");
  });

  it("returns 401 on GET /api/registry with the wrong session key", async () => {
    await mountRegistry();

    const response = await json(`${base}/api/registry`, {
      headers: { "X-Session-API-Key": "not-the-key" },
    });

    expect(response.status).toBe(401);
  });

  it("registers an unknown key as pending without any session key", async () => {
    await mountRegistry();
    const { pubkey, privateKey } = makeHostKey();
    const body = registrationBody(pubkey);

    const response = await json(`${base}/api/registry/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Registry-Signature": sign(
          null,
          Buffer.from(canonicalPayload(body), "utf8"),
          privateKey,
        ).toString("base64"),
      },
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(201);
    expect(response.body.state).toBe("pending");
    expect(response.body.id).toMatch(/^[0-9a-f]{32}$/);
  });

  it("rejects a registration whose signature does not verify", async () => {
    await mountRegistry();
    const { pubkey } = makeHostKey();
    const other = makeHostKey();
    const body = registrationBody(pubkey);

    const response = await json(`${base}/api/registry/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Registry-Signature": sign(
          null,
          Buffer.from(canonicalPayload(body), "utf8"),
          other.privateKey,
        ).toString("base64"),
      },
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(401);
    expect(response.body.error).toBe("invalid_signature");
    expect(agentServer.state.misc_settings.fleet_backends).toBeUndefined();
  });

  it("writes entries through to misc_settings so they survive a restart", async () => {
    const first = await mountRegistry();
    const { pubkey, privateKey } = makeHostKey();
    const body = registrationBody(pubkey);
    const { entry } = await first.enrolment.register(
      body,
      sign(
        null,
        Buffer.from(canonicalPayload(body), "utf8"),
        privateKey,
      ).toString("base64"),
    );

    expect(agentServer.state.misc_settings.fleet_backends).toEqual({
      entries: [entry],
    });

    // A second registry over the same agent server is a service restart.
    await close(ingress);
    const restarted = await mountRegistry();
    expect(await restarted.store.list()).toEqual([entry]);
  });

  it("approves and revokes an entry, and lists it with a session key", async () => {
    const registry = await mountRegistry();
    const { pubkey, privateKey } = makeHostKey();
    const body = registrationBody(pubkey);
    const { entry } = await registry.enrolment.register(
      body,
      sign(
        null,
        Buffer.from(canonicalPayload(body), "utf8"),
        privateKey,
      ).toString("base64"),
    );
    const auth = { "X-Session-API-Key": SESSION_KEY };

    const approved = await json(`${base}/api/registry/${entry.id}/approve`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ host: entry.host }),
    });
    expect(approved.status).toBe(200);
    expect(approved.body.entry.state).toBe("active");

    const listed = await json(`${base}/api/registry`, { headers: auth });
    expect(listed.status).toBe(200);
    expect(listed.body.entries).toEqual([{ ...entry, state: "active" }]);

    const revoked = await json(`${base}/api/registry/${entry.id}/revoke`, {
      method: "POST",
      headers: auth,
    });
    expect(revoked.body.entry.state).toBe("revoked");
  });

  it("removes an entry from the store", async () => {
    const registry = await mountRegistry();
    const { pubkey, privateKey } = makeHostKey();
    const body = registrationBody(pubkey);
    const { entry } = await registry.enrolment.register(
      body,
      sign(
        null,
        Buffer.from(canonicalPayload(body), "utf8"),
        privateKey,
      ).toString("base64"),
    );

    await registry.store.remove(entry.id);

    expect(await registry.store.list()).toEqual([]);
    expect(agentServer.state.misc_settings.fleet_backends).toEqual({
      entries: [],
    });
  });

  it("returns 401 rather than 404 when approving without a session key", async () => {
    await mountRegistry();

    const response = await json(`${base}/api/registry/unknown-id/approve`, {
      method: "POST",
    });

    expect(response.status).toBe(401);
  });

  it("returns 404 when approving an id that does not exist", async () => {
    await mountRegistry();

    const response = await json(`${base}/api/registry/unknown-id/approve`, {
      method: "POST",
      headers: {
        "X-Session-API-Key": SESSION_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ host: "https://a.example" }),
    });

    expect(response.status).toBe(404);
    expect(response.body.error).toBe("not_found");
  });

  /**
   * An approval is of a machine at an address. Without naming that address the
   * operator reads the queue, the entry re-registers somewhere else -- still
   * `pending`, so the row looks unchanged -- and the approval that lands
   * ratifies a host nobody reviewed.
   */
  it("refuses an approval that does not name the host", async () => {
    const registry = await mountRegistry();
    const { pubkey, privateKey } = makeHostKey();
    const body = registrationBody(pubkey);
    const { entry } = await registry.enrolment.register(
      body,
      sign(
        null,
        Buffer.from(canonicalPayload(body), "utf8"),
        privateKey,
      ).toString("base64"),
    );

    const response = await json(`${base}/api/registry/${entry.id}/approve`, {
      method: "POST",
      headers: {
        "X-Session-API-Key": SESSION_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("host_required");
  });

  it("refuses an approval for a host the entry has since left", async () => {
    const registry = await mountRegistry();
    const { pubkey, privateKey } = makeHostKey();
    const body = registrationBody(pubkey);
    const { entry } = await registry.enrolment.register(
      body,
      sign(
        null,
        Buffer.from(canonicalPayload(body), "utf8"),
        privateKey,
      ).toString("base64"),
    );

    // The entry moves between the operator reading it and clicking approve.
    const moved = registrationBody(pubkey, {
      host: "http://169.254.169.254",
      nonce: "moved",
    });
    await registry.enrolment.register(
      moved,
      sign(
        null,
        Buffer.from(canonicalPayload(moved), "utf8"),
        privateKey,
      ).toString("base64"),
    );

    const response = await json(`${base}/api/registry/${entry.id}/approve`, {
      method: "POST",
      headers: {
        "X-Session-API-Key": SESSION_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ host: entry.host }),
    });

    expect(response.status).toBe(409);
    expect(response.body.error).toBe("entry_changed");
    expect(await registry.store.get(entry.id)).toMatchObject({
      state: "pending",
    });
  });

  it("accepts an approval that names the host the entry moved to", async () => {
    const registry = await mountRegistry();
    const { pubkey, privateKey } = makeHostKey();
    const body = registrationBody(pubkey);
    const { entry } = await registry.enrolment.register(
      body,
      sign(
        null,
        Buffer.from(canonicalPayload(body), "utf8"),
        privateKey,
      ).toString("base64"),
    );

    const response = await json(`${base}/api/registry/${entry.id}/approve`, {
      method: "POST",
      headers: {
        "X-Session-API-Key": SESSION_KEY,
        "Content-Type": "application/json",
      },
      // A trailing slash is the same address, not a different one.
      body: JSON.stringify({ host: `${entry.host}/` }),
    });

    expect(response.status).toBe(200);
    expect(response.body.entry.state).toBe("active");
  });

  it("returns 405 for the wrong method and 404 for an unknown route", async () => {
    await mountRegistry();
    const auth = { "X-Session-API-Key": SESSION_KEY };

    expect(
      (await json(`${base}/api/registry`, { method: "POST", headers: auth }))
        .status,
    ).toBe(405);
    expect(
      (await json(`${base}/api/registry/register`, { headers: auth })).status,
    ).toBe(405);
    expect(
      (await json(`${base}/api/registry/nope`, { headers: auth })).status,
    ).toBe(404);
  });

  it("rejects a body larger than the limit", async () => {
    const registry = createRegistry({
      agentServerUrl,
      sessionKey: SESSION_KEY,
      maxBodyBytes: 64,
    });
    ingress = createServer((req, res) => registry.handle(req, res));
    base = await listen(ingress);

    const response = await json(`${base}/api/registry/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ padding: "x".repeat(512) }),
    });

    expect(response.status).toBe(413);
  });

  it("rejects a body that is not JSON", async () => {
    await mountRegistry();

    const response = await json(`${base}/api/registry/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("invalid_body");
  });

  it("reports a store it cannot reach instead of failing silently", async () => {
    await close(agentServer.server);
    await mountRegistry();

    const response = await json(`${base}/api/registry`, {
      headers: { "X-Session-API-Key": SESSION_KEY },
    });

    expect(response.status).toBe(502);
    expect(response.body.error).toBe("store_unavailable");
  });
});
