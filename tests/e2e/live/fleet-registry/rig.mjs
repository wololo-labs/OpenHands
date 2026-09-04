#!/usr/bin/env node
/**
 * Live rig for the fleet registry.
 *
 * Stands up a throwaway master stack (agent server + ingress + registry +
 * injecting proxy + static canvas) and a throwaway second agent server, enrols
 * two real nodes into it, and writes everything the Playwright spec needs to
 * `.tmp/fleet-rig.json`.
 *
 *   node tests/e2e/live/fleet-registry/rig.mjs up
 *   node tests/e2e/live/fleet-registry/rig.mjs status
 *   node tests/e2e/live/fleet-registry/rig.mjs down
 *
 * The fleet is exactly two entries:
 *
 *   node 1  a real remote agent server, pre-seeded, lands `active`
 *   node 2  a local throwaway agent server with a generated key, not
 *           pre-seeded, lands `pending`
 *
 * Isolation is the point of the shape here. Every process runs on a random
 * port in 39000-39999, writes under `$TMPDIR/fleet-rig-<ts>`, and runs with
 * `HOME` pointed inside that directory so the `file` secret provider and
 * `--generate-key` cannot reach the operator's real `~/.openhands`. Teardown
 * kills recorded PIDs only; there is no pattern-matched kill anywhere in this
 * file.
 *
 * The master reaches node 1 through an SSH tunnel rather than its published
 * tailnet URL because `tailscale serve` terminates TLS on the MagicDNS name
 * and MagicDNS does not resolve on every client (see docs/registry.md). The
 * tunnel is carried over the tailnet address, so the hop is still
 * machine-to-machine over the tailnet; only name resolution moves.
 */

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);
const POINTER_PATH = path.join(REPO_ROOT, ".tmp", "fleet-rig.json");
const PORT_RANGE = { min: 39000, max: 39999 };

const NODE1 = {
  name: process.env.FLEET_RIG_NODE1_NAME ?? "claude-hetzner",
  ssh: process.env.FLEET_RIG_NODE1_SSH ?? "claude@100.125.222.64",
  // Port the node's own ingress listens on, loopback-only on that host.
  port: process.env.FLEET_RIG_NODE1_PORT ?? "8000",
  keyPath:
    process.env.FLEET_RIG_NODE1_KEY_PATH ?? "/etc/ssh/ssh_host_ed25519_key",
  sessionKeyPath:
    process.env.FLEET_RIG_NODE1_SESSION_KEY_PATH ??
    "~/.openhands/canvas-api-key",
  stagingDir:
    process.env.FLEET_RIG_NODE1_STAGING_DIR ??
    "/home/claude/.cache/agent-canvas-enrol-rig",
};
const NODE2_NAME = "local-node-2";
const AGENT_SERVER_VERSION = JSON.parse(
  readFileSync(path.join(REPO_ROOT, "config", "defaults.json"), "utf8"),
).versions.agentServer;

// ───────────────────────────────────────────────────────────────────────────
// Small helpers
// ───────────────────────────────────────────────────────────────────────────

const log = (...parts) => console.log("[rig]", ...parts);

function sh(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} exited ${result.status}: ${(result.stderr || result.stdout || "").trim()}`,
    );
  }
  return result.stdout.trim();
}

function ssh(remoteCommand, { timeout = 60_000 } = {}) {
  return sh(
    "ssh",
    ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", NODE1.ssh, remoteCommand],
    { timeout },
  );
}

/**
 * Copies the enrolment client onto node 1. The node runs a released
 * `agent-canvas` that predates this branch, so the code under test has to be
 * the code that runs there — otherwise the rig would prove the old client
 * works. Only the enrolment half is copied; nothing installed on the node is
 * touched.
 */
function stageNode1() {
  const files = [
    "bin/enrol.mjs",
    "scripts/registry/sign.mjs",
    "scripts/registry/enrolment.mjs",
    "scripts/registry/store.mjs",
    "scripts/registry/secrets/",
  ];
  const tar = spawnSync("tar", ["czf", "-", ...files], {
    cwd: REPO_ROOT,
    encoding: "buffer",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (tar.status !== 0) {
    throw new Error(`could not package the enrolment client: ${tar.stderr}`);
  }
  const push = spawnSync(
    "ssh",
    [
      "-o",
      "BatchMode=yes",
      NODE1.ssh,
      `rm -rf ${NODE1.stagingDir} && mkdir -p ${NODE1.stagingDir} && tar xzf - -C ${NODE1.stagingDir}`,
    ],
    { input: tar.stdout, encoding: "buffer" },
  );
  if (push.status !== 0) {
    throw new Error(
      `could not stage the enrolment client on ${NODE1.name}: ${push.stderr}`,
    );
  }
  log(`staged the enrolment client on ${NODE1.name}`);
}

/** A free port in the rig's range, confirmed by binding it. */
async function freePort(taken) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const port =
      PORT_RANGE.min +
      Math.floor(Math.random() * (PORT_RANGE.max - PORT_RANGE.min + 1));
    if (taken.has(port)) continue;
    const available = await new Promise((resolve) => {
      const probe = createServer();
      probe.once("error", () => resolve(false));
      probe.listen(port, "0.0.0.0", () => probe.close(() => resolve(true)));
    });
    if (available) {
      taken.add(port);
      return port;
    }
  }
  throw new Error(`no free port in ${PORT_RANGE.min}-${PORT_RANGE.max}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Polls until `check` resolves truthy. Bounded, so a service that never comes
 * up fails the run instead of hanging it.
 */
async function waitFor(label, check, { timeoutMs = 90_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(500);
  }
  throw new Error(
    `timed out waiting for ${label}${lastError ? `: ${lastError}` : ""}`,
  );
}

async function httpStatus(url, init) {
  try {
    const response = await fetch(url, init);
    return response.status;
  } catch {
    return 0;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Process supervision
// ───────────────────────────────────────────────────────────────────────────

/**
 * Starts one long-running service in its own tmux session and records the
 * pane's PID. `exec` makes the pane process the service itself, so the
 * recorded PID is the thing teardown signals — never a pattern match.
 */
function startService(state, { name, command, env = {}, cwd = REPO_ROOT }) {
  const session = `${state.rigId}-${name}`;
  const logPath = path.join(state.dir, "logs", `${name}.log`);
  const exports = Object.entries(env)
    .map(([key, value]) => `${key}=${shellQuote(String(value))}`)
    .join(" ");

  sh("tmux", [
    "new-session",
    "-d",
    "-s",
    session,
    "-c",
    cwd,
    `exec env ${exports} ${command} >${shellQuote(logPath)} 2>&1`,
  ]);

  const pid = Number(
    sh("tmux", ["list-panes", "-t", session, "-F", "#{pane_pid}"]),
  );
  if (!Number.isInteger(pid) || pid <= 1) {
    throw new Error(`${name}: tmux reported an unusable pid ${pid}`);
  }
  state.services.push({ name, session, pid, logPath });
  log(`started ${name} (pid ${pid}, tmux ${session})`);
  return pid;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

/** SIGTERM, then SIGKILL, by recorded PID only. */
async function stopService({ name, session, pid }) {
  for (const signal of ["SIGTERM", "SIGKILL"]) {
    try {
      process.kill(pid, signal);
    } catch {
      break; // already gone
    }
    await sleep(signal === "SIGTERM" ? 1500 : 250);
    try {
      process.kill(pid, 0);
    } catch {
      break;
    }
  }
  // Named session only. Never `kill-server`, never a pattern.
  spawnSync("tmux", ["kill-session", "-t", session], { stdio: "ignore" });
  log(`stopped ${name} (pid ${pid})`);
}

// ───────────────────────────────────────────────────────────────────────────
// up
// ───────────────────────────────────────────────────────────────────────────

function agentServerCommand(port) {
  const v = AGENT_SERVER_VERSION;
  return [
    "uvx",
    `--from openhands-agent-server==${v}`,
    `--with openhands-sdk==${v}`,
    `--with openhands-tools==${v}`,
    `--with openhands-workspace==${v}`,
    "--with 'agent-client-protocol<0.11'",
    "--with 'posthog>=6,<7'",
    "agent-server --host 127.0.0.1 --port",
    String(port),
  ].join(" ");
}

/**
 * `HOME` moves into the rig so nothing can reach the operator's real
 * `~/.openhands`, while uv keeps pointing at the machine's existing caches —
 * otherwise every run re-downloads the whole agent-server environment.
 */
function agentServerEnv(stateRoot, sessionKey) {
  const realHome = process.env.HOME ?? "";
  return {
    ...baseEnv(),
    PYTHONUTF8: "1",
    HOME: path.join(stateRoot, "home"),
    UV_CACHE_DIR: process.env.UV_CACHE_DIR ?? path.join(realHome, ".cache", "uv"),
    UV_TOOL_DIR:
      process.env.UV_TOOL_DIR ?? path.join(realHome, ".local", "share", "uv", "tools"),
    UV_PYTHON_INSTALL_DIR:
      process.env.UV_PYTHON_INSTALL_DIR ??
      path.join(realHome, ".local", "share", "uv", "python"),
    OH_PERSISTENCE_DIR: path.join(stateRoot, ".openhands"),
    OH_CONVERSATIONS_PATH: path.join(stateRoot, ".openhands", "conversations"),
    OH_BASH_EVENTS_DIR: path.join(stateRoot, ".openhands", "bash_events"),
    OH_SESSION_API_KEYS_0: sessionKey,
    OH_SECRET_KEY: randomBytes(16).toString("hex"),
  };
}

/** The tmux server's environment is whatever it was started with, so every
 * service is given the parts it actually needs rather than inheriting them. */
function baseEnv() {
  return {
    PATH: process.env.PATH ?? "",
    LANG: process.env.LANG ?? "en_US.UTF-8",
    TMPDIR: process.env.TMPDIR ?? "/tmp",
  };
}

async function up() {
  const timestamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "")
    .replace("T", "-")
    .slice(0, 15);
  const dir = path.join(tmpdir(), `fleet-rig-${timestamp}`);
  const state = {
    rigId: `fleet-rig-${timestamp}`,
    dir,
    home: path.join(dir, "home"),
    startedAt: new Date().toISOString(),
    services: [],
    ports: {},
    keys: {},
    entries: {},
  };
  for (const sub of ["home", "logs", "evidence", "master", "node2"]) {
    mkdirSync(path.join(dir, sub), { recursive: true });
  }
  mkdirSync(path.join(dir, "master", "home"), { recursive: true });
  mkdirSync(path.join(dir, "node2", "home"), { recursive: true });
  log(`rig dir ${dir}`);

  const taken = new Set();
  state.ports = {
    masterAgentServer: await freePort(taken),
    node2AgentServer: await freePort(taken),
    static: await freePort(taken),
    ingress: await freePort(taken),
    node1Tunnel: await freePort(taken),
  };
  state.keys = {
    // Three distinct keys. Criterion 2 asserts no *node* key reaches the
    // browser; the master key legitimately does, so they must never collide.
    master: `master-${randomBytes(24).toString("hex")}`,
    node2: `node2-${randomBytes(24).toString("hex")}`,
    node1: ssh(`cat ${NODE1.sessionKeyPath}`),
  };
  if (!state.keys.node1 || state.keys.node1.length < 8) {
    throw new Error(`${NODE1.name}: session key at ${NODE1.sessionKeyPath} is unusable`);
  }
  log(`ports ${JSON.stringify(state.ports)}`);

  stageNode1();
  state.node1Fingerprint = ssh(
    `sudo -n node ${NODE1.stagingDir}/bin/enrol.mjs --print-fingerprint --key ${NODE1.keyPath}`,
  );
  log(`${NODE1.name} fingerprint ${state.node1Fingerprint}`);

  // ── processes ────────────────────────────────────────────────────────────
  startService(state, {
    name: "master-agent-server",
    command: agentServerCommand(state.ports.masterAgentServer),
    env: agentServerEnv(path.join(dir, "master"), state.keys.master),
    cwd: path.join(dir, "master"),
  });
  startService(state, {
    name: "node2-agent-server",
    command: agentServerCommand(state.ports.node2AgentServer),
    env: agentServerEnv(path.join(dir, "node2"), state.keys.node2),
    cwd: path.join(dir, "node2"),
  });
  startService(state, {
    name: "node1-tunnel",
    command: `ssh -N -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -L 127.0.0.1:${state.ports.node1Tunnel}:127.0.0.1:${NODE1.port} ${NODE1.ssh}`,
    env: { ...baseEnv(), HOME: process.env.HOME ?? "" },
  });
  startService(state, {
    name: "static",
    command: `node scripts/static-server.mjs --port ${state.ports.static} --dir build --session-api-key ${shellQuote(state.keys.master)}`,
    env: { ...baseEnv(), HOME: state.home, AGENT_CANVAS_DISABLE_TELEMETRY: "1" },
  });

  const agentServer = `http://127.0.0.1:${state.ports.masterAgentServer}`;
  startService(state, {
    name: "ingress",
    command: [
      "node scripts/ingress.mjs",
      `--port ${state.ports.ingress}`,
      ...[
        "/api",
        "/sockets",
        "/server_info",
        "/health",
        "/ready",
        "/alive",
        "/docs",
        "/redoc",
        "/openapi.json",
      ].map((prefix) => `--route ${prefix}=${agentServer}`),
      `--default http://127.0.0.1:${state.ports.static}`,
      `--registry-session-key ${shellQuote(state.keys.master)}`,
      `--registry-preseed ${shellQuote(state.node1Fingerprint)}`,
      "--registry-secret-provider file",
    ].join(" "),
    env: {
      ...baseEnv(),
      // Roots the `file` secret provider inside the rig; it defaults to
      // `~/.openhands/agent-canvas/secrets`, which this run must not touch.
      HOME: state.home,
    },
  });

  const base = `http://127.0.0.1:${state.ports.ingress}`;
  state.baseUrl = base;
  state.node2Url = `http://127.0.0.1:${state.ports.node2AgentServer}`;
  state.node1Url = `http://127.0.0.1:${state.ports.node1Tunnel}`;

  await waitFor(
    "master agent server",
    async () => (await httpStatus(`${agentServer}/server_info`)) === 200,
  );
  await waitFor(
    "node 2 agent server",
    async () => (await httpStatus(`${state.node2Url}/server_info`)) === 200,
  );
  await waitFor(
    `${NODE1.name} through the tunnel`,
    async () => (await httpStatus(`${state.node1Url}/server_info`)) === 200,
  );
  await waitFor(
    "ingress",
    async () => (await httpStatus(`${base}/server_info`)) === 200,
  );
  await waitFor("canvas", async () => (await httpStatus(`${base}/`)) === 200);

  writeState(state);
  await enrolBothNodes(state);
  writeState(state);

  log("rig is up");
  log(JSON.stringify(summary(state), null, 2));
  return state;
}

// ───────────────────────────────────────────────────────────────────────────
// Enrolment
// ───────────────────────────────────────────────────────────────────────────

async function registryEntries(state) {
  const response = await fetch(`${state.baseUrl}/api/registry`, {
    headers: { "X-Session-API-Key": state.keys.master },
  });
  if (!response.ok) {
    throw new Error(`registry list failed with ${response.status}`);
  }
  return (await response.json()).entries;
}

/**
 * Node 1 enrols from node 1, over the tailnet, signing with its real SSH host
 * key and publishing only a credential *reference*: the `file` provider is
 * master-local, so the key itself is placed into the master's provider out of
 * band rather than travelling with the registration.
 */
async function enrolNode1(state) {
  const masterUrl = `http://${tailnetAddress()}:${state.ports.ingress}`;
  const credRef = `openhands/${NODE1.name}/session-key`;
  const version = await remoteAgentServerVersion(state);
  const output = ssh(
    [
      `sudo -n node ${NODE1.stagingDir}/bin/enrol.mjs`,
      `--registry ${shellQuote(masterUrl)}`,
      `--name ${shellQuote(NODE1.name)}`,
      `--host ${shellQuote(state.node1Url)}`,
      `--cred-ref ${shellQuote(credRef)}`,
      `--key ${NODE1.keyPath}`,
      `--version ${shellQuote(version)}`,
    ].join(" "),
  );
  log(`${NODE1.name} enrol -> ${output}`);

  // Out-of-band credential placement: the provisioner's job in a real
  // deployment, and the reason the registration carries a reference only.
  writeSecret(state, credRef, state.keys.node1);
  return output;
}

/**
 * Node 2 has no SSH host key this process may read, so it enrols with a
 * generated one — the `--generate-key` path — and publishes its key through
 * the master's own `file` provider, which is the supported same-host case.
 */
function enrolNode2(state) {
  const output = sh(
    "node",
    [
      "bin/enrol.mjs",
      "--registry",
      state.baseUrl,
      "--name",
      NODE2_NAME,
      "--host",
      state.node2Url,
      "--secret-provider",
      "file",
      "--secret",
      state.keys.node2,
      "--generate-key",
      "--version",
      AGENT_SERVER_VERSION,
    ],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, HOME: state.home },
    },
  );
  log(`${NODE2_NAME} enrol -> ${output.split("\n")[0]}`);
  return output;
}

function writeSecret(state, ref, secret) {
  const filePath = path.join(state.home, ".openhands", "agent-canvas", "secrets", ref);
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  writeFileSync(filePath, `${secret}\n`, { mode: 0o600 });
  log(`placed credential ${ref}`);
}

async function enrolBothNodes(state) {
  await enrolNode1(state);
  enrolNode2(state);

  const entries = await registryEntries(state);
  for (const entry of entries) {
    if (entry.name === NODE1.name) state.entries.node1 = entry;
    if (entry.name === NODE2_NAME) state.entries.node2 = entry;
  }
  if (!state.entries.node1 || !state.entries.node2) {
    throw new Error(
      `expected both nodes in the registry, got ${entries.map((e) => e.name).join(", ") || "nothing"}`,
    );
  }
  state.node2Fingerprint = state.entries.node2.fingerprint;
}

/** The version node 1 actually reports, so the entry never claims a guess. */
async function remoteAgentServerVersion(state) {
  const response = await fetch(`${state.node1Url}/server_info`);
  if (!response.ok) {
    throw new Error(`${NODE1.name} /server_info returned ${response.status}`);
  }
  return (await response.json()).version ?? "unknown";
}

/** This machine's tailnet address, which node 1 must be able to reach. */
function tailnetAddress() {
  if (process.env.FLEET_RIG_MASTER_ADDRESS) {
    return process.env.FLEET_RIG_MASTER_ADDRESS;
  }
  return sh("tailscale", ["ip", "-4"]).split("\n")[0].trim();
}

// ───────────────────────────────────────────────────────────────────────────
// State file
// ───────────────────────────────────────────────────────────────────────────

function summary(state) {
  return {
    rigId: state.rigId,
    dir: state.dir,
    baseUrl: state.baseUrl,
    ports: state.ports,
    node1: {
      name: NODE1.name,
      url: state.node1Url,
      fingerprint: state.node1Fingerprint,
      entry: state.entries.node1 ?? null,
    },
    node2: {
      name: NODE2_NAME,
      url: state.node2Url,
      fingerprint: state.node2Fingerprint ?? null,
      entry: state.entries.node2 ?? null,
    },
  };
}

function writeState(state) {
  writeFileSync(path.join(state.dir, "state.json"), JSON.stringify(state, null, 2), {
    mode: 0o600,
  });
  mkdirSync(path.dirname(POINTER_PATH), { recursive: true });
  writeFileSync(POINTER_PATH, JSON.stringify(state, null, 2), { mode: 0o600 });
}

export function readRigState(pointerPath = POINTER_PATH) {
  return JSON.parse(readFileSync(pointerPath, "utf8"));
}

// ───────────────────────────────────────────────────────────────────────────
// down
// ───────────────────────────────────────────────────────────────────────────

/**
 * Teardown, in the order the contract needs: clear server-side state while the
 * master is still answering, then stop recorded PIDs, then remove the rig's
 * secrets. Best-effort on each step so a half-failed rig still tears down.
 */
async function down() {
  let state;
  try {
    state = readRigState();
  } catch {
    log("no rig state; nothing to tear down");
    return;
  }

  try {
    await clearFleetBackends(state);
    log("cleared fleet_backends on the master agent server");
  } catch (error) {
    log(`could not clear fleet_backends: ${error.message}`);
  }

  for (const service of [...state.services].reverse()) {
    try {
      await stopService(service);
    } catch (error) {
      log(`could not stop ${service.name}: ${error.message}`);
    }
  }

  try {
    rmSync(path.join(state.home, ".openhands"), { recursive: true, force: true });
    log("removed the rig secret store");
  } catch (error) {
    log(`could not remove the secret store: ${error.message}`);
  }

  try {
    ssh(`rm -rf ${NODE1.stagingDir}`);
    log(`removed ${NODE1.stagingDir} on ${NODE1.name}`);
  } catch (error) {
    log(`could not clean ${NODE1.name}: ${error.message}`);
  }

  rmSync(POINTER_PATH, { force: true });
  log(`rig down; artefacts remain at ${state.dir}`);
}

async function clearFleetBackends(state) {
  const url = `http://127.0.0.1:${state.ports.masterAgentServer}/api/settings`;
  const response = await fetch(url, {
    method: "PATCH",
    headers: {
      "X-Session-API-Key": state.keys.master,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ misc_settings_diff: { fleet_backends: { entries: [] } } }),
  });
  if (!response.ok) {
    throw new Error(`settings patch returned ${response.status}`);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Entry point
// ───────────────────────────────────────────────────────────────────────────

const COMMANDS = {
  up,
  down,
  /**
   * Re-runs node 1's enrolment. Only that machine holds its host key, so a
   * re-registration has to originate there; the spec shells out to this
   * rather than growing its own SSH knowledge.
   */
  async "reenrol-node1"() {
    const state = readRigState();
    console.log(await enrolNode1(state));
  },
  async status() {
    const state = readRigState();
    console.log(JSON.stringify(summary(state), null, 2));
    for (const service of state.services) {
      let alive = true;
      try {
        process.kill(service.pid, 0);
      } catch {
        alive = false;
      }
      console.log(`${alive ? "up  " : "down"} ${service.name} pid ${service.pid}`);
    }
  },
};

const isMainModule =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  const command = COMMANDS[process.argv[2] ?? "status"];
  if (!command) {
    console.error(`usage: rig.mjs <${Object.keys(COMMANDS).join("|")}>`);
    process.exit(2);
  }
  command().catch((error) => {
    console.error(`[rig] ${error instanceof Error ? error.stack : error}`);
    process.exit(1);
  });
}
