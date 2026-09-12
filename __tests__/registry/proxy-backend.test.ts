import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
  applyCredentialToPath,
  callerCredential,
  createBackendProxy,
  createTailscaleIdentityResolver,
  isBackendProxyRequest,
  parseBackendProxyUrl,
} from "../../scripts/proxy-backend.mjs";
import { createAccessLog } from "../../scripts/registry/access-log.mjs";
import { createFileSecretProvider } from "../../scripts/registry/secrets/file.mjs";

type Entry = Record<string, unknown> & { id: string; state: string };

/**
 * The master's own session key. The proxy injects fleet credentials, so it
 * cannot be the one route on this origin that asks nothing of its caller;
 * every request below presents this the way the canvas does.
 */
const MASTER_KEY = "master-session-key";

/** `fetch` as the canvas makes it: authenticated to the master, and only that. */
function callerFetch(url: string, init: RequestInit = {}) {
  return fetch(url, {
    ...init,
    headers: { "X-Session-API-Key": MASTER_KEY, ...(init.headers ?? {}) },
  });
}

/** Sockets each test server has accepted, so teardown can drop upgraded ones. */
const openSockets = new WeakMap<Server, Set<{ destroy(): void }>>();

async function listen(server: Server) {
  const sockets = new Set<{ destroy(): void }>();
  openSockets.set(server, sockets);
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function close(server: Server | undefined) {
  if (!server?.listening) return;
  // An upgraded socket outlives its request, so `close()` on its own waits
  // forever for a connection the test deliberately left open.
  for (const socket of openSockets.get(server) ?? []) socket.destroy();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

/**
 * Opens a WebSocket handshake the way a browser does: no custom headers, only
 * what the URL carries. Resolves with the upstream's status line, or "101"
 * when the upgrade completed.
 */
function handshake(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, {
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
      },
    });
    req.on("upgrade", (res, socket) => {
      socket.destroy();
      resolve(String(res.statusCode ?? 101));
    });
    req.on("response", (res) => {
      res.resume();
      resolve(String(res.statusCode));
    });
    // A refused upgrade is a destroyed socket with no reply at all, which is
    // the only signal the proxy can give on this path.
    req.on("error", () => resolve("destroyed"));
    req.on("close", () => resolve("destroyed"));
    req.end();
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
  // Accept upgrades too, recording what actually arrived at the fleet node.
  server.on("upgrade", (req, socket) => {
    seen.push({
      url: req.url ?? "",
      sessionKey: req.headers["x-session-api-key"] as string | undefined,
    });
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
    );
  });
  return { server, seen };
}

function createMemoryStore(entries: Entry[]) {
  let revision = 0;
  return {
    getRevision() {
      return revision;
    },
    async list() {
      return entries;
    },
    async get(id: string) {
      return entries.find((entry) => entry.id === id) ?? null;
    },
    /** Mirrors the real store: a mutation bumps the revision readers watch. */
    async setState(id: string, state: string) {
      const entry = entries.find((candidate) => candidate.id === id);
      if (entry) entry.state = state;
      revision += 1;
      return entry ?? null;
    },
  };
}

describe("parseBackendProxyUrl", () => {
  it.each([
    ["/backend/abc/api/settings", { id: "abc", pathname: "/api/settings" }],
    ["/backend/abc", { id: "abc", pathname: "/" }],
    ["/backend/abc/", { id: "abc", pathname: "/" }],
    ["/backend/abc/api/x?y=1", { id: "abc", pathname: "/api/x" }],
    ["/backend/a%2Fb/x", { id: "a/b", pathname: "/x" }],
  ])("parses %s", (url, expected) => {
    expect(parseBackendProxyUrl(url)).toMatchObject(expected);
  });

  /**
   * This runs inside the server's `request` and `upgrade` listeners, where a
   * throw is caught by nothing and takes the process down. One unauthenticated
   * `GET /backend/%` used to be enough to stop the ingress.
   */
  it.each(["/backend/%", "/backend/%zz", "/backend/%/api", "/backend/a%2"])(
    "returns null rather than throwing on %s",
    (url) => {
      expect(() => parseBackendProxyUrl(url)).not.toThrow();
      expect(parseBackendProxyUrl(url)).toBeNull();
    },
  );

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

  /**
   * The proxy lives on the canvas's own origin, so the browser attaches that
   * origin's cookies to every proxied request without being asked. Forwarding
   * them hands a live canvas credential to whichever machine the entry names.
   */
  it("strips every channel a caller credential can arrive in", () => {
    const headers: Record<string, string> = {
      "x-session-api-key": "attacker-key",
      authorization: "Bearer attacker",
      "proxy-authorization": "Basic attacker",
      cookie: "session=canvas-session-cookie",
      cookie2: "legacy=value",
      "x-api-key": "attacker",
      accept: "application/json",
    };

    applyCredential(headers, "fleet-key");

    expect(headers["x-session-api-key"]).toBe("fleet-key");
    expect(headers.authorization).toBeUndefined();
    expect(headers["proxy-authorization"]).toBeUndefined();
    expect(headers.cookie).toBeUndefined();
    expect(headers.cookie2).toBeUndefined();
    expect(headers["x-api-key"]).toBeUndefined();
    expect(headers.accept).toBe("application/json");
  });
});

describe("applyCredentialToPath", () => {
  it("removes the caller's key from the query string", () => {
    const search = new URLSearchParams("limit=5&session_api_key=callers-key");

    expect(applyCredentialToPath("/api/x", search, null)).toBe(
      "/api/x?limit=5",
    );
  });

  it("keeps the credential out of an ordinary request's URL", () => {
    const search = new URLSearchParams("session_api_key=callers-key");

    // The header carries it instead, so it stays out of the node's access log.
    expect(applyCredentialToPath("/api/x", search, "fleet-key")).toBe("/api/x");
  });

  it("puts it back for an upgrade, where a browser cannot set a header", () => {
    const search = new URLSearchParams("session_api_key=callers-key");

    expect(
      applyCredentialToPath("/sockets", search, "fleet-key", { inQuery: true }),
    ).toBe("/sockets?session_api_key=fleet-key");
  });
});

describe("callerCredential", () => {
  it("prefers the header and falls back to the query parameter", () => {
    const headers = { "x-session-api-key": "from-header" };

    expect(callerCredential({ headers }, new URLSearchParams())).toBe(
      "from-header",
    );
    expect(
      callerCredential(
        { headers: {} },
        new URLSearchParams("session_api_key=from-query"),
      ),
    ).toBe("from-query");
    expect(callerCredential({ headers: {} }, new URLSearchParams())).toBe("");
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
    const store = createMemoryStore(entries);
    const backendProxy = createBackendProxy({
      store,
      secrets: createFileSecretProvider({ root: secretsRoot }),
      proxy: proxyHandlers,
      sessionKey: MASTER_KEY,
      ...overrides,
    });
    ingress = createServer((req, res) => {
      void backendProxy.handle(req, res);
    });
    ingress.on("upgrade", (req, socket, head) => {
      void backendProxy.handleUpgrade(req, socket, head);
    });
    base = await listen(ingress);
    return { backendProxy, store };
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

    const response = await callerFetch(`${base}/backend/abc123/api/settings`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ url: "/api/settings" });
    expect(backend.seen[0]).toEqual({
      url: "/api/settings",
      sessionKey: "fleet-key",
    });
  });

  it("carries the query string through", async () => {
    await mount([activeEntry()]);

    await callerFetch(`${base}/backend/abc123/api/conversations?limit=5`);

    expect(backend.seen[0].url).toBe("/api/conversations?limit=5");
  });

  it("returns 403 for a revoked entry and never contacts the backend", async () => {
    await mount([activeEntry({ state: "revoked" })]);

    const response = await callerFetch(`${base}/backend/abc123/api/settings`);

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "not_active" });
    expect(backend.seen).toHaveLength(0);
  });

  it("returns 403 for an entry still pending approval", async () => {
    await mount([activeEntry({ state: "pending" })]);

    expect(
      (await callerFetch(`${base}/backend/abc123/api/settings`)).status,
    ).toBe(403);
  });

  it("returns 404 for an id the registry does not know", async () => {
    await mount([activeEntry()]);

    const response = await callerFetch(`${base}/backend/nope/api/settings`);

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: "not_found" });
  });

  it("degrades to a clear error when the secret cannot be resolved", async () => {
    await mount([activeEntry({ credRef: "openhands/missing/session-key" })]);

    const response = await callerFetch(`${base}/backend/abc123/api/settings`);

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      error: "credential_unavailable",
    });
    // Never a silent fallback to proxying without a credential.
    expect(backend.seen).toHaveLength(0);
  });

  it("says so when an entry needs a credential and no provider is configured", async () => {
    await mount([activeEntry()], { secrets: null });

    const response = await callerFetch(`${base}/backend/abc123/api/settings`);

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      error: "no_secret_provider",
    });
  });

  it("refuses an entry with no credential reference", async () => {
    // @spec FR-020 - nothing is proxied uncredentialed by default. Discovered
    // entries are this shape, so without the refusal the proxy becomes an
    // unauthenticated relay to whatever a source happened to list.
    await mount([activeEntry({ credRef: null })]);

    const response = await callerFetch(`${base}/backend/abc123/api/settings`);

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "no_credential" });
    expect(backend.seen).toHaveLength(0);
  });

  it("proxies an uncredentialed entry only when the deployment opted in", async () => {
    await mount([activeEntry({ credRef: null })], {
      allowUncredentialed: true,
    });

    await callerFetch(`${base}/backend/abc123/api/settings`);

    // Opting in permits an absent credential; it never permits the caller's
    // own to be forwarded in its place.
    expect(backend.seen[0].sessionKey).toBeUndefined();
  });

  describe("caller authentication", () => {
    /**
     * The proxy satisfies the fleet node's authentication on the caller's
     * behalf, so without a check of its own it would be strictly weaker than
     * the `/api/*` route it sits beside: anyone who could reach the ingress
     * would reach every active machine in the fleet.
     */
    it("refuses a caller that presents no session key", async () => {
      await mount([activeEntry()]);

      const response = await fetch(`${base}/backend/abc123/api/settings`);

      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ error: "unauthorized" });
      expect(backend.seen).toHaveLength(0);
    });

    it("refuses a caller that presents the wrong session key", async () => {
      await mount([activeEntry()]);

      const response = await fetch(`${base}/backend/abc123/api/settings`, {
        headers: { "X-Session-API-Key": "not-the-master-key" },
      });

      expect(response.status).toBe(401);
      expect(backend.seen).toHaveLength(0);
    });

    it("refuses the fleet node's own key: it authorises the node, not a caller", async () => {
      await mount([activeEntry()]);

      const response = await fetch(`${base}/backend/abc123/api/settings`, {
        headers: { "X-Session-API-Key": "fleet-key" },
      });

      expect(response.status).toBe(401);
    });

    it("does not reveal whether an entry exists to an unauthenticated caller", async () => {
      await mount([activeEntry()]);

      const known = await fetch(`${base}/backend/abc123/api/settings`);
      const unknown = await fetch(`${base}/backend/nope/api/settings`);

      expect(known.status).toBe(401);
      expect(unknown.status).toBe(401);
    });

    it("accepts the key from the query string, as a WebSocket must send it", async () => {
      await mount([activeEntry()]);

      const response = await fetch(
        `${base}/backend/abc123/api/settings?session_api_key=${MASTER_KEY}`,
      );

      expect(response.status).toBe(200);
      // Swapped for the node's, never forwarded, and never left in the URL of
      // an ordinary request where it would land in the node's access log.
      expect(backend.seen[0].sessionKey).toBe("fleet-key");
      expect(backend.seen[0].url).not.toContain("session_api_key");
    });
  });

  /**
   * The upgrade path had no test at all, which is how it shipped requiring a
   * credential a browser cannot send. A browser sets no headers on a
   * handshake, so everything here goes through the URL -- exactly what the
   * canvas does for a fleet backend.
   */
  describe("websocket upgrades", () => {
    it("connects when the handshake URL carries the master's key", async () => {
      await mount([activeEntry()]);

      const status = await handshake(
        `${base}/backend/abc123/sockets/events?session_api_key=${MASTER_KEY}`,
      );

      expect(status).toBe("101");
      // The node is reached with *its* credential, in the channel it reads.
      expect(backend.seen[0].url).toContain("session_api_key=fleet-key");
      expect(backend.seen[0].url).not.toContain(MASTER_KEY);
      expect(backend.seen[0].url).toContain("/sockets/events");
    });

    it("refuses a handshake that carries no credential", async () => {
      await mount([activeEntry()]);

      expect(await handshake(`${base}/backend/abc123/sockets/events`)).toBe(
        "destroyed",
      );
      expect(backend.seen).toHaveLength(0);
    });

    it("refuses a handshake carrying the fleet node's own key", async () => {
      await mount([activeEntry()]);

      const status = await handshake(
        `${base}/backend/abc123/sockets/events?session_api_key=fleet-key`,
      );

      expect(status).toBe("destroyed");
      expect(backend.seen).toHaveLength(0);
    });

    it("refuses an upgrade to an entry that is not active", async () => {
      await mount([activeEntry({ state: "pending" })]);

      expect(
        await handshake(
          `${base}/backend/abc123/sockets/events?session_api_key=${MASTER_KEY}`,
        ),
      ).toBe("destroyed");
    });

    it("survives a malformed entry id on the upgrade path", async () => {
      await mount([activeEntry()]);

      await handshake(`${base}/backend/%/sockets`);

      // Still serving: the parse must not throw inside the upgrade listener.
      expect(
        (await callerFetch(`${base}/backend/abc123/api/settings`)).status,
      ).toBe(200);
    });
  });

  /**
   * The entry list is cached to keep a full settings fetch off the hot path,
   * but revocation is a security control: it has to bite on the next request,
   * not at the end of a cache window.
   */
  it("sees a revocation immediately despite caching the entry list", async () => {
    const { store } = await mount([activeEntry()]);

    expect((await callerFetch(`${base}/backend/abc123/api/x`)).status).toBe(
      200,
    );

    await store.setState("abc123", "revoked");

    const response = await callerFetch(`${base}/backend/abc123/api/x`);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "not_active" });
  });

  it("resolves a credential once and reuses it", async () => {
    const secrets = createFileSecretProvider({ root: secretsRoot });
    const get = vi.spyOn(secrets, "get");
    await mount([activeEntry()], { secrets });

    await callerFetch(`${base}/backend/abc123/api/settings`);
    await callerFetch(`${base}/backend/abc123/api/settings`);

    expect(get).toHaveBeenCalledTimes(1);
  });

  it("applies a policy against the caller's tailnet identity", async () => {
    const authorize = vi.fn(() => false);
    await mount([activeEntry()], {
      authorize,
      resolveIdentity: async () => ({ user: "someone@example.com" }),
    });

    const response = await callerFetch(`${base}/backend/abc123/api/settings`);

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

    await callerFetch(`${base}/backend/abc123/api/settings`);

    expect(resolveIdentity).not.toHaveBeenCalled();
  });

  describe("access log", () => {
    let logRoot: string;
    let logFile: string;

    beforeEach(async () => {
      logRoot = await mkdtemp(path.join(tmpdir(), "proxy-access-log-"));
      logFile = path.join(logRoot, "evidence", "proxy-access.jsonl");
    });

    afterEach(async () => {
      await rm(logRoot, { recursive: true, force: true });
    });

    /** The log as the chain verifier will read it: one JSON object per line. */
    async function lines() {
      const raw = await readFile(logFile, "utf8").catch(() => "");
      return raw
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line));
    }

    function mountLogged(entries: Entry[]) {
      return mount(entries, { accessLog: createAccessLog({ file: logFile }) });
    }

    it("writes one line per proxied request, naming the entry it reached", async () => {
      await mountLogged([activeEntry({ fingerprint: "SHA256:node-fpr" })]);

      await callerFetch(
        `${base}/backend/abc123/api/conversations/conv-77/events/search`,
      );

      expect(await lines()).toEqual([
        expect.objectContaining({
          kind: "http",
          method: "GET",
          url: "/backend/abc123/api/conversations/conv-77/events/search",
          conversationId: "conv-77",
          entryId: "abc123",
          entryName: "hetzner",
          entryFingerprint: "SHA256:node-fpr",
          credential: "injected",
          outcome: "proxied",
        }),
      ]);
    });

    it("never writes the caller's session key, which an upgrade carries in the URL", async () => {
      await mountLogged([activeEntry({ fingerprint: "SHA256:node-fpr" })]);

      await handshake(
        `${base}/backend/abc123/sockets/events/conv-77?session_api_key=${MASTER_KEY}&latest_event_id=-1`,
      );

      const raw = await readFile(logFile, "utf8");
      expect(raw).not.toContain(MASTER_KEY);
      expect(raw).not.toContain("fleet-key");
      expect(await lines()).toEqual([
        expect.objectContaining({
          kind: "upgrade",
          url: "/backend/abc123/sockets/events/conv-77?latest_event_id=-1",
          conversationId: "conv-77",
          entryFingerprint: "SHA256:node-fpr",
          credential: "injected",
          outcome: "proxied",
        }),
      ]);
    });

    it("records a refusal, because 'the node was never reached' is a claim too", async () => {
      await mountLogged([activeEntry({ state: "revoked" })]);

      await callerFetch(`${base}/backend/abc123/api/settings`);

      expect(await lines()).toEqual([
        expect.objectContaining({
          outcome: "refused:403",
          error: "not_active",
          entryId: null,
          credential: "none",
        }),
      ]);
    });

    it("keeps proxying when the log file cannot be written", async () => {
      await mount([activeEntry()], {
        accessLog: createAccessLog({
          file: logFile,
          append: () => {
            throw new Error("read-only volume");
          },
          warn: () => {},
        }),
      });

      const response = await callerFetch(`${base}/backend/abc123/api/settings`);

      expect(response.status).toBe(200);
    });
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
