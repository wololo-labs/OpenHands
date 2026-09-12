import { describe, expect, it, vi } from "vitest";

import {
  buildRegistryConfig,
  startRegistrySources,
} from "../../scripts/registry/mount.mjs";

/**
 * The registry's wiring, shared by `scripts/ingress.mjs` (a developer machine)
 * and `scripts/static-server.mjs` (the container the helm chart deploys). The
 * two front doors have to behave identically, which is why the wiring is one
 * module and why it is tested here rather than twice over.
 */
describe("buildRegistryConfig", () => {
  const resolveAgentServer = () => "http://127.0.0.1:18000";

  it("stays off without a session key, so an existing deployment is unchanged", () => {
    expect(buildRegistryConfig({}, {}, resolveAgentServer)).toBeNull();
  });

  it("says so when an access log is asked for and the registry is off", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(
      buildRegistryConfig({ accessLog: "/tmp/x.jsonl" }, {}, resolveAgentServer),
    ).toBeNull();

    // Naming the flag is the point: an operator who asked for the wire record
    // and silently got no file believes there is evidence where there is none.
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("--registry-access-log"),
    );
    warn.mockRestore();
  });

  it("reads the same settings from flags and from the environment", () => {
    const fromFlags = buildRegistryConfig(
      {
        sessionKey: "k",
        preseed: ["SHA256:aaa"],
        secretProvider: "file",
        allowUncredentialed: true,
        sources: ["k8s", "tailnet"],
      },
      {},
      resolveAgentServer,
    );
    const fromEnv = buildRegistryConfig(
      {},
      {
        REGISTRY_SESSION_KEY: "k",
        REGISTRY_PRESEED: "SHA256:aaa",
        REGISTRY_SECRET_PROVIDER: "file",
        REGISTRY_ALLOW_UNCREDENTIALED: "1",
        REGISTRY_SOURCE_KUBERNETES: "1",
        REGISTRY_SOURCE_TAILNET: "1",
      },
      resolveAgentServer,
    );

    expect(fromEnv).toEqual(fromFlags);
    expect(fromEnv).toMatchObject({
      allowUncredentialed: true,
      sources: { kubernetes: true, tailnet: true },
    });
  });

  it("refuses to enable a registry with nowhere to store it", () => {
    expect(() => buildRegistryConfig({ sessionKey: "k" }, {}, () => null))
      .toThrowError(/no agent server/);
  });
});

describe("startRegistrySources", () => {
  /** Runs `sync` on demand instead of on a timer, so a cycle is a call. */
  function manualLoop() {
    const cycles: (() => Promise<void>)[] = [];
    const startLoop = ({ sync }: { sync: () => Promise<void> }) => {
      cycles.push(sync);
      return () => {};
    };
    return { cycles, startLoop };
  }

  /**
   * A projected ServiceAccount token is rotated roughly hourly. A process that
   * reads it once at boot starts getting 401s an hour in and never recovers
   * until the pod restarts — and `startSourceLoop` swallows the error, so the
   * registry simply stops listing with nothing in the logs to say why.
   */
  it("re-reads the ServiceAccount credentials on every cycle", async () => {
    const { cycles, startLoop } = manualLoop();
    const tokens = ["token-1", "token-2", "token-3"];
    const readConfig = vi.fn(async () => ({
      apiServer: "https://10.0.0.1:443",
      token: tokens[readConfig.mock.calls.length - 1] ?? "token-last",
      namespace: "agents",
      ca: "ca",
    }));
    const syncKubernetes = vi.fn(async () => {});

    startRegistrySources({ sources: { kubernetes: true } }, {} as never, {
      readConfig,
      syncKubernetes,
      startLoop,
    });

    await cycles[0]();
    await cycles[0]();
    await cycles[0]();

    expect(readConfig).toHaveBeenCalledTimes(3);
    expect(
      syncKubernetes.mock.calls.map(([{ config }]: any) => config.token),
      "a cached token is the hour-long outage this re-read exists to stop",
    ).toEqual(["token-1", "token-2", "token-3"]);
  });

  it("runs each configured source on its own loop", () => {
    const { cycles, startLoop } = manualLoop();

    const stop = startRegistrySources(
      { sources: { kubernetes: true, tailnet: true } },
      {} as never,
      { startLoop, readConfig: async () => ({}) as never },
    );

    expect(cycles).toHaveLength(2);
    expect(() => stop()).not.toThrow();
  });

  it("starts nothing when no source is configured", () => {
    const { cycles, startLoop } = manualLoop();

    startRegistrySources({ sources: {} }, {} as never, { startLoop });

    expect(cycles).toHaveLength(0);
  });
});
