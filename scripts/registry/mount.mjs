/**
 * Mounts the fleet registry onto an HTTP front door.
 *
 * Two processes serve the canvas: `scripts/ingress.mjs` on a developer
 * machine, and `scripts/static-server.mjs` inside the container the helm chart
 * deploys. The registry belongs to whichever of them owns the origin the
 * browser talks to, and it has to behave identically in both, so the wiring
 * lives here once rather than being written twice and drifting.
 *
 * What it mounts:
 *
 *   /api/registry/*   the REST surface, including the one unauthenticated
 *                     route (`register`), which is why it cannot be proxied
 *                     to the agent server
 *   /backend/:id/*    the credential-injecting proxy, so a fleet entry is
 *                     reachable without a second thing to configure
 *
 * Plus the pull sources (`k8s`, `tailnet`), each on its own loop: a cluster
 * this process cannot reach never stops the tailnet source, or signed
 * enrolment, from working.
 */

import { createBackendProxy, isBackendProxyRequest } from "../proxy-backend.mjs";
import { logSafeUrl } from "../proxy-utils.mjs";
import { createAccessLog } from "./access-log.mjs";
import { createRegistry, isRegistryRequest } from "./routes.mjs";
import { createSecretProvider } from "./secrets/interface.mjs";
import { readInClusterConfig, syncKubernetesSource } from "./sources/k8s.mjs";
import {
  DEFAULT_SOURCE_INTERVAL_MS,
  startSourceLoop,
} from "./sources/sync.mjs";
import { syncTailnetSource } from "./sources/tailnet.mjs";

/** Splits a comma/space separated fingerprint list, dropping empties. */
export function parseFingerprintList(value) {
  return String(value ?? "")
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

function isEnvFlagEnabled(value) {
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return normalized !== "" && normalized !== "0" && normalized !== "false";
}

/**
 * The registry is off unless a session key is configured, so a front door
 * started the way it is today behaves exactly as it does today.
 *
 * Its entries live in the agent server's `misc_settings`, and that server is
 * already in the route table, so the URL defaults to whichever backend serves
 * `/api` rather than being configured twice.
 *
 * @param {{
 *   sessionKey?: string | null,
 *   agentServerUrl?: string | null,
 *   preseed?: string[],
 *   secretProvider?: string | null,
 *   allowUncredentialed?: boolean,
 *   accessLog?: string | null,
 *   sources?: string[],
 * }} args   values taken from the command line
 * @param {Record<string, string | undefined>} env
 * @param {(path: string) => string | null} resolveAgentServer
 */
export function buildRegistryConfig(args, env, resolveAgentServer) {
  const sessionKey = args.sessionKey || env.REGISTRY_SESSION_KEY || null;
  if (!sessionKey) {
    // An operator who asked for the wire record and silently got no file
    // believes there is evidence where there is none, which is worse than
    // having asked for nothing.
    if (args.accessLog || env.REGISTRY_ACCESS_LOG) {
      console.warn(
        "[ingress] --registry-access-log was given but the registry is off " +
          "(no --registry-session-key): nothing will be logged.",
      );
    }
    return null;
  }

  const agentServerUrl =
    args.agentServerUrl ||
    env.REGISTRY_AGENT_SERVER ||
    resolveAgentServer("/api/settings");
  if (!agentServerUrl) {
    throw new Error(
      "Registry is enabled but no agent server was found to store it in. " +
        "Pass --registry-agent-server <url> or add an /api route.",
    );
  }

  return {
    sessionKey,
    agentServerUrl,
    preSeededFingerprints: [
      ...(args.preseed ?? []),
      ...parseFingerprintList(env.REGISTRY_PRESEED),
    ],
    secretProvider:
      args.secretProvider || env.REGISTRY_SECRET_PROVIDER || null,
    allowUncredentialed:
      Boolean(args.allowUncredentialed) ||
      isEnvFlagEnabled(env.REGISTRY_ALLOW_UNCREDENTIALED),
    accessLogFile: args.accessLog || env.REGISTRY_ACCESS_LOG || null,
    // How often a pull source re-reads its directory. The default is fine for
    // a fleet that changes by the hour; a test that scales a pool and asserts
    // on the result needs it shorter than its own patience.
    sourceIntervalMs:
      Number(args.sourceIntervalMs ?? env.REGISTRY_SOURCE_INTERVAL_MS) ||
      DEFAULT_SOURCE_INTERVAL_MS,
    sources: {
      kubernetes:
        Boolean(args.sources?.includes("k8s")) ||
        isEnvFlagEnabled(env.REGISTRY_SOURCE_KUBERNETES),
      tailnet:
        Boolean(args.sources?.includes("tailnet")) ||
        isEnvFlagEnabled(env.REGISTRY_SOURCE_TAILNET),
    },
  };
}

/**
 * Starts the configured pull sources.
 *
 * The Kubernetes credentials are re-read on every cycle rather than cached
 * for the life of the process: a projected ServiceAccount token is rotated
 * roughly hourly, and a process holding the token it read at boot starts
 * getting 401s an hour in and never recovers until it restarts. Reading three
 * small files once a poll is cheaper than that failure mode.
 */
export function startRegistrySources(registryConfig, store, overrides = {}) {
  const {
    readConfig = readInClusterConfig,
    syncKubernetes = syncKubernetesSource,
    syncTailnet = syncTailnetSource,
    startLoop = startSourceLoop,
  } = overrides;
  const stops = [];
  const intervalMs = registryConfig.sourceIntervalMs ?? undefined;

  if (registryConfig.sources?.kubernetes) {
    stops.push(
      startLoop({
        name: "k8s",
        intervalMs,
        sync: async () => {
          const config = await readConfig();
          await syncKubernetes({ store, config });
        },
      }),
    );
  }

  if (registryConfig.sources?.tailnet) {
    stops.push(
      startLoop({
        name: "tailnet",
        intervalMs,
        sync: () => syncTailnet({ store }),
      }),
    );
  }

  return () => stops.forEach((stop) => stop());
}

/**
 * Builds the registry, its injecting proxy and its pull sources.
 *
 * Returns `null` when the registry is not configured, so a caller mounts it
 * with one `if` and changes nothing else about how it serves.
 *
 * @param {object} registryConfig  from {@link buildRegistryConfig}
 * @param {{ proxy: object }} deps the front door's shared proxy handlers
 */
export function mountRegistry(registryConfig, { proxy }) {
  if (!registryConfig) return null;

  const registry = createRegistry(registryConfig);
  // The proxy is mounted with the registry, so a fleet entry can always be
  // reached at /backend/:id without a second thing to configure. An entry with
  // a credential reference and no provider fails there with a clear error
  // rather than silently proxying uncredentialed.
  const backendProxy = createBackendProxy({
    store: registry.store,
    secrets: registryConfig.secretProvider
      ? createSecretProvider(registryConfig.secretProvider)
      : null,
    // The proxy authenticates its callers with the same key the registry
    // routes use; it injects fleet credentials, so it cannot be the one
    // route on this origin that asks nothing of whoever is calling.
    sessionKey: registryConfig.sessionKey,
    allowUncredentialed: registryConfig.allowUncredentialed ?? false,
    accessLog: registryConfig.accessLogFile
      ? createAccessLog({ file: registryConfig.accessLogFile })
      : null,
    proxy,
  });
  const stopSources = startRegistrySources(registryConfig, registry.store);

  return {
    store: registry.store,

    /**
     * Handles the request if it belongs to the registry or the fleet proxy.
     * Returns `false` for everything else, which the caller then routes as it
     * did before.
     */
    handle(req, res) {
      const url = req.url ?? "/";

      // Served here rather than proxied: a node enrolling for the first time
      // has no session key, so this route cannot live behind the agent server.
      if (isRegistryRequest(req)) {
        registry.handle(req, res).catch((err) => {
          console.error(`Registry error for ${logSafeUrl(url)}:`, err);
          res.destroy();
        });
        return true;
      }

      if (isBackendProxyRequest(req)) {
        backendProxy.handle(req, res).catch((err) => {
          console.error(`Backend proxy error for ${logSafeUrl(url)}:`, err);
          res.destroy();
        });
        return true;
      }

      return false;
    },

    /** The upgrade-path twin of `handle`. */
    handleUpgrade(req, socket, head) {
      if (!isBackendProxyRequest(req)) return false;
      backendProxy.handleUpgrade(req, socket, head).catch(() => {
        socket.destroy();
      });
      return true;
    },

    stop: stopSources,
  };
}
