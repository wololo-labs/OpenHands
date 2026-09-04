import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { server as mswServer } from "#/mocks/node";
import { createProxyHandlers } from "../../scripts/proxy-utils.mjs";
import {
  applyCredential,
  createBackendProxy,
  createTailscaleIdentityResolver,
  isBackendProxyRequest,
  parseBackendProxyUrl,
} from "../../scripts/proxy-backend.mjs";
import { createFileSecretProvider } from "../../scripts/registry/secrets/file.mjs";

type Entry = Record<string, unknown> & { id: string; state: string };

async function listen(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function close(server: Server | undefined) {
  if (!server?.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

/** Stands in for a fleet agent server: echoes what it was asked and given. */
function createFakeBackend() {
  const seen: { url: string; sessionKey: string | undefined }[] = [];
  const server = createServer((req, res) => {
    seen.push({
      url: req.url ?? "",
      sessionKey: req.headers["x-session-api-key"] as string | undefined,
    });
    if (req.headers["x-session-api-key"] !== "fleet-key") {
      res.writeHead(401).end("unauthorized");
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ url: req.url }));
  });
  return { server, seen };
}

function createMemoryStore(entries: Entry[]) {
  return {
    async list() {
      return entries;
    },
    async get(id: string) {
      return entries.find((entry) => entry.id === id) ?? null;
    },
  };
}

describe("parseBackendProxyUrl", () => {
  it.each([
    ["/backend/abc/api/settings", { id: "abc", path: "/api/settings" }],
    ["/backend/abc", { id: "abc", path: "/" }],
    ["/backend/abc/", { id: "abc", path: "/" }],
    ["/backend/abc/api/x?y=1", { id: "abc", path: "/api/x?y=1" }],
    ["/backend/a%2Fb/x", { id: "a/b", path: "/x" }],
  ])("parses %s", (url, expected) => {
    expect(parseBackendProxyUrl(url)).toEqual(expected);
  });

  it.each(["/backend", "/backend/", "/backends/abc", "/api/registry", "/"])(
    "does not claim %s",
    (url) => {
      expect(parseBackendProxyUrl(url)).toBeNull();
      expect(isBackendProxyRequest({ url })).toBe(false);
    },
  );
});

describe("applyCredential", () => {
  it("replaces a credential the caller tried to smuggle through", () => {
    const headers: Record<string, string> = {
      "x-session-api-key": "attacker-key",
      authorization: "Bearer attacker",
      accept: "application/json",
    };

    applyCredential(headers, "fleet-key");

    expect(headers["x-session-api-key"]).toBe("fleet-key");
    expect(headers.authorization).toBeUndefined();
    expect(headers.accept).toBe("application/json");
  });

  it("strips an inbound credential even when it has none of its own", () => {
    const headers: Record<string, string> = { "x-session-api-key": "attacker" };

    applyCredential(headers, null);

    expect(headers["x-session-api-key"]).toBeUndefined();
  });
});

describe("backend proxy", () => {
  let backend: ReturnType<typeof createFakeBackend>;
  let backendUrl: string;
  let ingress: Server | undefined;
  let base: string;
  let secretsRoot: string;
  let proxyHandlers: ReturnType<typeof createProxyHandlers>;

  beforeAll(async () => {
    // This suite proxies between two real sockets. MSW's request interceptor
    // sits in front of the proxy's own outbound calls and never lets them
    // finish, so it is stopped for the file rather than bypassed per-origin.
    mswServer.close();
    secretsRoot = await mkdtemp(path.join(tmpdir(), "proxy-secrets-"));
    await createFileSecretProvider({ root: secretsRoot }).put(
      "openhands/hetzner/session-key",
      "fleet-key",
    );
  });

  afterAll(async () => {
    await rm(secretsRoot, { recursive: true, force: true });
    mswServer.listen({ onUnhandledRequest: "bypass" });
  });

  async function mount(
    entries: Entry[],
    overrides: Record<string, unknown> = {},
  ) {
    proxyHandlers = createProxyHandlers({ label: "test" });
    const backendProxy = createBackendProxy({
      store: createMemoryStore(entries),
      secrets: createFileSecretProvider({ root: secretsRoot }),
      proxy: proxyHandlers,
      ...overrides,
    });
    ingress = createServer((req, res) => {
      void backendProxy.handle(req, res);
    });
    base = await listen(ingress);
    return backendProxy;
  }

  function activeEntry(overrides: Partial<Entry> = {}): Entry {
    return {
      id: "abc123",
      name: "hetzner",
      host: backendUrl,
      state: "active",
      credRef: "openhands/hetzner/session-key",
      ...overrides,
    } as Entry;
  }

  beforeEach(async () => {
    ingress = undefined;
    backend = createFakeBackend();
    backendUrl = await listen(backend.server);
  });

  afterEach(async () => {
    await close(ingress);
    await close(backend.server);
  });

  it("reaches the backend with a credential the caller never had", async () => {
    await mount([activeEntry()]);

    const response = await fetch(`${base}/backend/abc123/api/settings`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ url: "/api/settings" });
    expect(backend.seen[0]).toEqual({
      url: "/api/settings",
      sessionKey: "fleet-key",
    });
  });

  it("carries the query string through", async () => {
    await mount([activeEntry()]);

    await fetch(`${base}/backend/abc123/api/conversations?limit=5`);

    expect(backend.seen[0].url).toBe("/api/conversations?limit=5");
  });

  it("returns 403 for a revoked entry and never contacts the backend", async () => {
    await mount([activeEntry({ state: "revoked" })]);

    const response = await fetch(`${base}/backend/abc123/api/settings`);

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "not_active" });
    expect(backend.seen).toHaveLength(0);
  });

  it("returns 403 for an entry still pending approval", async () => {
    await mount([activeEntry({ state: "pending" })]);

    expect((await fetch(`${base}/backend/abc123/api/settings`)).status).toBe(
      403,
    );
  });

  it("returns 404 for an id the registry does not know", async () => {
    await mount([activeEntry()]);

    const response = await fetch(`${base}/backend/nope/api/settings`);

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: "not_found" });
  });

  it("degrades to a clear error when the secret cannot be resolved", async () => {
    await mount([activeEntry({ credRef: "openhands/missing/session-key" })]);

    const response = await fetch(`${base}/backend/abc123/api/settings`);

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      error: "credential_unavailable",
    });
    // Never a silent fallback to proxying without a credential.
    expect(backend.seen).toHaveLength(0);
  });

  it("says so when an entry needs a credential and no provider is configured", async () => {
    await mount([activeEntry()], { secrets: null });

    const response = await fetch(`${base}/backend/abc123/api/settings`);

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      error: "no_secret_provider",
    });
  });

  it("proxies an entry with no credential reference without inventing one", async () => {
    await mount([activeEntry({ credRef: null })]);

    await fetch(`${base}/backend/abc123/api/settings`, {
      headers: { "X-Session-API-Key": "smuggled" },
    });

    expect(backend.seen[0].sessionKey).toBeUndefined();
  });

  it("resolves a credential once and reuses it", async () => {
    const secrets = createFileSecretProvider({ root: secretsRoot });
    const get = vi.spyOn(secrets, "get");
    await mount([activeEntry()], { secrets });

    await fetch(`${base}/backend/abc123/api/settings`);
    await fetch(`${base}/backend/abc123/api/settings`);

    expect(get).toHaveBeenCalledTimes(1);
  });

  it("applies a policy against the caller's tailnet identity", async () => {
    const authorize = vi.fn(() => false);
    await mount([activeEntry()], {
      authorize,
      resolveIdentity: async () => ({ user: "someone@example.com" }),
    });

    const response = await fetch(`${base}/backend/abc123/api/settings`);

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "forbidden" });
    expect(authorize).toHaveBeenCalledWith(
      expect.objectContaining({
        identity: { user: "someone@example.com" },
      }),
    );
  });

  it("does not resolve an identity when no policy is configured", async () => {
    const resolveIdentity = vi.fn();
    await mount([activeEntry()], { resolveIdentity });

    await fetch(`${base}/backend/abc123/api/settings`);

    expect(resolveIdentity).not.toHaveBeenCalled();
  });
});

describe("createTailscaleIdentityResolver", () => {
  const req = { socket: { remoteAddress: "::ffff:100.64.0.2" } };

  it("reports the machine and user behind a tailnet address", async () => {
    const run = vi.fn(async () => ({
      stdout: JSON.stringify({
        Node: { Name: "hetzner.example.ts.net." },
        UserProfile: { LoginName: "someone@example.com" },
      }),
      stderr: "",
    }));

    const identity = await createTailscaleIdentityResolver({ run })(req);

    // The IPv6-mapped form Node reports is normalised back to the IPv4 address
    // tailscale knows the peer by.
    expect(run).toHaveBeenCalledWith(
      "tailscale",
      ["whois", "--json", "100.64.0.2"],
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
    expect(identity).toEqual({
      address: "100.64.0.2",
      machine: "hetzner.example.ts.net.",
      user: "someone@example.com",
    });
  });

  it("reports unknown rather than guessing when tailscale is absent", async () => {
    const run = vi.fn(async () => {
      throw Object.assign(new Error("spawn"), { code: "ENOENT" });
    });

    expect(await createTailscaleIdentityResolver({ run })(req)).toBeNull();
  });

  it("caches a lookup instead of spawning per request", async () => {
    const run = vi.fn(async () => ({ stdout: "{}", stderr: "" }));
    const resolve = createTailscaleIdentityResolver({ run });

    await resolve(req);
    await resolve(req);

    expect(run).toHaveBeenCalledTimes(1);
  });

  it("returns null for a request with no source address", async () => {
    const run = vi.fn();
    const resolve = createTailscaleIdentityResolver({ run });

    expect(await resolve({ socket: {} })).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });
});
