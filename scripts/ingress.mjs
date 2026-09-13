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
 *   INGRESS_HOST          - Interface to bind (default: 127.0.0.1)
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
  matchesPathPrefix,
  proxyServerInfoRequest,
} from "./proxy-utils.mjs";
import {
  buildRegistryConfig as buildSharedRegistryConfig,
  mountRegistry,
  parseFingerprintList,
} from "./registry/mount.mjs";

// ═══════════════════════════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Loopback, deliberately. This process mounts `/api/registry` and
 * `/backend/:id`, which hold the fleet's credentials, so "reachable from
 * anywhere on the network" is not a default it may have. An operator who
 * wants the previous behaviour asks for it: `--host 0.0.0.0`. The helm chart
 * does exactly that, because in a cluster the Service is the boundary.
 */
const DEFAULT_HOST = "127.0.0.1";

function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    port: 8000,
    host: null,
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
    registrySourceIntervalMs: null,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "-p":
      case "--port":
        config.port = parseInt(args[++i], 10);
        break;
      case "--host":
        config.host = args[++i] || null;
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
      case "--registry-source-interval":
        config.registrySourceIntervalMs = Number(args[++i]) || null;
        break;
      case "-h":
      case "--help":
        showHelp();
        process.exit(0);
    }
  }

  return config;
}

function showHelp() {
  console.log(`
Standalone Ingress / Reverse Proxy

Routes HTTP requests to multiple backends based on URL path prefix.

USAGE:
  node scripts/ingress.mjs [options]

OPTIONS:
  -p, --port <port>           Port to listen on (default: 8000)
      --host <host>           Interface to bind (default: 127.0.0.1). Until
                              this flag existed the ingress bound every
                              interface; pass --host 0.0.0.0 to ask for that
                              back. It serves /api/registry and /backend/:id,
                              so binding wide is a decision, not a default.
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
  --registry-source-interval <ms>
                              How often a pull source re-reads its directory
                              (default: 60000)
  -h, --help                  Show this help

ENVIRONMENT VARIABLES:
  INGRESS_PORT                Port to listen on
  INGRESS_HOST                Interface to bind (default: 127.0.0.1)
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
  REGISTRY_SOURCE_INTERVAL_MS How often a pull source re-reads its directory

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
    host: args.host || env.INGRESS_HOST || DEFAULT_HOST,
    routes,
    defaultBackend,
    noReferrerPrefixes: args.noReferrerPrefixes ?? [],
    runtimeServicesInfo:
      args.runtimeServicesInfo || env.INGRESS_RUNTIME_SERVICES_INFO || null,
    registry: buildSharedRegistryConfig(
      {
        sessionKey: args.registrySessionKey,
        agentServerUrl: args.registryAgentServer,
        preseed: args.registryPreseed,
        secretProvider: args.registrySecretProvider,
        allowUncredentialed: args.registryAllowUncredentialed,
        accessLog: args.registryAccessLog,
        sources: args.registrySources,
        sourceIntervalMs: args.registrySourceIntervalMs,
      },
      env,
      createRouter(routes, defaultBackend),
    ),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Server
// ═══════════════════════════════════════════════════════════════════════════

export function startIngress(config) {
  const route = createRouter(config.routes, config.defaultBackend);
  const proxy = createProxyHandlers({ label: `ingress:${config.port}` });
  const uninstallDiagnostics = proxy.installDiagnostics();

  const noReferrerPrefixes = config.noReferrerPrefixes ?? [];
  const registry = mountRegistry(config.registry, { proxy });

  const server = createServer((req, res) => {
    const url = req.url ?? "/";

    if (registry?.handle(req, res)) return;

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
    if (registry?.handleUpgrade(req, socket, head)) return;

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
    registry?.stop();
  });

  server.listen(config.port, config.host ?? DEFAULT_HOST, () => {
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
      `║  Listening on: http://${config.host ?? DEFAULT_HOST}:${config.port}/`.padEnd(
        66,
      ) + "║",
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
