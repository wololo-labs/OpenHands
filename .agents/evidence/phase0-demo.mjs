// Phase 0 end-to-end demo: a real `scripts/ingress.mjs` process, a real fleet
// node standing in for hetzner, and the access log it writes.
import { spawn } from "node:child_process";
import http from "node:http";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = mkdtempSync(path.join(tmpdir(), "phase0-demo-"));
const home = path.join(root, "home");
const logFile = path.join(root, "evidence", "proxy-access.jsonl");
mkdirSync(path.join(home, ".openhands", "agent-canvas", "secrets"), {
  recursive: true,
});

const MASTER_KEY = "master-demo-key";
const NODE_KEY = "node-demo-key-do-not-log";
const FPR = "SHA256:zCJmiJ7wModXHdGhaB0xktp+IBjT0NsgiNJaQtiIMHw";
const ID = "demo-entry";

const listen = (server) =>
  new Promise((r) =>
    server.listen(0, "127.0.0.1", () => r(server.address().port)),
  );

// The fleet node. Answers only with the node's own key.
const nodeSeen = [];
const node = createServer((req, res) => {
  nodeSeen.push({ url: req.url, key: req.headers["x-session-api-key"] });
  res.writeHead(req.headers["x-session-api-key"] === NODE_KEY ? 200 : 401, {
    "Content-Type": "application/json",
  });
  res.end(JSON.stringify({ url: req.url }));
});
node.on("upgrade", (req, socket) => {
  nodeSeen.push({ url: req.url, key: req.headers["x-session-api-key"] });
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
  );
});
const nodePort = await listen(node);

// The agent server the registry stores itself in.
let settings = { misc_settings: {} };
const agent = createServer((req, res) => {
  if (req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(settings));
    return;
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const diff = JSON.parse(body).misc_settings_diff ?? {};
    settings.misc_settings = { ...settings.misc_settings, ...diff };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(settings));
  });
});
const agentPort = await listen(agent);

settings.misc_settings.fleet_backends = {
  entries: [
    {
      id: ID,
      name: "claude-hetzner",
      host: `http://127.0.0.1:${nodePort}`,
      fingerprint: FPR,
      credRef: `openhands/${ID}/session-key`,
      state: "active",
      version: "1.44.0",
    },
    {
      id: "revoked-entry",
      name: "old-node",
      host: `http://127.0.0.1:${nodePort}`,
      fingerprint: "SHA256:gone",
      credRef: `openhands/revoked/session-key`,
      state: "revoked",
      version: "1.44.0",
    },
  ],
};

// The node's key, placed into the master's file provider out of band.
const secretFile = path.join(
  home,
  ".openhands",
  "agent-canvas",
  "secrets",
  "openhands",
  ID,
  "session-key",
);
mkdirSync(path.dirname(secretFile), { recursive: true });
writeFileSync(secretFile, `${NODE_KEY}\n`, { mode: 0o600 });

const ingress = spawn(
  "node",
  [
    "scripts/ingress.mjs",
    "--port",
    "39777",
    "--route",
    `/api=http://127.0.0.1:${agentPort}`,
    "--registry-session-key",
    MASTER_KEY,
    "--registry-agent-server",
    `http://127.0.0.1:${agentPort}`,
    "--registry-secret-provider",
    "file",
    "--registry-access-log",
    logFile,
  ],
  { env: { ...process.env, HOME: home }, stdio: ["ignore", "pipe", "pipe"] },
);
ingress.stdout.on("data", (d) => process.stdout.write(`[ingress] ${d}`));
ingress.stderr.on("data", (d) => process.stdout.write(`[ingress] ${d}`));

const base = "http://127.0.0.1:39777";
for (let i = 0; i < 60; i++) {
  try {
    await fetch(`${base}/server_info`);
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 200));
  }
}

console.log(
  "\n=== 1. canvas reaches the node with a credential it never held ===",
);
const ok = await fetch(
  `${base}/backend/${ID}/api/conversations/conv-demo/events/search?limit=5`,
  {
    headers: { "X-Session-API-Key": MASTER_KEY },
  },
);
console.log(
  `HTTP ${ok.status}; node saw key=${nodeSeen.at(-1).key === NODE_KEY ? "the node's own" : nodeSeen.at(-1).key}`,
);

console.log(
  "\n=== 2. a websocket upgrade, key in the query where a browser must put it ===",
);
await new Promise((resolve) => {
  const req = http.request(
    `${base}/backend/${ID}/sockets/events/conv-demo?session_api_key=${MASTER_KEY}&latest_event_id=-1`,
    {
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
      },
    },
  );
  req.on("upgrade", (_res, socket) => {
    socket.destroy();
    resolve();
  });
  req.on("response", (res) => {
    res.resume();
    resolve();
  });
  req.on("error", () => resolve());
  req.end();
});
console.log("upgrade completed");

console.log(
  "\n=== 3. a revoked entry is refused, and the refusal is recorded ===",
);
const denied = await fetch(`${base}/backend/revoked-entry/api/settings`, {
  headers: { "X-Session-API-Key": MASTER_KEY },
});
console.log(`HTTP ${denied.status} ${JSON.stringify(await denied.json())}`);

console.log("\n=== 4. an unauthenticated caller never reaches the node ===");
const anon = await fetch(`${base}/backend/${ID}/api/settings`);
console.log(`HTTP ${anon.status}`);

await new Promise((r) => setTimeout(r, 300));
console.log(`\n=== the access log at ${logFile} ===`);
const raw = readFileSync(logFile, "utf8");
for (const line of raw.trim().split("\n"))
  console.log(JSON.stringify(JSON.parse(line)));

console.log("\n=== credential leak check ===");
console.log(`master key in log: ${raw.includes(MASTER_KEY)}`);
console.log(`node key in log:   ${raw.includes(NODE_KEY)}`);

ingress.kill();
node.close();
agent.close();
process.exit(0);
