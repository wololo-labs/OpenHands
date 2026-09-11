import { createServer, request, type Server } from "node:http";
import { connect as netConnect, type AddressInfo, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { spawn, type ChildProcess } from "node:child_process";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it, beforeAll, afterAll, afterEach } from "vitest";

import { http, passthrough } from "msw";

import { server as mswServer } from "#/mocks/node";
import {
  canonicalPayload,
  fingerprintFromPublicKey,
} from "../../scripts/registry/enrolment.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const ingressScript = path.join(repoRoot, "scripts", "ingress.mjs");
const loopbackHost = "127.0.0.1";

function originForPort(port: number) {
  return `http://${loopbackHost}:${port}`;
}

function serverPort(server: Server) {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected server to be listening on a TCP port");
  }
  return (address as AddressInfo).port;
}

async function listenOnLoopback(server: Server) {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("error", onError);
      reject(error);
    };
    server.once("error", onError);
    server.listen(0, loopbackHost, () => {
      server.off("error", onError);
      resolve();
    });
  });
  return serverPort(server);
}

async function closeServer(server?: Server) {
  if (!server?.listening) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function getFreePort() {
  const server = createServer();
  try {
    return await listenOnLoopback(server);
  } finally {
    await closeServer(server);
  }
}

async function canConnect(port: number) {
  return new Promise<boolean>((resolve) => {
    const socket = netConnect({ host: loopbackHost, port });
    let settled = false;
    const finish = (connected: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(connected);
    };
    socket.setTimeout(500);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
  });
}

async function waitForPort(port: number, child?: ChildProcess) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) {
      throw new Error(
        `Process exited before port ${port} was ready: ${child.exitCode}`,
      );
    }
    if (await canConnect(port)) {
      return;
    }
    await delay(50);
  }
  throw new Error(`Timed out waiting for port ${port}`);
}

async function getJson(url: string) {
  return new Promise<{ status: number; body: unknown }>((resolve, reject) => {
    const req = request(url, { method: "GET" }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        try {
          resolve({
            status: res.statusCode ?? 0,
            body: JSON.parse(body),
          });
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

async function getText(url: string) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request(url, { method: "GET" }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        resolve({
          status: res.statusCode ?? 0,
          body,
        });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

async function stopChild(child?: ChildProcess) {
  if (!child || child.exitCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  const exited = once(child, "exit");
  const result = await Promise.race([
    exited.then(() => "exit" as const),
    delay(2000).then(() => "timeout" as const),
  ]);
  if (result === "timeout" && child.exitCode === null) {
    child.kill("SIGKILL");
    await Promise.race([exited, delay(1000)]);
  }
}

describe("ingress.mjs CLI", () => {
  it("shows help with --help flag", async () => {
    const child = spawn(process.execPath, [ingressScript, "--help"], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });

    const [code] = await once(child, "exit");

    expect(code).toBe(0);
    expect(output).toContain("Standalone Ingress / Reverse Proxy");
    expect(output).toContain("--port");
    expect(output).toContain("--route");
    expect(output).toContain("--default");
  });

  it("exits with error when no routes configured", async () => {
    const child = spawn(process.execPath, [ingressScript], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    const [code] = await once(child, "exit");

    expect(code).toBe(1);
    expect(stderr).toContain("No routes configured");
  });

  it("parses --port argument correctly", async () => {
    const port = await getFreePort();
    const child = spawn(
      process.execPath,
      [
        ingressScript,
        "--port",
        port.toString(),
        "--default",
        "http://localhost:3000",
      ],
      {
        cwd: repoRoot,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });

    await waitForPort(port, child);
    await stopChild(child);

    expect(output).toContain(port.toString());
  });

  it("parses --route arguments correctly", async () => {
    const port = await getFreePort();
    const child = spawn(
      process.execPath,
      [
        ingressScript,
        "--port",
        port.toString(),
        "--route",
        "/api=http://localhost:8000",
        "--route",
        "/static=http://localhost:3000",
      ],
      {
        cwd: repoRoot,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });

    await waitForPort(port, child);
    await stopChild(child);

    expect(output).toContain("/api");
    expect(output).toContain("http://localhost:8000");
    expect(output).toContain("/static");
    expect(output).toContain("http://localhost:3000");
  });

  it("writes the access log the --registry-access-log flag names", async () => {
    // The unit tests cover the log module; this covers the wiring between the
    // flag and it, which is the seam nothing else exercises.
    const logDir = await mkdtemp(path.join(tmpdir(), "ingress-access-log-"));
    const logFile = path.join(logDir, "evidence", "proxy-access.jsonl");

    // Stands in for the agent server the registry stores its entries in.
    const registryStore = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ misc_settings: { fleet_backends: { entries: [] } } }),
      );
    });
    const storePort = await listenOnLoopback(registryStore);
    const port = await getFreePort();

    const child = spawn(
      process.execPath,
      [
        ingressScript,
        "--port",
        port.toString(),
        "--default",
        originForPort(storePort),
        "--registry-session-key",
        "master-key",
        "--registry-agent-server",
        originForPort(storePort),
        "--registry-access-log",
        logFile,
      ],
      { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] },
    );

    try {
      await waitForPort(port, child);
      // Unauthenticated, so it never reaches a backend and needs no secret
      // provider -- but it is a request the proxy handled, so it is recorded.
      await fetch(`${originForPort(port)}/backend/some-entry/api/settings`);
      await delay(200);

      const lines = (await readFile(logFile, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(lines).toEqual([
        expect.objectContaining({
          url: "/backend/some-entry/api/settings",
          outcome: "refused:401",
          error: "unauthorized",
        }),
      ]);
    } finally {
      await stopChild(child);
      registryStore.close();
      await rm(logDir, { recursive: true, force: true });
    }
  });
});

describe("ingress proxy functionality", () => {
  let backend1: Server;
  let backend2: Server;
  let ingressProcess: ChildProcess;
  let backend1Port: number;
  let backend2Port: number;
  let ingressPort: number;

  beforeAll(async () => {
    // Create mock backend 1
    backend1 = createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ backend: 1, path: req.url }));
    });
    backend1Port = await listenOnLoopback(backend1);

    // Create mock backend 2
    backend2 = createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ backend: 2, path: req.url }));
    });
    backend2Port = await listenOnLoopback(backend2);

    // Start ingress
    ingressPort = await getFreePort();
    ingressProcess = spawn(
      process.execPath,
      [
        ingressScript,
        "--port",
        ingressPort.toString(),
        "--route",
        `/api/v2=${originForPort(backend2Port)}`,
        "--route",
        `/api=${originForPort(backend1Port)}`,
        "--default",
        originForPort(backend1Port),
      ],
      {
        cwd: repoRoot,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    await waitForPort(ingressPort, ingressProcess);
  });

  afterAll(async () => {
    await stopChild(ingressProcess);
    await closeServer(backend1);
    await closeServer(backend2);
  });

  it("routes /api requests to backend1", async () => {
    const response = await fetch(`${originForPort(ingressPort)}/api/test`);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.backend).toBe(1);
    expect(data.path).toBe("/api/test");
  });

  it("routes /api/v2 requests to backend2 (more specific route)", async () => {
    const response = await fetch(`${originForPort(ingressPort)}/api/v2/test`);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.backend).toBe(2);
    expect(data.path).toBe("/api/v2/test");
  });

  it("routes unmatched paths to default backend", async () => {
    const response = await fetch(`${originForPort(ingressPort)}/other/path`);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.backend).toBe(1);
    expect(data.path).toBe("/other/path");
  });

  it("preserves query parameters", async () => {
    const response = await fetch(
      `${originForPort(ingressPort)}/api/test?foo=bar&baz=123`,
    );
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.path).toBe("/api/test?foo=bar&baz=123");
  });

  it("returns 502 when backend is unavailable", async () => {
    // Start a fresh ingress pointing to a non-existent backend
    const badBackendPort = await getFreePort();
    const badIngressPort = await getFreePort();
    const badIngress = spawn(
      process.execPath,
      [
        ingressScript,
        "--port",
        badIngressPort.toString(),
        "--default",
        originForPort(badBackendPort),
      ],
      {
        cwd: repoRoot,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    await waitForPort(badIngressPort, badIngress);

    try {
      const response = await fetch(`${originForPort(badIngressPort)}/test`);
      expect(response.status).toBe(502);
      const text = await response.text();
      expect(text).toContain("Bad Gateway");
    } finally {
      await stopChild(badIngress);
    }
  });

  it("returns 502 when backend target URL is invalid", async () => {
    const badIngressPort = await getFreePort();
    const badIngress = spawn(
      process.execPath,
      [
        ingressScript,
        "--port",
        badIngressPort.toString(),
        "--default",
        "not-a-url",
      ],
      {
        cwd: repoRoot,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let stderr = "";
    badIngress.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    await waitForPort(badIngressPort, badIngress);

    try {
      const response = await getText(`${originForPort(badIngressPort)}/test`);
      await delay(100);

      expect(response.status).toBe(502);
      expect(response.body).toContain("Bad Gateway");
      expect(response.body).toContain("Invalid URL");
      expect(badIngress.exitCode).toBeNull();
      expect(stderr).toContain("Invalid URL");
    } finally {
      await stopChild(badIngress);
    }
  });

  it("adds runtime_services to proxied /server_info", async () => {
    const serverInfoBackend = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ version: "1.28.0" }));
    });
    const serverInfoBackendPort = await listenOnLoopback(serverInfoBackend);
    const runtimeIngressPort = await getFreePort();
    const runtimeServicesInfo = JSON.stringify({
      mode: "dev:automation",
      services: {
        agent_server: { url_from_agent: "http://localhost:18000" },
        automation: { url_from_agent: "http://localhost:18001" },
      },
    });
    const runtimeIngress = spawn(
      process.execPath,
      [
        ingressScript,
        "--port",
        runtimeIngressPort.toString(),
        "--runtime-services-info",
        runtimeServicesInfo,
        "--route",
        `/server_info=${originForPort(serverInfoBackendPort)}`,
      ],
      {
        cwd: repoRoot,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    await waitForPort(runtimeIngressPort, runtimeIngress);

    try {
      const response = await getJson(
        `${originForPort(runtimeIngressPort)}/server_info`,
      );
      const body = response.body as {
        version?: string;
        runtime_services?: unknown;
      };

      expect(response.status).toBe(200);
      expect(body.version).toBe("1.28.0");
      expect(body.runtime_services).toEqual(JSON.parse(runtimeServicesInfo));
    } finally {
      await stopChild(runtimeIngress);
      await closeServer(serverInfoBackend);
    }
  });

  it("returns 502 when intercepted /server_info target URL is invalid", async () => {
    const runtimeIngressPort = await getFreePort();
    const runtimeServicesInfo = JSON.stringify({
      mode: "dev:automation",
      services: {},
    });
    const runtimeIngress = spawn(
      process.execPath,
      [
        ingressScript,
        "--port",
        runtimeIngressPort.toString(),
        "--runtime-services-info",
        runtimeServicesInfo,
        "--route",
        "/server_info=not-a-url",
      ],
      {
        cwd: repoRoot,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let stderr = "";
    runtimeIngress.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    await waitForPort(runtimeIngressPort, runtimeIngress);

    try {
      const response = await getText(
        `${originForPort(runtimeIngressPort)}/server_info`,
      );
      await delay(100);

      expect(response.status).toBe(502);
      expect(response.body).toContain("Bad Gateway");
      expect(response.body).toContain("Invalid backend URL");
      expect(runtimeIngress.exitCode).toBeNull();
      expect(stderr).toContain("Invalid backend URL");
    } finally {
      await stopChild(runtimeIngress);
    }
  });
});

describe("ingress route matching", () => {
  let backend: Server;
  let ingressProcess: ChildProcess;
  let backendPort: number;
  let ingressPort: number;

  beforeAll(async () => {
    backend = createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(req.url);
    });
    backendPort = await listenOnLoopback(backend);

    ingressPort = await getFreePort();
    ingressProcess = spawn(
      process.execPath,
      [
        ingressScript,
        "--port",
        ingressPort.toString(),
        "--route",
        `/api/automation=${originForPort(backendPort)}`,
        "--route",
        `/api=${originForPort(backendPort)}`,
        "--route",
        `/sockets=${originForPort(backendPort)}`,
      ],
      {
        cwd: repoRoot,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    await waitForPort(ingressPort, ingressProcess);
  });

  afterAll(async () => {
    await stopChild(ingressProcess);
    await closeServer(backend);
  });

  it("matches exact path", async () => {
    const response = await fetch(`${originForPort(ingressPort)}/api`);
    expect(response.status).toBe(200);
  });

  it("matches path with trailing content", async () => {
    const response = await fetch(`${originForPort(ingressPort)}/api/users`);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toBe("/api/users");
  });

  it("matches longer prefix before shorter", async () => {
    const response = await fetch(
      `${originForPort(ingressPort)}/api/automation/docs`,
    );
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toBe("/api/automation/docs");
  });

  it("matches path with query string", async () => {
    const response = await fetch(`${originForPort(ingressPort)}/api?foo=bar`);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toBe("/api?foo=bar");
  });

  it("returns 503 for unmatched routes with no default", async () => {
    const response = await fetch(`${originForPort(ingressPort)}/unknown`);
    expect(response.status).toBe(503);
  });
});

describe("ingress socket-error resilience", () => {
  // Regression coverage for crashes like:
  //   Error: read ECONNRESET ... Emitted 'error' event on Socket instance
  // which previously took down the whole ingress process when a WebSocket's
  // underlying TCP socket reset.
  let upstream: Server;
  let upstreamSockets: Duplex[];
  let ingressProcess: ChildProcess;
  let ingressStderr: string;
  let upstreamPort: number;
  let ingressPort: number;

  beforeAll(async () => {
    upstreamSockets = [];

    upstream = createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
    });

    // Accept WebSocket upgrades, immediately RST the upstream socket on the
    // next tick. This reproduces the production crash without requiring a
    // real WebSocket handshake handler.
    upstream.on("upgrade", (_req, socket) => {
      upstreamSockets.push(socket);
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n\r\n",
      );
      // Force a TCP RST instead of a clean FIN to mirror ECONNRESET.
      setImmediate(() => {
        const s = socket as Duplex & { resetAndDestroy?: () => void };
        if (typeof s.resetAndDestroy === "function") {
          s.resetAndDestroy();
        } else {
          s.destroy(
            Object.assign(new Error("forced reset"), { code: "ECONNRESET" }),
          );
        }
      });
    });

    upstreamPort = await listenOnLoopback(upstream);

    ingressPort = await getFreePort();
    ingressStderr = "";
    ingressProcess = spawn(
      process.execPath,
      [
        ingressScript,
        "--port",
        ingressPort.toString(),
        "--default",
        originForPort(upstreamPort),
      ],
      {
        cwd: repoRoot,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    ingressProcess.stderr?.on("data", (chunk) => {
      ingressStderr += chunk.toString();
    });

    await waitForPort(ingressPort, ingressProcess);
  });

  afterAll(async () => {
    await stopChild(ingressProcess);
    for (const s of upstreamSockets) {
      try {
        s.destroy();
      } catch {
        // ignore
      }
    }
    await closeServer(upstream);
  });

  function openWebSocketHandshake(port: number): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const sock = netConnect({ host: "127.0.0.1", port }, () => {
        sock.write(
          "GET /sockets/events/test HTTP/1.1\r\n" +
            `Host: 127.0.0.1:${port}\r\n` +
            "Upgrade: websocket\r\n" +
            "Connection: Upgrade\r\n" +
            "Sec-WebSocket-Version: 13\r\n" +
            "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
        );
        resolve(sock);
      });
      // The upstream RST will surface here as ECONNRESET; we just want the
      // handshake to be initiated, so swallow any error after that.
      sock.on("error", () => {});
      sock.once("error", reject);
    });
  }

  it("survives upstream WebSocket ECONNRESET without crashing", async () => {
    // Trigger the bug repeatedly to make sure no path crashes the proxy.
    for (let i = 0; i < 5; i++) {
      const client = await openWebSocketHandshake(ingressPort);
      // Wait long enough for the upstream RST to propagate through the proxy.
      await delay(150);
      client.destroy();
      await delay(50);
    }

    // Process must still be alive.
    expect(ingressProcess.exitCode).toBeNull();
    expect(ingressProcess.signalCode).toBeNull();

    // And it must still be serving HTTP traffic.
    const response = await fetch(`${originForPort(ingressPort)}/health`);
    expect(response.status).toBe(200);

    // The unhandled-error crash signature must not appear in stderr.
    expect(ingressStderr).not.toContain("Unhandled 'error' event");
    expect(ingressStderr).not.toMatch(/throw er;/);
  });

  it("survives client aborting an in-flight HTTP request", async () => {
    // Open and abruptly destroy a TCP connection mid-request to make sure
    // req/res 'error' events on the client side are handled.
    const client = netConnect({ host: "127.0.0.1", port: ingressPort }, () => {
      client.write(
        "GET /something HTTP/1.1\r\n" +
          `Host: 127.0.0.1:${ingressPort}\r\n` +
          "Connection: close\r\n\r\n",
      );
      // Reset before the upstream finishes responding.
      setImmediate(() => client.destroy());
    });
    client.on("error", () => {});

    await delay(200);

    expect(ingressProcess.exitCode).toBeNull();
    expect(ingressProcess.signalCode).toBeNull();
    expect(ingressStderr).not.toContain("Unhandled 'error' event");
  });
});

describe("ingress --no-referrer-prefix", () => {
  // The editor is advertised as `<origin><prefix>/?tkn=<token>`, and
  // agent-server derives that token from session_api_keys[0] — the same secret
  // that authenticates /api. The workbench then loads webviews, previews and
  // extension content from that document, so without a Referrer-Policy the
  // token rides along on each of those subrequests.
  let backend: Server | undefined;
  let ingressProcess: ChildProcess | undefined;
  let ingressPort: number;

  beforeAll(async () => {
    backend = createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ path: req.url }));
    });
    const backendPort = await listenOnLoopback(backend);

    ingressPort = await getFreePort();
    ingressProcess = spawn(
      process.execPath,
      [
        ingressScript,
        "--port",
        ingressPort.toString(),
        "--route",
        `/vscode=${originForPort(backendPort)}`,
        "--route",
        `/api=${originForPort(backendPort)}`,
        "--no-referrer-prefix",
        "/vscode",
      ],
      { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] },
    );

    await waitForPort(ingressPort, ingressProcess);
  });

  afterAll(async () => {
    await stopChild(ingressProcess);
    await closeServer(backend);
  });

  it("sets no-referrer on the editor prefix", async () => {
    const response = await fetch(
      `${originForPort(ingressPort)}/vscode/?tkn=secret`,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("covers assets under the prefix, which is where the leak would happen", async () => {
    const response = await fetch(
      `${originForPort(ingressPort)}/vscode/static/out/vs/workbench/workbench.web.main.js`,
    );

    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("leaves other routes alone", async () => {
    // Deliberately scoped rather than a blanket policy for the origin: the
    // canvas itself is served here too, and its outbound requests are not the
    // problem being solved.
    const response = await fetch(`${originForPort(ingressPort)}/api/anything`);

    expect(response.status).toBe(200);
    expect(response.headers.get("referrer-policy")).toBeNull();
  });
});

describe("ingress fleet registry", () => {
  let agentServer: Server;
  let ingressProcess: ChildProcess | undefined;
  let ingressPort: number;
  let settingsWrites: unknown[];
  let miscSettings: Record<string, unknown>;

  function sshPublicKeyLine(publicKey: KeyObject) {
    // SPKI DER for Ed25519 is a 12-byte header followed by the raw key bytes.
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

  async function startIngressProcess(extraArgs: string[]) {
    ingressPort = await getFreePort();
    ingressProcess = spawn(
      process.execPath,
      [
        ingressScript,
        "--port",
        ingressPort.toString(),
        "--route",
        `/api=${originForPort(serverPort(agentServer))}`,
        ...extraArgs,
      ],
      { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] },
    );
    await waitForPort(ingressPort, ingressProcess);
    // The suite-wide MSW handlers answer `*/api/registry` on any origin, which
    // would reply for the spawned ingress too. Let its origin through so these
    // assertions see what the ingress actually served.
    mswServer.use(
      http.all(`${originForPort(ingressPort)}/*`, () => passthrough()),
    );
  }

  beforeAll(async () => {
    settingsWrites = [];
    miscSettings = { app_preferences: { language: "en" } };
    agentServer = createServer((req, res) => {
      void (async () => {
        if (req.url !== "/api/settings") {
          res.writeHead(404).end("agent server: not found");
          return;
        }
        if (req.method === "PATCH") {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk as Buffer);
          const diff =
            JSON.parse(Buffer.concat(chunks).toString("utf8"))
              .misc_settings_diff ?? {};
          settingsWrites.push(diff);
          miscSettings = { ...miscSettings, ...diff };
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ misc_settings: miscSettings }));
      })();
    });
    await listenOnLoopback(agentServer);
  });

  afterEach(async () => {
    await stopChild(ingressProcess);
    ingressProcess = undefined;
  });

  afterAll(async () => {
    await closeServer(agentServer);
  });

  it("proxies /api/registry to the backend when the registry is disabled", async () => {
    await startIngressProcess([]);

    const response = await fetch(`${originForPort(ingressPort)}/api/registry`);

    // The agent server has no such route, so a 404 from it proves the ingress
    // did not start serving the path itself.
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("agent server: not found");
  });

  it("serves the registry in-process once a session key is configured", async () => {
    await startIngressProcess(["--registry-session-key", "ingress-test-key"]);
    const origin = originForPort(ingressPort);

    const unauthorized = await fetch(`${origin}/api/registry`);
    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.json()).toMatchObject({ error: "unauthorized" });

    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const body = {
      name: "hetzner",
      host: "https://claude-hetzner.example.ts.net:8443",
      pubkey: sshPublicKeyLine(publicKey),
      credRef: "openhands/hetzner/session-key",
      version: "1.44.0",
      nonce: "ingress-nonce-1",
      ts: Math.floor(Date.now() / 1000),
    };
    const registered = await fetch(`${origin}/api/registry/register`, {
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

    expect(registered.status).toBe(201);
    expect(await registered.json()).toMatchObject({ state: "pending" });
    expect(settingsWrites.at(-1)).toMatchObject({
      fleet_backends: { entries: [{ name: "hetzner", state: "pending" }] },
    });

    const listed = await fetch(`${origin}/api/registry`, {
      headers: { "X-Session-API-Key": "ingress-test-key" },
    });
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({
      entries: [{ name: "hetzner", state: "pending" }],
    });
  });

  it("auto-approves a pre-seeded fingerprint", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const pubkey = sshPublicKeyLine(publicKey);
    await startIngressProcess([
      "--registry-session-key",
      "ingress-test-key",
      "--registry-preseed",
      `${fingerprintFromPublicKey(pubkey)},SHA256:someOtherHost`,
    ]);

    const body = {
      name: "preseeded",
      host: "https://preseeded.example.ts.net:8443",
      pubkey,
      nonce: "ingress-nonce-2",
      ts: Math.floor(Date.now() / 1000),
    };
    const registered = await fetch(
      `${originForPort(ingressPort)}/api/registry/register`,
      {
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
      },
    );

    expect(registered.status).toBe(201);
    expect(await registered.json()).toMatchObject({ state: "active" });
  });
});
