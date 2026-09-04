import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { server as mswServer } from "#/mocks/node";
import {
  __resetActiveStoreForTests,
  getRegisteredBackends,
  setRegisteredBackends,
} from "#/api/backend-registry/active-store";
import {
  __resetRegistryStatusForTests,
  approveRegistryEntry,
  fetchRegistryEntries,
  getRegistryStatus,
  hydrateFromRegistry,
  mergeRegistryEntries,
  registryBackendId,
  registryEntryId,
  startRegistryHydration,
  type RegistryEntry,
} from "#/api/backend-registry/registry-source";
import { BACKENDS_STORAGE_KEY } from "#/api/backend-registry/storage";
import type { Backend } from "#/api/backend-registry/types";

const MANUAL_BACKEND: Backend = {
  id: "manual-1",
  name: "My laptop",
  host: "http://127.0.0.1:8000",
  apiKey: "manual-key",
  kind: "local",
};

function entry(overrides: Partial<RegistryEntry> = {}): RegistryEntry {
  return {
    id: "abc123",
    name: "hetzner",
    host: "https://claude-hetzner.example.ts.net:8443",
    fingerprint: "SHA256:abc",
    state: "active",
    ...overrides,
  };
}

/** Replaces global fetch; MSW is stopped for this file so nothing intercepts. */
function stubFetch(impl: (url: string, init?: RequestInit) => Response) {
  const spy = vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve(impl(String(input), init)),
  );
  vi.stubGlobal("fetch", spy);
  return spy;
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  mswServer.close();
  vi.stubEnv("VITE_BACKEND_BASE_URL", "http://127.0.0.1:8000");
  vi.stubEnv("VITE_SESSION_API_KEY", "launcher-key");
  window.localStorage.setItem(
    BACKENDS_STORAGE_KEY,
    JSON.stringify([MANUAL_BACKEND]),
  );
  __resetActiveStoreForTests();
  __resetRegistryStatusForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  window.localStorage.clear();
  window.sessionStorage.clear();
  mswServer.listen({ onUnhandledRequest: "bypass" });
});

describe("mergeRegistryEntries", () => {
  it("keeps manual entries and adds the registry's own", () => {
    const merged = mergeRegistryEntries([MANUAL_BACKEND], [entry()]);

    expect(merged).toHaveLength(2);
    expect(merged[0]).toBe(MANUAL_BACKEND);
    expect(merged[1]).toMatchObject({
      id: registryBackendId("abc123"),
      name: "hetzner",
      provenance: "registry",
      registryState: "active",
    });
  });

  it("hands the browser no credential for a fleet entry", () => {
    const [hydrated] = mergeRegistryEntries([], [entry()]);

    expect(hydrated.apiKey).toBe("");
  });

  it("routes a fleet entry through the injecting proxy, not the node itself", () => {
    const [hydrated] = mergeRegistryEntries([], [entry()]);

    // The node's own address never becomes the browser's base URL: reaching it
    // directly would need the key the browser is not allowed to hold.
    expect(hydrated.host).toBe(`${window.location.origin}/backend/abc123`);
    expect(hydrated.host).not.toContain("claude-hetzner");
  });

  it("replaces the previously hydrated set rather than accumulating", () => {
    const first = mergeRegistryEntries([MANUAL_BACKEND], [entry()]);
    const second = mergeRegistryEntries(first, [
      entry({ id: "def456", name: "other" }),
    ]);

    expect(second.map((b) => b.name)).toEqual(["My laptop", "other"]);
  });

  it("drops a revoked entry so a decommissioned host disappears", () => {
    const merged = mergeRegistryEntries(
      [],
      [entry(), entry({ id: "gone", state: "revoked" })],
    );

    expect(merged.map((b) => b.name)).toEqual(["hetzner"]);
  });

  it("keeps a manual entry that points at the same host as a fleet entry", () => {
    const sameHost = { ...MANUAL_BACKEND, host: entry().host };

    const merged = mergeRegistryEntries([sameHost], [entry()]);

    // The manual entry carries a working credential and the fleet entry does
    // not, so collapsing them would take away a backend that works today.
    expect(merged).toHaveLength(2);
  });
});

describe("registryEntryId", () => {
  it("round-trips a hydrated id", () => {
    const [hydrated] = mergeRegistryEntries([], [entry()]);
    expect(registryEntryId(hydrated)).toBe("abc123");
  });

  it("returns null for a manual backend", () => {
    expect(registryEntryId(MANUAL_BACKEND)).toBeNull();
  });
});

describe("fetchRegistryEntries", () => {
  it("sends the launcher session key", async () => {
    const spy = stubFetch(() => jsonResponse({ entries: [entry()] }));

    await fetchRegistryEntries();

    const init = spy.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)["X-Session-API-Key"]).toBe(
      "launcher-key",
    );
  });

  it("reports no registry when the path 404s", async () => {
    stubFetch(() => new Response("", { status: 404 }));

    expect(await fetchRegistryEntries()).toBeNull();
  });

  it("reports no registry when the body is not the documented shape", async () => {
    stubFetch(() => jsonResponse({ detail: "Not Found" }));

    expect(await fetchRegistryEntries()).toBeNull();
  });

  it("drops malformed entries rather than rendering them", async () => {
    stubFetch(() => jsonResponse({ entries: [entry(), { id: "bad" }] }));

    expect(await fetchRegistryEntries()).toHaveLength(1);
  });

  it("throws on any other error status", async () => {
    stubFetch(() => new Response("", { status: 500 }));

    await expect(fetchRegistryEntries()).rejects.toThrow(/500/);
  });
});

describe("hydrateFromRegistry", () => {
  it("pushes the fleet through the store and caches it", async () => {
    stubFetch(() => jsonResponse({ entries: [entry()] }));

    await hydrateFromRegistry();

    expect(getRegisteredBackends().map((b) => b.name)).toEqual([
      "My laptop",
      "hetzner",
    ]);
    expect(getRegistryStatus()).toBe("ok");
    const cached = JSON.parse(
      window.localStorage.getItem(BACKENDS_STORAGE_KEY) ?? "[]",
    );
    expect(cached).toHaveLength(2);
  });

  it("keeps the cached list when the registry is unreachable", async () => {
    stubFetch(() => {
      throw new TypeError("Failed to fetch");
    });

    await hydrateFromRegistry();

    expect(getRegisteredBackends()).toEqual([MANUAL_BACKEND]);
    expect(getRegistryStatus()).toBe("unreachable");
  });

  it("keeps a previously hydrated fleet on screen when the registry drops out", async () => {
    stubFetch(() => jsonResponse({ entries: [entry()] }));
    await hydrateFromRegistry();

    stubFetch(() => {
      throw new TypeError("Failed to fetch");
    });
    await hydrateFromRegistry();

    expect(getRegisteredBackends().map((b) => b.name)).toEqual([
      "My laptop",
      "hetzner",
    ]);
    expect(getRegistryStatus()).toBe("unreachable");
  });

  it("stops polling on a deployment that serves no registry", async () => {
    stubFetch(() => new Response("", { status: 404 }));

    expect(await hydrateFromRegistry()).toBe(false);
    expect(getRegistryStatus()).toBe("disabled");
    expect(getRegisteredBackends()).toEqual([MANUAL_BACKEND]);
  });
});

describe("startRegistryHydration", () => {
  it("hydrates once and schedules no further fetch when disabled", async () => {
    const spy = stubFetch(() => new Response("", { status: 404 }));

    const stop = startRegistryHydration(10);
    await vi.waitFor(() => expect(getRegistryStatus()).toBe("disabled"));
    stop();

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("stops fetching once the returned function is called", async () => {
    const spy = stubFetch(() => jsonResponse({ entries: [] }));

    const stop = startRegistryHydration(10);
    await vi.waitFor(() => expect(getRegistryStatus()).toBe("ok"));
    stop();
    const callsAtStop = spy.mock.calls.length;

    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
    expect(spy.mock.calls.length).toBe(callsAtStop);
  });
});

describe("approveRegistryEntry", () => {
  it("posts to the registry and re-hydrates", async () => {
    const [pending] = mergeRegistryEntries([], [entry({ state: "pending" })]);
    setRegisteredBackends([pending]);

    const spy = stubFetch((url, init) => {
      if (init?.method === "POST") return jsonResponse({ entry: {} });
      return jsonResponse({ entries: [entry({ state: "active" })] });
    });

    await approveRegistryEntry(pending);

    expect(spy.mock.calls[0][0]).toBe("/api/registry/abc123/approve");
    expect(getRegisteredBackends()[0].registryState).toBe("active");
  });

  it("surfaces a rejected approval instead of pretending it worked", async () => {
    const [pending] = mergeRegistryEntries([], [entry({ state: "pending" })]);
    stubFetch(() => new Response("", { status: 401 }));

    await expect(approveRegistryEntry(pending)).rejects.toThrow(/401/);
  });
});
