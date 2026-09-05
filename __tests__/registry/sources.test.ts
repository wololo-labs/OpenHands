import { describe, expect, it, vi } from "vitest";

import {
  listAgentServerServices,
  readInClusterConfig,
  serviceFingerprint,
  serviceToCandidate,
  syncKubernetesSource,
} from "../../scripts/registry/sources/k8s.mjs";
import {
  listTaggedPeers,
  peerToCandidate,
  syncTailnetSource,
} from "../../scripts/registry/sources/tailnet.mjs";
import {
  probeServerInfo,
  startSourceLoop,
  syncSourceEntries,
} from "../../scripts/registry/sources/sync.mjs";
import { createStore, entryId } from "../../scripts/registry/store.mjs";

type Entry = Record<string, any> & { id: string; state: string };

/**
 * `beforeWrite` stands in for the provider's lock: it runs at the moment a
 * write commits, which is the window a sync's decisions have to survive.
 */
function createMemoryStore(
  seed: Entry[] = [],
  beforeWrite?: () => void | Promise<void>,
) {
  const entries = new Map(seed.map((entry) => [entry.id, entry]));
  return createStore({
    async list() {
      return [...entries.values()];
    },
    async upsert(entry: Entry) {
      await beforeWrite?.();
      entries.set(entry.id, entry);
      return entry;
    },
    async mutate(
      id: string,
      apply: (
        existing: Entry | null,
        entries: Entry[],
      ) => Promise<Entry | undefined> | Entry | undefined,
    ) {
      await beforeWrite?.();
      const existing = entries.get(id) ?? null;
      const next = await apply(existing, [...entries.values()]);
      if (next === undefined) return existing;
      entries.set(id, next);
      return next;
    },
    async remove(id: string) {
      entries.delete(id);
    },
    async setState(id: string, state: string) {
      await beforeWrite?.();
      const entry = entries.get(id);
      if (!entry) throw new Error(`no entry ${id}`);
      const updated = { ...entry, state };
      entries.set(id, updated);
      return updated;
    },
  });
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Typed as `fetch` so it can stand in for it, recorded so it can be asserted on. */
function stubFetch(
  impl: (url: string, init?: RequestInit) => Promise<Response>,
) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return impl(String(input), init);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const K8S_CONFIG = {
  apiServer: "https://10.0.0.1:443",
  token: "sa-token",
  namespace: "agents",
};

function service(name: string, port = 8000) {
  return {
    metadata: { name, namespace: "agents" },
    spec: { ports: [{ name: "http", port }] },
  };
}

describe("probeServerInfo", () => {
  it("reports liveness and version without any credential", async () => {
    const { fetchImpl, calls } = stubFetch(async () =>
      jsonResponse({ version: "1.44.0" }),
    );

    const probe = await probeServerInfo("http://agent.svc:8000", { fetchImpl });

    expect(calls[0].url).toBe("http://agent.svc:8000/server_info");
    expect(calls[0].init?.headers).toBeUndefined();
    expect(probe).toEqual({ reachable: true, version: "1.44.0" });
  });

  it("reports unreachable rather than throwing when the host is dead", async () => {
    const { fetchImpl } = stubFetch(async () => {
      throw new TypeError("ECONNREFUSED");
    });

    expect(await probeServerInfo("http://dead:8000", { fetchImpl })).toEqual({
      reachable: false,
      version: null,
    });
  });

  it("treats a non-2xx answer as not an agent server", async () => {
    const { fetchImpl } = stubFetch(
      async () => new Response("", { status: 404 }),
    );

    expect(await probeServerInfo("http://other:8000", { fetchImpl })).toEqual({
      reachable: false,
      version: null,
    });
  });
});

describe("syncSourceEntries", () => {
  const candidate = {
    name: "a",
    host: "http://a.svc:8000",
    fingerprint: "k8s:agents/a",
    reachable: true,
  };

  it("writes discovered machines as active without an approval step", async () => {
    const store = createMemoryStore();

    await syncSourceEntries({ store, source: "k8s", entries: [candidate] });

    const [entry] = await store.list();
    expect(entry).toMatchObject({
      id: entryId("k8s:agents/a"),
      state: "active",
      source: "k8s",
      pubkey: null,
    });
  });

  it("marks an unreachable machine stale rather than active", async () => {
    const store = createMemoryStore();

    await syncSourceEntries({
      store,
      source: "k8s",
      entries: [{ ...candidate, reachable: false }],
    });

    expect((await store.list())[0].state).toBe("stale");
  });

  it("never resurrects a revoked entry from a directory listing", async () => {
    const store = createMemoryStore();
    await syncSourceEntries({ store, source: "k8s", entries: [candidate] });
    await store.setState(entryId("k8s:agents/a"), "revoked");

    await syncSourceEntries({ store, source: "k8s", entries: [candidate] });

    expect((await store.list())[0].state).toBe("revoked");
  });

  it("does not undo a revoke that lands while it is syncing", async () => {
    // The directory listing is read once and then written back entry by
    // entry. A revoke arriving in that window used to be overwritten by a
    // state computed before it, so revoking a machine the cluster still
    // reports did not stick.
    let revoke: (() => Promise<void>) | null = null;
    const store = createMemoryStore([], async () => {
      const pending = revoke;
      revoke = null;
      await pending?.();
    });
    await syncSourceEntries({ store, source: "k8s", entries: [candidate] });

    const id = entryId("k8s:agents/a");
    revoke = async () => {
      await store.setState(id, "revoked");
    };
    await syncSourceEntries({ store, source: "k8s", entries: [candidate] });

    expect((await store.list())[0].state).toBe("revoked");
  });

  it("does not stale a revoke that lands while it is syncing", async () => {
    let revoke: (() => Promise<void>) | null = null;
    const store = createMemoryStore([], async () => {
      const pending = revoke;
      revoke = null;
      await pending?.();
    });
    await syncSourceEntries({ store, source: "k8s", entries: [candidate] });

    const id = entryId("k8s:agents/a");
    revoke = async () => {
      await store.setState(id, "revoked");
    };
    await syncSourceEntries({ store, source: "k8s", entries: [] });

    expect((await store.list())[0].state).toBe("revoked");
  });

  it("stales an entry the source stops reporting instead of deleting it", async () => {
    const store = createMemoryStore();
    await syncSourceEntries({ store, source: "k8s", entries: [candidate] });

    await syncSourceEntries({ store, source: "k8s", entries: [] });

    const [entry] = await store.list();
    expect(entry.state).toBe("stale");
  });

  it("leaves entries owned by another source alone", async () => {
    const store = createMemoryStore();
    await syncSourceEntries({ store, source: "tailnet", entries: [candidate] });

    await syncSourceEntries({ store, source: "k8s", entries: [] });

    expect((await store.list())[0].state).toBe("active");
  });
});

describe("kubernetes source", () => {
  it("builds the cluster-internal address for a Service", () => {
    expect(serviceToCandidate(service("pool-0"))).toEqual({
      name: "pool-0",
      host: "http://pool-0.agents.svc.cluster.local:8000",
      fingerprint: serviceFingerprint("agents", "pool-0"),
    });
  });

  it("falls back to the first port when none is named http", () => {
    const candidate = serviceToCandidate({
      metadata: { name: "pool-1", namespace: "agents" },
      spec: { ports: [{ port: 9000 }] },
    });

    expect(candidate?.host).toContain(":9000");
  });

  it("skips a Service with no name", () => {
    expect(serviceToCandidate({ spec: {} })).toBeNull();
  });

  it("asks the API server for exactly the labelled Services", async () => {
    const { fetchImpl, calls } = stubFetch(async () =>
      jsonResponse({ items: [service("pool-0"), service("pool-1")] }),
    );

    const candidates = await listAgentServerServices({
      config: K8S_CONFIG,
      fetchImpl,
    });

    const url = new URL(calls[0].url);
    expect(url.pathname).toBe("/api/v1/namespaces/agents/services");
    expect(url.searchParams.get("labelSelector")).toBe(
      "app.kubernetes.io/name=agent-server",
    );
    expect(
      (calls[0].init?.headers as Record<string, string>).Authorization,
    ).toBe("Bearer sa-token");
    expect(candidates).toHaveLength(2);
  });

  it("surfaces an API error instead of reporting an empty fleet", async () => {
    const { fetchImpl } = stubFetch(
      async () => new Response("", { status: 403 }),
    );

    await expect(
      listAgentServerServices({ config: K8S_CONFIG, fetchImpl }),
    ).rejects.toThrow(/403/);
  });

  it("lists, probes and writes into the store", async () => {
    const store = createMemoryStore();
    const { fetchImpl } = stubFetch(async (url: string) => {
      if (url.includes("/server_info")) {
        return jsonResponse({ version: "1.44.0" });
      }
      return jsonResponse({ items: [service("pool-0")] });
    });

    await syncKubernetesSource({ store, config: K8S_CONFIG, fetchImpl });

    expect((await store.list())[0]).toMatchObject({
      name: "pool-0",
      state: "active",
      source: "k8s",
      version: "1.44.0",
    });
  });

  it("refuses to guess a cluster it is not running in", async () => {
    await expect(readInClusterConfig({ env: {} })).rejects.toThrow(
      /not running in a cluster/,
    );
  });

  it("reads the ServiceAccount credentials the pod is given", async () => {
    const readFileImpl = vi.fn(async (path: string): Promise<string> => {
      if (path.endsWith("/token")) return "tok\n";
      if (path.endsWith("/namespace")) return "agents\n";
      return "ca";
    });

    const config = await readInClusterConfig({
      env: {
        KUBERNETES_SERVICE_HOST: "10.0.0.1",
        KUBERNETES_SERVICE_PORT: "443",
      },
      readFileImpl,
    });

    expect(config).toMatchObject({
      apiServer: "https://10.0.0.1:443",
      token: "tok",
      namespace: "agents",
    });
  });
});

describe("tailnet source", () => {
  const peer = {
    ID: "nodeid-1",
    HostName: "claude-hetzner",
    DNSName: "claude-hetzner.example.ts.net.",
    Tags: ["tag:openhands"],
  };

  it("addresses a peer by its tailnet name on the published port", () => {
    expect(peerToCandidate(peer)).toEqual({
      name: "claude-hetzner",
      host: "https://claude-hetzner.example.ts.net:8443",
      fingerprint: "tailnet:nodeid-1",
    });
  });

  it("lists only peers carrying the tag", () => {
    const status = {
      Peer: {
        a: peer,
        b: { ...peer, ID: "nodeid-2", Tags: ["tag:other"] },
        c: { ...peer, ID: "nodeid-3", Tags: undefined },
      },
    };

    expect(listTaggedPeers(status).map((c) => c.fingerprint)).toEqual([
      "tailnet:nodeid-1",
    ]);
  });

  it("keys an entry by node id, so an address change updates in place", async () => {
    const store = createMemoryStore();
    const { fetchImpl } = stubFetch(async () =>
      jsonResponse({ version: "1.44.0" }),
    );
    const readStatus = vi
      .fn()
      .mockResolvedValueOnce({ Peer: { a: peer } })
      .mockResolvedValueOnce({
        Peer: { a: { ...peer, DNSName: "renamed.example.ts.net." } },
      });

    await syncTailnetSource({ store, fetchImpl, readStatus });
    await syncTailnetSource({ store, fetchImpl, readStatus });

    const entries = await store.list();
    expect(entries).toHaveLength(1);
    expect(entries[0].host).toBe("https://renamed.example.ts.net:8443");
  });

  it("marks a tagged peer that does not answer as stale", async () => {
    const store = createMemoryStore();
    const { fetchImpl } = stubFetch(async () => {
      throw new TypeError("ECONNREFUSED");
    });

    await syncTailnetSource({
      store,
      fetchImpl,
      readStatus: async () => ({ Peer: { a: peer } }),
    });

    expect((await store.list())[0].state).toBe("stale");
  });
});

describe("startSourceLoop", () => {
  it("syncs immediately and again on the interval", async () => {
    const sync = vi.fn().mockResolvedValue(undefined);

    const stop = startSourceLoop({ name: "k8s", sync, intervalMs: 5 });
    await vi.waitFor(() => expect(sync.mock.calls.length).toBeGreaterThan(1));
    stop();
  });

  it("keeps going after a failed cycle instead of taking the registry down", async () => {
    const onError = vi.fn();
    const sync = vi
      .fn()
      .mockRejectedValueOnce(new Error("cluster unreachable"))
      .mockResolvedValue(undefined);

    const stop = startSourceLoop({ name: "k8s", sync, intervalMs: 5, onError });
    await vi.waitFor(() => expect(sync.mock.calls.length).toBeGreaterThan(1));
    stop();

    expect(onError).toHaveBeenCalledWith("k8s", expect.any(Error));
  });

  it("stops scheduling once stopped", async () => {
    const sync = vi.fn().mockResolvedValue(undefined);

    const stop = startSourceLoop({ name: "k8s", sync, intervalMs: 5 });
    await vi.waitFor(() => expect(sync).toHaveBeenCalled());
    stop();
    const callsAtStop = sync.mock.calls.length;

    await new Promise((resolve) => {
      setTimeout(resolve, 40);
    });
    expect(sync.mock.calls.length).toBe(callsAtStop);
  });
});
