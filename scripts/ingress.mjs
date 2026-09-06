#!/usr/bin/env node
/**
 * Standalone Ingress / Reverse Proxy
 *
 * A minimal HTTP reverse proxy that routes requests to multiple backends
 * based on URL path. Completely independent of any backend implementation.
 *
 * Usage:
 *   node scripts/ingress.mjs [options]
 *   node scripts/ingress.mjs --port 8000 --route "/api/automation=http://localhost:18001" --route "/api=http://localhost:18000" --default "http://localhost:3001"
 *
 * Environment variables:
 *   INGRESS_PORT          - Port to listen on (default: 8000)
 *   INGRESS_ROUTES        - JSON object of path prefix -> backend URL
 *   INGRESS_DEFAULT       - Default backend for unmatched routes
 *   INGRESS_RUNTIME_SERVICES_INFO - Runtime services JSON appended to
 *                                   /server_info
 *   REGISTRY_SESSION_KEY  - Enables the in-process fleet registry on
 *                           /api/registry/* and authenticates its read and
 *                           approval routes
 *   REGISTRY_AGENT_SERVER - Agent server that stores the registry (defaults
 *                           to whichever backend serves /api)
 *   REGISTRY_PRESEED      - Comma/space separated SSH fingerprints that enrol
 *                           straight to "active"
 *   REGISTRY_SECRET_PROVIDER - Secret provider used to resolve a fleet
 *                           backend's session key when proxying /backend/:id
 *   REGISTRY_ALLOW_UNCREDENTIALED - Proxy fleet entries that carry no
 *                           credential reference (off by default)
 *   REGISTRY_SOURCE_KUBERNETES - Populate the registry from Services labelled
 *                           app.kubernetes.io/name=agent-server
 *   REGISTRY_SOURCE_TAILNET - Populate the registry from tailnet peers tagged
 *                           tag:openhands
 *
 * Route matching:
 *   - Routes are matched by longest prefix first
 *   - More specific routes take precedence (e.g., /api/automation before /api)
 */

import { createServer } from "node:http";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  createProxyHandlers,
  createRouter,
  isBenignSocketError,
  isServerInfoRequest,
  logSafeUrl,
  matchesPathPrefix,
  proxyServerInfoRequest,
} from "./proxy-utils.mjs";
import { createBackendProxy, isBackendProxyRequest } from "./proxy-backend.mjs";
import { createAccessLog } from "./registry/access-log.mjs";
import { createRegistry, isRegistryRequest } from "./registry/routes.mjs";
import { createSecretProvider } from "./registry/secrets/interface.mjs";
import {
  readInClusterConfig,
  syncKubernetesSource,
} from "./registry/sources/k8s.mjs";
import { startSourceLoop } from "./registry/sources/sync.mjs";
import { syncTailnetSource } from "./registry/sources/tailnet.mjs";

// ═══════════════════════════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════════════════════════

function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    port: 8000,
    routes: {},
    defaultBackend: null,
    noReferrerPrefixes: [],
    runtimeServicesInfo: null,
    registrySessionKey: null,
    registryAgentServer: null,
    registryPreseed: [],
    registrySecretProvider: null,
    registryAllowUncredentialed: false,
    registryAccessLog: null,
    registrySources: [],
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "-p":
      case "--port":
        config.port = parseInt(args[++i], 10);
        break;
      case "-r":
      case "--route":
        // Format: "/path=http://host:port"
        const [path, url] = args[++i].split("=");
        config.routes[path] = url;
        break;
      case "-d":
      case "--default":
        config.defaultBackend = args[++i];
        break;
      case "--no-referrer-prefix": {
        const prefix = args[++i];
        if (!prefix || !prefix.startsWith("/")) {
          throw new Error(
            `--no-referrer-prefix value must start with '/': ${prefix ?? "(empty)"}`,
          );
        }
        config.noReferrerPrefixes.push(prefix);
        break;
      }
      case "--runtime-services-info":
        config.runtimeServicesInfo = args[++i] || null;
        break;
      case "--registry-session-key":
        config.registrySessionKey = args[++i] || null;
        break;
      case "--registry-agent-server":
        config.registryAgentServer = args[++i] || null;
        break;
      case "--registry-preseed":
        config.registryPreseed.push(...parseFingerprintList(args[++i]));
        break;
      case "--registry-secret-provider":
        config.registrySecretProvider = args[++i] || null;
        break;
      case "--registry-allow-uncredentialed":
        config.registryAllowUncredentialed = true;
        break;
      case "--registry-access-log":
        config.registryAccessLog = args[++i] || null;
        break;
      case "--registry-source":
        config.registrySources.push(args[++i]);
        break;
      case "-h":
      case "--help":
        showHelp();
        process.exit(0);
    }
  }

  return config;
}

/** Splits a comma/space separated fingerprint list, dropping empties. */
function parseFingerprintList(value) {
  return String(value ?? "")
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

function showHelp() {
  console.log(`
Standalone Ingress / Reverse Proxy

Routes HTTP requests to multiple backends based on URL path prefix.

USAGE:
  node scripts/ingress.mjs [options]

OPTIONS:
  -p, --port <port>           Port to listen on (default: 8000)
  -r, --route <path=url>      Add a route (can be repeated)
  -d, --default <url>         Default backend for unmatched routes
  --no-referrer-prefix <p>    Send "Referrer-Policy: no-referrer" on proxied
                              responses under <p>. For upstreams whose URL
                              carries a credential in the query string.
  --runtime-services-info     Runtime services JSON for /server_info
  --registry-session-key <k>  Enable the fleet registry on /api/registry/*
                              and require <k> on its read/approval routes
  --registry-agent-server <u> Agent server storing the registry (defaults to
                              the backend serving /api)
  --registry-preseed <fprs>   SSH fingerprints that enrol straight to
                              "active" (comma or space separated, repeatable)
  --registry-secret-provider <name>
                              Secret provider used to resolve a fleet
                              backend's session key when proxying
                              /backend/:id (file, op)
  --registry-allow-uncredentialed
                              Proxy fleet entries that carry no credential
                              reference. Off by default: such an entry is
                              relayed to with no credential at all, which on
                              an agent server that does not authenticate
                              makes /backend/:id an open relay.
  --registry-access-log <f>   Append one JSON line per /backend/:id request
                              to <f>: the wire record of every hop to a fleet
                              node. Off unless given. The caller's session key
                              is stripped from the URL before writing.
  --registry-source <name>    Populate the registry from a directory that
                              already knows the fleet (k8s, tailnet).
                              Repeatable.
  -h, --help                  Show this help

ENVIRONMENT VARIABLES:
  INGRESS_PORT                Port to listen on
  INGRESS_ROUTES              JSON object: {"path": "url", ...}
  INGRESS_DEFAULT             Default backend URL
  INGRESS_RUNTIME_SERVICES_INFO
                              Runtime services JSON for /server_info
  REGISTRY_SESSION_KEY        Enable and authenticate the fleet registry
  REGISTRY_AGENT_SERVER       Agent server storing the registry
  REGISTRY_PRESEED            Pre-seeded SSH fingerprints
  REGISTRY_SECRET_PROVIDER    Secret provider for proxied fleet credentials
  REGISTRY_ALLOW_UNCREDENTIALED
                              Proxy fleet entries that carry no credential
  REGISTRY_ACCESS_LOG         Append one JSON line per /backend/:id request
  REGISTRY_SOURCE_KUBERNETES  Populate the registry from labelled Services
  REGISTRY_SOURCE_TAILNET     Populate the registry from tagged tailnet peers

EXAMPLES:
  # Basic setup with agent server and automation
  node scripts/ingress.mjs \\
    --port 8000 \\
    --route "/api/automation=http://localhost:18001" \\
    --route "/api=http://localhost:18000" \\
    --route "/sockets=http://localhost:18000" \\
    --default "http://localhost:3001"

  # Using environment variables
  INGRESS_PORT=8000 \\
  INGRESS_ROUTES='{"/ api/automation":"http://localhost:18001","/api":"http://localhost:18000"}' \\
  INGRESS_DEFAULT="http://localhost:3001" \\
  node scripts/ingress.mjs

ROUTE MATCHING:
  Routes are sorted by path length (longest first), so more specific
  routes like /api/automation will match before /api.
`);
}

function buildConfig(args, env = process.env) {
  let routes = { ...args.routes };

  // Merge env routes
  if (env.INGRESS_ROUTES) {
    try {
      const envRoutes = JSON.parse(env.INGRESS_ROUTES);
      routes = { ...routes, ...envRoutes };
    } catch (e) {
      console.error("Failed to parse INGRESS_ROUTES:", e.message);
    }
  }

  const defaultBackend = args.defaultBackend || env.INGRESS_DEFAULT || null;

  return {
    port: args.port || parseInt(env.INGRESS_PORT, 10) || 8000,
    routes,
    defaultBackend,
    noReferrerPrefixes: args.noReferrerPrefixes ?? [],
    runtimeServicesInfo:
      args.runtimeServicesInfo || env.INGRESS_RUNTIME_SERVICES_INFO || null,
    registry: buildRegistryConfig(args, env, routes, defaultBackend),
  };
}

/**
 * The registry is off unless a session key is configured, so an ingress
 * started the way it is today behaves exactly as it does today.
 *
 * Its entries live in the agent server's `misc_settings`, and that server is
 * already in the route table, so the URL defaults to whichever backend serves
 * `/api` rather than being configured twice.
 */
function buildRegistryConfig(args, env, routes, defaultBackend) {
  const sessionKey =
    args.registrySessionKey || env.REGISTRY_SESSION_KEY || null;
  if (!sessionKey) {
    return null;
  }

  const agentServerUrl =
    args.registryAgentServer ||
    env.REGISTRY_AGENT_SERVER ||
    createRouter(routes, defaultBackend)("/api/settings");
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
      ...(args.registryPreseed ?? []),
      ...parseFingerprintList(env.REGISTRY_PRESEED),
    ],
    secretProvider:
      args.registrySecretProvider || env.REGISTRY_SECRET_PROVIDER || null,
    allowUncredentialed:
      args.registryAllowUncredentialed ||
      Boolean(env.REGISTRY_ALLOW_UNCREDENTIALED),
    accessLogFile: args.registryAccessLog || env.REGISTRY_ACCESS_LOG || null,
    sources: {
      kubernetes:
        args.registrySources?.includes("k8s") ||
        Boolean(env.REGISTRY_SOURCE_KUBERNETES),
      tailnet:
        args.registrySources?.includes("tailnet") ||
        Boolean(env.REGISTRY_SOURCE_TAILNET),
    },
  };
}

/**
 * Starts the configured pull sources. Each runs independently, so a cluster
 * the pod cannot reach never stops the tailnet source (or signed enrolment)
 * from working.
 */
function startRegistrySources(registryConfig, store) {
  const stops = [];

  if (registryConfig.sources?.kubernetes) {
    let config = null;
    stops.push(
      startSourceLoop({
        name: "k8s",
        sync: async () => {
          config = config ?? (await readInClusterConfig());
          await syncKubernetesSource({ store, config });
        },
      }),
    );
  }

  if (registryConfig.sources?.tailnet) {
    stops.push(
      startSourceLoop({
        name: "tailnet",
        sync: () => syncTailnetSource({ store }),
      }),
    );
  }

  return () => stops.forEach((stop) => stop());
}

// ═══════════════════════════════════════════════════════════════════════════
// Server
// ═══════════════════════════════════════════════════════════════════════════

export function startIngress(config) {
  const route = createRouter(config.routes, config.defaultBackend);
  const proxy = createProxyHandlers({ label: `ingress:${config.port}` });
  const uninstallDiagnostics = proxy.installDiagnostics();

  const noReferrerPrefixes = config.noReferrerPrefixes ?? [];
  const registry = config.registry ? createRegistry(config.registry) : null;
  // The proxy is mounted with the registry, so a fleet entry can always be
  // reached at /backend/:id without a second thing to configure. An entry with
  // a credential reference and no provider fails there with a clear error
  // rather than silently proxying uncredentialed.
  const backendProxy = registry
    ? createBackendProxy({
        store: registry.store,
        secrets: config.registry.secretProvider
          ? createSecretProvider(config.registry.secretProvider)
          : null,
        // The proxy authenticates its callers with the same key the registry
        // routes use; it injects fleet credentials, so it cannot be the one
        // route on this origin that asks nothing of whoever is calling.
        sessionKey: config.registry.sessionKey,
        allowUncredentialed: config.registry.allowUncredentialed ?? false,
        accessLog: config.registry.accessLogFile
          ? createAccessLog({ file: config.registry.accessLogFile })
          : null,
        proxy,
      })
    : null;
  const stopRegistrySources = registry
    ? startRegistrySources(config.registry, registry.store)
    : () => {};

  const server = createServer((req, res) => {
    const url = req.url ?? "/";

    // Served here rather than proxied: a node enrolling for the first time
    // has no session key, so this route cannot live behind the agent server.
    if (registry && isRegistryRequest(req)) {
      registry.handle(req, res).catch((err) => {
        console.error(`Registry error for ${logSafeUrl(url)}:`, err);
        res.destroy();
      });
      return;
    }

    if (backendProxy && isBackendProxyRequest(req)) {
      backendProxy.handle(req, res).catch((err) => {
        console.error(`Backend proxy error for ${logSafeUrl(url)}:`, err);
        res.destroy();
      });
      return;
    }

    const backend = route(url);

    if (!backend) {
      res.writeHead(503);
      res.end("No backend configured for this route");
      return;
    }

    // See the matching note in static-server.mjs: the editor's URL carries
    // agent-server's session key as a query parameter, so the document must
    // not send a Referer on the subresources the workbench loads.
    if (noReferrerPrefixes.some((prefix) => matchesPathPrefix(url, prefix))) {
      res.setHeader("Referrer-Policy", "no-referrer");
    }

    if (
      config.runtimeServicesInfo &&
      isServerInfoRequest(req) &&
      (req.method === "GET" || req.method === "HEAD")
    ) {
      proxyServerInfoRequest(req, res, backend, config.runtimeServicesInfo);
      return;
    }

    proxy.proxyHttp(req, res, backend);
  });

  // Handle WebSocket upgrades
  server.on("upgrade", (req, socket, head) => {
    if (backendProxy && isBackendProxyRequest(req)) {
      backendProxy
        .handleUpgrade(req, socket, head)
        .catch(() => socket.destroy());
      return;
    }

    const backend = route(req.url ?? "/");

    if (!backend) {
      socket.destroy();
      return;
    }

    proxy.proxyWebSocket(req, socket, head, backend);
  });

  // Built-in protection against malformed client requests that can otherwise
  // bubble up as unhandled errors on the underlying TCP socket.
  server.on("clientError", (err, socket) => {
    if (!isBenignSocketError(err)) {
      console.error("Client error:", err.message);
    }
    if (socket.writable) {
      socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    } else {
      socket.destroy();
    }
  });
  server.on("close", () => {
    uninstallDiagnostics();
    stopRegistrySources();
  });

  server.listen(config.port, () => {
    console.log("");
    console.log(
      "╔═══════════════════════════════════════════════════════════════╗",
    );
    console.log(
      "║  Ingress Proxy                                                ║",
    );
    console.log(
      "╠═══════════════════════════════════════════════════════════════╣",
    );
    console.log(
      `║  Listening on: http://localhost:${config.port}/`.padEnd(66) + "║",
    );
    console.log(
      "╠═══════════════════════════════════════════════════════════════╣",
    );
    console.log(
      "║  Routes:                                                      ║",
    );

    const sortedRoutes = Object.entries(config.routes).sort(
      ([a], [b]) => b.length - a.length,
    );
    for (const [path, backend] of sortedRoutes) {
      const line = `    ${path} → ${backend}`;
      console.log(`║  ${line.padEnd(61)}║`);
    }

    if (config.defaultBackend) {
      const line = `    * (default) → ${config.defaultBackend}`;
      console.log(`║  ${line.padEnd(61)}║`);
    }

    if (registry) {
      const line = `    /api/registry → ${config.registry.agentServerUrl}`;
      console.log(`║  ${line.padEnd(61)}║`);
      const provider = config.registry.secretProvider ?? "none";
      const proxyLine = `    /backend/:id → fleet (secrets: ${provider})`;
      console.log(`║  ${proxyLine.padEnd(61)}║`);
    }

    console.log(
      "║                                                               ║",
    );
    console.log(
      "╚═══════════════════════════════════════════════════════════════╝",
    );
    console.log("");
  });

  return server;
}

// ═══════════════════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════════════════

const isMainModule =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  const args = parseArgs();
  const config = buildConfig(args);

  if (Object.keys(config.routes).length === 0 && !config.defaultBackend) {
    console.error(
      "Error: No routes configured. Use --route or --default options.",
    );
    console.error("Run with --help for usage information.");
    process.exit(1);
  }

  startIngress(config);

  // Handle graceful shutdown
  process.on("SIGINT", () => {
    console.log("\nShutting down...");
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    console.log("\nShutting down...");
    process.exit(0);
  });
}
