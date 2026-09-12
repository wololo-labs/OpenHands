#!/usr/bin/env node
/**
 * Live rig for the fleet registry, in two reachability profiles.
 *
 *   node tests/e2e/live/fleet-registry/rig.mjs up   --profile tailnet
 *   node tests/e2e/live/fleet-registry/rig.mjs down --profile tailnet
 *   node tests/e2e/live/fleet-registry/rig.mjs up   --profile k8s
 *   node tests/e2e/live/fleet-registry/rig.mjs down --profile k8s
 *
 * The registry is transport-neutral: an entry is a URL plus a credential
 * reference, and the proxy dials whatever URL the entry carries. So the
 * question is never "which tunnel" but how a node becomes dialable at all,
 * and these are the two answers that need no new code:
 *
 *   ┌─ PROFILE tailnet ──────────────┐   ┌─ PROFILE k8s ──────────────────┐
 *   │ two real VMs on a private      │   │ one real k3s cluster, built    │
 *   │ overlay                        │   │ from nothing                   │
 *   │ https://<node>.<tailnet>:8443  │   │ http://<svc>.<ns>.svc:<port>   │
 *   │ push enrolment, SSH host key   │   │ pull source, Service label     │
 *   │ hetzner pre-seeded -> active   │   │ no enrolment, no key, no       │
 *   │ gcp-1 unseeded   -> pending    │   │ fingerprint pre-seeded         │
 *   │ master: this Mac, serve :8444  │   │ master: in-cluster, port-fwd   │
 *   └────────────────────────────────┘   └────────────────────────────────┘
 *
 * **SSH is never a transport in either profile.** In `tailnet` it runs the
 * enrolment client on the machine that holds the host key, because only that
 * machine can sign for itself; in `k8s` it installs k3s once, the way a
 * cloud-init script or a platform team would. Every hop the registry makes is
 * over the profile's own reachability.
 *
 * Isolation is the shape of this file. Every process runs on a random port in
 * 39000-39999, writes under `$TMPDIR/fleet-rig-<ts>`, and runs with `HOME`
 * pointed inside that directory so the `file` secret provider cannot reach the
 * operator's real `~/.openhands`. Teardown kills recorded PIDs only; there is
 * no pattern-matched kill anywhere in this file, and nothing it did not create
 * is ever removed.
 */

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { credRefFor } from "../../../../scripts/registry/store.mjs";
// Resolution for MagicDNS names, which this Mac's system resolver refuses.
// The rig health-checks each node on its published address before enrolling
// it, so this process needs the same resolution the master does.
import "./magicdns.mjs";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);
const POINTER_PATH = path.join(REPO_ROOT, ".tmp", "fleet-rig.json");
const PORT_RANGE = { min: 39000, max: 39999 };

/**
 * The two real machines. Each is addressed by the MagicDNS name its own
 * `tailscale serve` terminates TLS for, so the master verifies a certificate
 * rather than trusting the overlay alone. `ssh` here is provisioning only:
 * enrolment has to run where the host key is.
 */
const NODES = {
  node1: {
    name: process.env.FLEET_RIG_NODE1_NAME ?? "claude-hetzner",
    ssh: process.env.FLEET_RIG_NODE1_SSH ?? "claude@100.125.222.64",
    host:
      process.env.FLEET_RIG_NODE1_HOST ??
      "https://claude-hetzner.tailae910a.ts.net:8443",
    keyPath:
      process.env.FLEET_RIG_NODE1_KEY_PATH ?? "/etc/ssh/ssh_host_ed25519_key",
    sessionKeyPath:
      process.env.FLEET_RIG_NODE1_SESSION_KEY_PATH ??
      "~/.openhands/canvas-api-key",
    stagingDir:
      process.env.FLEET_RIG_NODE1_STAGING_DIR ??
      "/home/claude/.cache/agent-canvas-enrol-rig",
    // Pre-seeded: this machine's fingerprint is known to the operator, so it
    // enrols straight to `active`.
    preSeeded: true,
    // Commit signing, checked before a run rather than after it. The
    // fingerprint is the one published in the run's anchor comment.
    signingKeyPath:
      process.env.FLEET_RIG_NODE1_SIGNING_KEY_PATH ??
      "/home/claude/.ssh/fleet-node-signing.pub",
    signingKeyFingerprint:
      process.env.FLEET_RIG_NODE1_SIGNING_FINGERPRINT ??
      "SHA256:H5ez7DvuU+IhNEzHK8eELNf5520yO+ZWGn/TR8gEQmE",
  },
  node2: {
    name: process.env.FLEET_RIG_NODE2_NAME ?? "claude-gcp-1",
    ssh: process.env.FLEET_RIG_NODE2_SSH ?? "claude@100.66.160.98",
    host:
      process.env.FLEET_RIG_NODE2_HOST ??
      "https://claude-gcp-1.tailae910a.ts.net:8443",
    keyPath:
      process.env.FLEET_RIG_NODE2_KEY_PATH ?? "/etc/ssh/ssh_host_ed25519_key",
    sessionKeyPath:
      process.env.FLEET_RIG_NODE2_SESSION_KEY_PATH ??
      "~/.openhands/canvas-api-key",
    stagingDir:
      process.env.FLEET_RIG_NODE2_STAGING_DIR ??
      "/home/claude/.cache/agent-canvas-enrol-rig",
    // Deliberately not pre-seeded: this is the pending/TOFU path under test,
    // and the approval that clears it is performed through the UI by
    // Playwright, never by a human and never by curl.
    preSeeded: false,
  },
};

/**
 * The port `tailscale serve` publishes the master on, so a node can reach it
 * by the Mac's own MagicDNS name. 8443 is the everyday canvas's and is off
 * limits; this run creates 8444 and removes exactly that mapping on the way
 * out.
 */
const MASTER_SERVE_PORT = Number(process.env.FLEET_RIG_MASTER_SERVE_PORT ?? 8444);

/** Cluster settings for the k8s profile. */
const K8S = {
  // The VM that becomes a cluster, and is restored to a plain VM on teardown.
  ssh: process.env.FLEET_RIG_K8S_SSH ?? "claude@100.66.160.98",
  apiAddress: process.env.FLEET_RIG_K8S_API ?? "100.66.160.98",
  namespace: process.env.FLEET_RIG_K8S_NAMESPACE ?? "fleet-rig",
  canvasRelease: "fleet-canvas",
  poolRelease: "fleet-pool",
  image: process.env.FLEET_RIG_K8S_IMAGE ?? "agent-canvas:fleet-rig",
  // Short enough that "the entry list changed within one poll" is an
  // assertion a test can make without outliving its own timeout.
  sourceIntervalMs: Number(process.env.FLEET_RIG_K8S_POLL_MS ?? 5000),
  // `service.port` in helm/agent-canvas/values.yaml. It is what the
  // port-forward targets and what a discovered entry's host carries.
  servicePort: Number(process.env.FLEET_RIG_K8S_SERVICE_PORT ?? 8000),
};

const AGENT_SERVER_VERSION = JSON.parse(
  readFileSync(path.join(REPO_ROOT, "config", "defaults.json"), "utf8"),
).versions.agentServer;

/** Resolution for MagicDNS names, which this Mac's system resolver refuses. */
const MAGICDNS_PRELOAD = path.join(
  REPO_ROOT,
  "tests/e2e/live/fleet-registry/magicdns.mjs",
);

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

/**
 * Runs a command on one of the real machines.
 *
 * Provisioning only: it stages the enrolment client where the host key lives,
 * and installs k3s. No request the registry makes ever travels this way.
 */
function ssh(target, remoteCommand, { timeout = 60_000 } = {}) {
  return sh(
    "ssh",
    ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", target, remoteCommand],
    { timeout },
  );
}

/** Best-effort cleanup: a node that is already gone must not fail a teardown. */
function trySsh(target, remoteCommand, options) {
  try {
    return ssh(target, remoteCommand, options);
  } catch (error) {
    log(`ssh ${target} failed (continuing): ${error.message.split("\n")[0]}`);
    return null;
  }
}

/**
 * The node still signs commits with its own key.
 *
 * Link 1 of `scripts/verify-fleet-chain.mjs` is the only one that tells the
 * node apart from this Mac, and it holds only while the node signs with a key
 * this machine does not have. That config has silently reverted to the shared
 * OpenPGP key once already, and the verifier catches it after the work is
 * done -- one ssh round trip here costs a second, the same discovery at
 * verification time costs the run. Set `FLEET_RIG_SKIP_SIGNING_CHECK` for a
 * rig run that is not driving commits.
 */
function checkNode1Signing() {
  if (process.env.FLEET_RIG_SKIP_SIGNING_CHECK) return;
  const node = NODES.node1;

  const format = ssh(node.ssh, "git config --global --get gpg.format || true").trim();
  const fingerprint = ssh(
    node.ssh,
    `ssh-keygen -lf ${node.signingKeyPath} 2>/dev/null | cut -d' ' -f2 || true`,
  ).trim();
  const signing = ssh(
    node.ssh,
    "git config --global --get user.signingkey || true",
  ).trim();

  const problems = [];
  if (format !== "ssh") problems.push(`gpg.format is "${format}", not "ssh"`);
  if (signing !== node.signingKeyPath) {
    problems.push(`user.signingkey is "${signing}", not ${node.signingKeyPath}`);
  }
  if (fingerprint !== node.signingKeyFingerprint) {
    problems.push(
      `${node.signingKeyPath} is ${fingerprint || "unreadable"}, not the published ${node.signingKeyFingerprint}`,
    );
  }
  if (problems.length > 0) {
    throw new Error(
      `${node.name}: commits from this node would not prove it made them: ` +
        `${problems.join("; ")}. Fix the node's signing config before the run.`,
    );
  }
  log(`node1 signs with ${node.signingKeyFingerprint}`);
}

/**
 * Copies the enrolment client onto a node. Each node runs a released
 * `agent-canvas` that predates this branch, so the code under test has to be
 * the code that runs there — otherwise the rig would prove the old client
 * works. Only the enrolment half is copied; nothing installed on the node is
 * touched, and teardown removes exactly this directory.
 */
function stageEnrolmentClient(node) {
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
      "-o",
      "ConnectTimeout=10",
      // A hung transfer here is indistinguishable from a slow one, and this
      // runs unattended: without a bound, one wedged ssh stalls the whole run
      // and nothing ever says so.
      "-o",
      "ServerAliveInterval=10",
      "-o",
      "ServerAliveCountMax=3",
      node.ssh,
      `rm -rf ${node.stagingDir} && mkdir -p ${node.stagingDir} && tar xzf - -C ${node.stagingDir}`,
    ],
    { input: tar.stdout, encoding: "buffer", timeout: 120_000 },
  );
  if (push.status !== 0) {
    throw new Error(
      `could not stage the enrolment client on ${node.name}` +
        `${push.signal ? ` (killed after ${push.signal}: it hung)` : ""}: ` +
        `${push.stderr}`,
    );
  }
  log(`staged the enrolment client on ${node.name}`);
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
// Shared state
// ───────────────────────────────────────────────────────────────────────────

function newState(profile) {
  const timestamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "")
    .replace("T", "-")
    .slice(0, 15);
  const dir = path.join(tmpdir(), `fleet-rig-${timestamp}`);
  const state = {
    profile,
    rigId: `fleet-rig-${timestamp}`,
    dir,
    home: path.join(dir, "home"),
    startedAt: new Date().toISOString(),
    services: [],
    ports: {},
    keys: {},
    entries: {},
  };
  for (const sub of ["home", "logs", "evidence", "master"]) {
    mkdirSync(path.join(dir, sub), { recursive: true });
  }
  mkdirSync(path.join(dir, "master", "home"), { recursive: true });
  state.evidenceDir = path.join(dir, "evidence");
  state.accessLogPath = path.join(state.evidenceDir, "proxy-access.jsonl");
  state.tunnelMapPath = path.join(state.evidenceDir, "tunnel-map.json");
  log(`profile ${profile}, rig dir ${dir}`);
  return state;
}

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
    UV_CACHE_DIR:
      process.env.UV_CACHE_DIR ?? path.join(realHome, ".cache", "uv"),
    UV_TOOL_DIR:
      process.env.UV_TOOL_DIR ??
      path.join(realHome, ".local", "share", "uv", "tools"),
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

// ───────────────────────────────────────────────────────────────────────────
// Profile tailnet: two real VMs on a private overlay
// ───────────────────────────────────────────────────────────────────────────

async function upTailnet(onState = () => {}) {
  const state = newState("tailnet");
  onState(state);

  const taken = new Set();
  state.ports = {
    masterAgentServer: await freePort(taken),
    static: await freePort(taken),
    ingress: await freePort(taken),
  };
  state.keys = {
    // Three distinct keys. The browser assertions say no *node* key reaches
    // it; the master key legitimately does, so they must never collide.
    master: `master-${randomBytes(24).toString("hex")}`,
    node1: ssh(NODES.node1.ssh, `cat ${NODES.node1.sessionKeyPath}`),
    node2: ssh(NODES.node2.ssh, `cat ${NODES.node2.sessionKeyPath}`),
  };
  for (const which of ["node1", "node2"]) {
    if (!state.keys[which] || state.keys[which].length < 8) {
      throw new Error(
        `${NODES[which].name}: session key at ${NODES[which].sessionKeyPath} is unusable`,
      );
    }
  }
  log(`ports ${JSON.stringify(state.ports)}`);

  checkNode1Signing();

  for (const which of ["node1", "node2"]) {
    const node = NODES[which];
    stageEnrolmentClient(node);
    state[`${which}Fingerprint`] = ssh(
      node.ssh,
      `sudo -n node ${node.stagingDir}/bin/enrol.mjs --print-fingerprint --key ${node.keyPath}`,
    );
    state[`${which}Url`] = node.host;
    log(`${node.name} fingerprint ${state[`${which}Fingerprint`]}`);
  }

  // ── processes ────────────────────────────────────────────────────────────
  startService(state, {
    name: "master-agent-server",
    command: agentServerCommand(state.ports.masterAgentServer),
    env: agentServerEnv(path.join(state.dir, "master"), state.keys.master),
    cwd: path.join(state.dir, "master"),
  });
  startService(state, {
    name: "static",
    command: `node scripts/static-server.mjs --port ${state.ports.static} --dir build --session-api-key ${shellQuote(state.keys.master)}`,
    env: {
      ...baseEnv(),
      HOME: state.home,
      AGENT_CANVAS_DISABLE_TELEMETRY: "1",
    },
  });

  const agentServer = `http://127.0.0.1:${state.ports.masterAgentServer}`;
  startService(state, {
    name: "ingress",
    command: [
      // The master binds loopback: `tailscale serve` below is what publishes
      // it, and it is the only thing that should be able to.
      `node --import ${shellQuote(MAGICDNS_PRELOAD)} scripts/ingress.mjs`,
      "--host 127.0.0.1",
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
      // Only node 1. Node 2's absence here is the pending/TOFU path under test.
      `--registry-preseed ${shellQuote(state.node1Fingerprint)}`,
      "--registry-secret-provider file",
      // The wire record every hop to a fleet node is verified against. It
      // lives in the rig dir, never in the operator's ~/.openhands.
      `--registry-access-log ${shellQuote(state.accessLogPath)}`,
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

  // The nodes reach the master by this Mac's own MagicDNS name. 8443 is the
  // everyday canvas's mapping and is never touched; this creates 8444 and
  // teardown removes exactly it.
  state.masterServeUrl = `https://${macTailnetName()}:${MASTER_SERVE_PORT}`;
  sh("tailscale", [
    "serve",
    "--bg",
    "--https",
    String(MASTER_SERVE_PORT),
    `http://127.0.0.1:${state.ports.ingress}`,
  ]);
  state.masterServePort = MASTER_SERVE_PORT;
  log(`master published at ${state.masterServeUrl}`);

  // With a ts.net entry host the tunnel map does not disappear; it stops
  // being "this loopback port forwards to that machine" and becomes a
  // one-line attestation that this name is that machine.
  writeFileSync(
    state.tunnelMapPath,
    JSON.stringify(
      Object.fromEntries(
        ["node1", "node2"].map((which) => [
          NODES[which].host,
          {
            node: NODES[which].name,
            fingerprint: state[`${which}Fingerprint`],
          },
        ]),
      ),
      null,
      2,
    ),
    "utf8",
  );

  await waitFor(
    "master agent server",
    async () => (await httpStatus(`${agentServer}/server_info`)) === 200,
  );
  await waitFor(
    "ingress",
    async () => (await httpStatus(`${base}/server_info`)) === 200,
  );
  await waitFor("canvas", async () => (await httpStatus(`${base}/`)) === 200);
  for (const which of ["node1", "node2"]) {
    await waitFor(
      `${NODES[which].name} on its published address`,
      async () =>
        (await httpStatus(`${NODES[which].host}/server_info`)) === 200,
    );
  }

  writeState(state);
  await enrolBothNodes(state);
  writeState(state);

  log("rig is up");
  log(JSON.stringify(summary(state), null, 2));
  return state;
}

/** This Mac's MagicDNS name, which both nodes must be able to reach. */
function macTailnetName() {
  if (process.env.FLEET_RIG_MASTER_NAME) return process.env.FLEET_RIG_MASTER_NAME;
  const dnsName = JSON.parse(sh("tailscale", ["status", "--json"])).Self.DNSName;
  return dnsName.replace(/\.$/, "");
}

// ───────────────────────────────────────────────────────────────────────────
// Enrolment (tailnet profile only: k8s discovers, it does not enrol)
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
 * Enrols one node, from that node.
 *
 * Only the machine holding the host key can sign for itself, which is why
 * this runs there rather than here. It publishes a credential *reference*:
 * the `file` provider is master-local, so the key itself is placed into the
 * master's provider out of band rather than travelling with the registration.
 */
async function enrolNode(state, which) {
  const node = NODES[which];
  // The registry derives the reference it stores from the fingerprint and
  // ignores whatever the registration asks for, so the out-of-band placement
  // below has to use the derived one too.
  const credRef = credRefFor(state[`${which}Fingerprint`]);
  const version = await remoteAgentServerVersion(node.host);
  const output = ssh(
    node.ssh,
    [
      `sudo -n node ${node.stagingDir}/bin/enrol.mjs`,
      `--registry ${shellQuote(state.masterServeUrl)}`,
      `--name ${shellQuote(node.name)}`,
      `--host ${shellQuote(node.host)}`,
      "--has-credential",
      `--key ${node.keyPath}`,
      `--version ${shellQuote(version)}`,
    ].join(" "),
  );
  log(`${node.name} enrol -> ${enrolResultLine(output)}`);

  // Out-of-band credential placement: the provisioner's job in a real
  // deployment, and the reason the registration carries a reference only.
  writeSecret(state, credRef, state.keys[which]);
  return output;
}

/**
 * The `<state> <id>` line out of an enrol run. `enrol` also prints where the
 * session key has to live, so neither the first nor the last line is reliably
 * the result.
 */
function enrolResultLine(output) {
  const match = String(output).match(/^(pending|active|stale|revoked) \S+$/m);
  return match ? match[0] : String(output).trim();
}

function writeSecret(state, ref, secret) {
  const filePath = path.join(
    state.home,
    ".openhands",
    "agent-canvas",
    "secrets",
    ref,
  );
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  writeFileSync(filePath, `${secret}\n`, { mode: 0o600 });
  log(`placed credential ${ref}`);
}

async function enrolBothNodes(state) {
  await enrolNode(state, "node1");
  await enrolNode(state, "node2");

  const entries = await registryEntries(state);
  for (const which of ["node1", "node2"]) {
    const entry = entries.find((each) => each.name === NODES[which].name);
    if (!entry) {
      throw new Error(
        `expected ${NODES[which].name} in the registry, got ${entries.map((e) => e.name).join(", ") || "nothing"}`,
      );
    }
    state.entries[which] = entry;
  }
}

/** The version a node actually reports, so the entry never claims a guess. */
async function remoteAgentServerVersion(host) {
  const response = await fetch(`${host}/server_info`);
  if (!response.ok) {
    throw new Error(`${host} /server_info returned ${response.status}`);
  }
  return (await response.json()).version ?? "unknown";
}

// ───────────────────────────────────────────────────────────────────────────
// Profile k8s: one real cluster, built from nothing
// ───────────────────────────────────────────────────────────────────────────

function kubectl(state, args, options = {}) {
  return sh("kubectl", ["--kubeconfig", state.kubeconfig, ...args], options);
}

function helm(state, args) {
  return sh("helm", ["--kubeconfig", state.kubeconfig, ...args], {
    cwd: REPO_ROOT,
    timeout: 600_000,
  });
}

/**
 * Turns the plain VM into a single-node k3s cluster and hands back a
 * kubeconfig that works from here.
 *
 * `--tls-san` is what makes the API server's certificate valid for the
 * address this machine dials; without it every kubectl call fails
 * verification and the honest fix would be `--insecure-skip-tls-verify`,
 * which is not a thing this rig will do.
 */
function installK3s(state) {
  // The image is unpacked into the cluster's own store, and a VM that runs
  // out of disk half way through leaves a wedged containerd and a failure
  // that reads as something else entirely. Check first, say the number.
  const freeMb = Number(
    ssh(K8S.ssh, "df -Pm / | awk 'NR==2 {print $4}'").trim(),
  );
  const NEEDED_MB = 8_000;
  if (!Number.isFinite(freeMb) || freeMb < NEEDED_MB) {
    throw new Error(
      `${K8S.ssh} has ${freeMb} MB free on /, and k3s plus this image need ` +
        `about ${NEEDED_MB}. Free space on the VM before running this profile.`,
    );
  }
  log(`${freeMb} MB free on the VM`);

  log("installing k3s on the VM (from nothing)");
  // The kubelet evicts on *percentage* free by default — 15% of the disk — and
  // this VM has a large disk that is nearly full, so a node with gigabytes
  // free still takes a `disk-pressure` taint and schedules nothing. The
  // failure surfaces as a pod stuck Pending with an untolerated taint, which
  // reads like a scheduling problem and is not one. Absolute thresholds say
  // what actually matters: whether there is room for another pod.
  ssh(
    K8S.ssh,
    "sudo -n mkdir -p /etc/rancher/k3s && " +
      "printf '%s\\n' " +
      "'kubelet-arg:' " +
      `'  - "eviction-hard=imagefs.available<1Gi,nodefs.available<1Gi"' ` +
      `'  - "eviction-minimum-reclaim=imagefs.available=0,nodefs.available=0"' ` +
      "| sudo -n tee /etc/rancher/k3s/config.yaml >/dev/null",
  );

  // `sudo` starts a fresh environment, so INSTALL_K3S_EXEC has to be set
  // inside it rather than in front of the pipeline.
  ssh(
    K8S.ssh,
    "curl -sfL https://get.k3s.io | sudo -n env " +
      `INSTALL_K3S_EXEC='--tls-san ${K8S.apiAddress} --write-kubeconfig-mode 644' sh -`,
    { timeout: 600_000 },
  );
  ssh(
    K8S.ssh,
    "sudo -n k3s kubectl wait --for=condition=Ready node --all --timeout=180s",
    { timeout: 240_000 },
  );

  const raw = ssh(K8S.ssh, "sudo -n cat /etc/rancher/k3s/k3s.yaml");
  const kubeconfig = raw.replace(
    /server: https:\/\/127\.0\.0\.1:6443/,
    `server: https://${K8S.apiAddress}:6443`,
  );
  state.kubeconfig = path.join(state.dir, "kubeconfig.yaml");
  writeFileSync(state.kubeconfig, `${kubeconfig}\n`, { mode: 0o600 });
  log(`kubeconfig written to ${state.kubeconfig}`);
}

/**
 * Puts this branch's image into the cluster's own image store.
 *
 * The released image has no registry in it at all — the chart's
 * `registry.enabled` switch was wired to environment variables nothing read.
 * So the cluster has to run the image built from this tree, and with no
 * registry to push to, `docker save` piped into containerd is the honest way
 * to get it there.
 */
function importImage(state) {
  const [repository, tag] = K8S.image.split(":");
  const present = spawnSync("docker", ["image", "inspect", K8S.image], {
    stdio: "ignore",
  });
  if (present.status !== 0) {
    throw new Error(
      `${K8S.image} is not built. Run: node scripts/docker-build.mjs --tag ${K8S.image}`,
    );
  }
  log(`importing ${K8S.image} into the cluster (this takes a few minutes)`);
  const save = spawnSync(
    "bash",
    [
      "-o",
      "pipefail",
      "-c",
      `docker save ${shellQuote(K8S.image)} | ssh -o BatchMode=yes ${K8S.ssh} 'sudo -n k3s ctr images import -'`,
    ],
    { encoding: "utf8", timeout: 1_800_000 },
  );
  if (save.status !== 0) {
    throw new Error(
      `could not import ${K8S.image} into the cluster: ${(save.stderr || save.stdout || "").trim()}`,
    );
  }
  log(`imported ${repository}:${tag}`);
}

/**
 * Replaces the pod's ServiceAccount token with one that expires in ten
 * minutes, so a real rotation happens inside a test run.
 *
 * The thing under test is that the registry re-reads the token every cycle
 * rather than holding the one it read at boot. In a normal cluster that token
 * lives an hour and the kubelet rewrites it at about 80% of its life, so the
 * bug takes roughly 50 minutes to appear and a test would have to wait that
 * long — or fake the rotation, which proves nothing about the kubelet.
 *
 * Ten minutes is the shortest expiry the TokenRequest API accepts. The
 * mechanism is the real one: a projected volume, rewritten in place by the
 * kubelet, at the path the source reads.
 */
function shortenServiceAccountToken(state) {
  const EXPIRY_SECONDS = 600;
  const SA_PATH = "/var/run/secrets/kubernetes.io/serviceaccount";
  // A strategic merge, not a JSON patch: with persistence disabled the
  // container has no volumeMounts array at all, and `add .../volumeMounts/-`
  // would fail on the missing path. Strategic merge merges both lists by
  // name, so this adds without replacing anything the chart put there.
  const patch = {
    spec: {
      template: {
        spec: {
          volumes: [
            {
              name: "short-lived-sa-token",
              projected: {
                sources: [
                  {
                    serviceAccountToken: {
                      path: "token",
                      expirationSeconds: EXPIRY_SECONDS,
                    },
                  },
                  // The same two files the kubelet's own mount provides, so
                  // readInClusterConfig finds what it expects — including the
                  // cluster CA the dispatcher is built from.
                  {
                    configMap: {
                      name: "kube-root-ca.crt",
                      items: [{ key: "ca.crt", path: "ca.crt" }],
                    },
                  },
                  {
                    downwardAPI: {
                      items: [
                        {
                          path: "namespace",
                          fieldRef: { fieldPath: "metadata.namespace" },
                        },
                      ],
                    },
                  },
                ],
              },
            },
          ],
          containers: [
            {
              name: "agent-canvas",
              volumeMounts: [
                {
                  name: "short-lived-sa-token",
                  mountPath: SA_PATH,
                  readOnly: true,
                },
              ],
            },
          ],
        },
      },
    },
  };

  kubectl(state, [
    "-n",
    state.namespace,
    "patch",
    "statefulset",
    state.canvasService,
    "-p",
    JSON.stringify(patch),
  ]);
  kubectl(state, [
    "-n",
    state.namespace,
    "rollout",
    "status",
    `statefulset/${state.canvasService}`,
    "--timeout=10m",
  ]);
  log(`the canvas pod's ServiceAccount token now expires in ${EXPIRY_SECONDS}s`);
  return EXPIRY_SECONDS;
}

async function upK8s(onState = () => {}) {
  const state = newState("k8s");
  onState(state);
  state.keys = { master: `master-${randomBytes(24).toString("hex")}` };
  state.namespace = K8S.namespace;
  state.releases = { canvas: K8S.canvasRelease, pool: K8S.poolRelease };
  state.sourceIntervalMs = K8S.sourceIntervalMs;

  installK3s(state);
  importImage(state);

  kubectl(state, ["create", "namespace", state.namespace]);
  kubectl(state, [
    "-n",
    state.namespace,
    "create",
    "secret",
    "generic",
    "fleet-session-key",
    `--from-literal=session-api-key=${state.keys.master}`,
  ]);

  // The agent pool. Its Service carries the label the registry discovers by,
  // and nothing about it is enrolled, keyed or pre-seeded: membership of the
  // namespace is the membership of the fleet.
  log("helm install: agent pool");
  helm(state, [
    "install",
    state.releases.pool,
    "helm/agent-canvas",
    "-n",
    state.namespace,
    "--set",
    "agentPool.enabled=true",
    "--set",
    "agentPool.replicas=2",
    "--set",
    `image.repository=${K8S.image.split(":")[0]}`,
    "--set",
    `image.tag=${K8S.image.split(":")[1]}`,
    "--set",
    "image.pullPolicy=Never",
    "--set",
    "persistence.enabled=false",
    "--wait",
    "--timeout",
    "10m",
  ]);

  // The canvas. Same chart, same image; what differs is that this one runs
  // the registry and polls the API server for the pool's Services.
  log("helm install: canvas with the kubernetes source");
  helm(state, [
    "install",
    state.releases.canvas,
    "helm/agent-canvas",
    "-n",
    state.namespace,
    "--set",
    `image.repository=${K8S.image.split(":")[0]}`,
    "--set",
    `image.tag=${K8S.image.split(":")[1]}`,
    "--set",
    "image.pullPolicy=Never",
    "--set",
    "persistence.enabled=false",
    "--set",
    "registry.enabled=true",
    "--set",
    "registry.sources.kubernetes.enabled=true",
    // Discovered entries carry no credential reference, because this profile
    // distributes no keys at all. `/server_info` needs none either, which is
    // what the proof rests on.
    "--set",
    "registry.allowUncredentialed=true",
    "--set",
    `registry.sourceIntervalSeconds=${Math.round(K8S.sourceIntervalMs / 1000)}`,
    "--set",
    "secrets.sessionApiKey.existingSecret=fleet-session-key",
    "--set",
    "secrets.sessionApiKey.key=session-api-key",
    // The kubelet's own mount is turned off so the rig can replace it with a
    // short-lived one below; see shortenServiceAccountToken.
    "--set",
    "serviceAccount.automountServiceAccountToken=false",
    "--wait",
    "--timeout",
    "10m",
  ]);

  state.canvasService = `${state.releases.canvas}-agent-canvas`;
  state.poolService = `${state.releases.pool}-agent-canvas`;

  state.tokenExpirySeconds = shortenServiceAccountToken(state);

  // The viewer's path into the cluster. Not the overlay: this profile exists
  // to prove no overlay is needed, so the canvas is reached exactly the way a
  // platform engineer reaches any in-cluster service.
  const taken = new Set();
  state.ports = { portForward: await freePort(taken) };
  startService(state, {
    name: "port-forward",
    command: `kubectl --kubeconfig ${shellQuote(state.kubeconfig)} -n ${state.namespace} port-forward svc/${state.canvasService} ${state.ports.portForward}:${K8S.servicePort}`,
    env: baseEnv(),
  });
  state.baseUrl = `http://127.0.0.1:${state.ports.portForward}`;

  await waitFor(
    "the canvas through the port-forward",
    async () => (await httpStatus(`${state.baseUrl}/server_info`)) === 200,
    { timeoutMs: 180_000 },
  );
  await waitFor(
    "the pool's Services to be discovered",
    async () => (await registryEntries(state)).length >= 2,
    { timeoutMs: 180_000 },
  );

  const entries = await registryEntries(state);
  state.entries = {
    node1: entries[0],
    node2: entries[1],
  };
  state.node1Fingerprint = entries[0].fingerprint;
  state.node2Fingerprint = entries[1].fingerprint;
  state.node1Url = entries[0].host;
  state.node2Url = entries[1].host;

  writeState(state);
  log("rig is up");
  log(JSON.stringify(summary(state), null, 2));
  return state;
}

// ───────────────────────────────────────────────────────────────────────────
// State file
// ───────────────────────────────────────────────────────────────────────────

function summary(state) {
  return {
    profile: state.profile,
    rigId: state.rigId,
    dir: state.dir,
    baseUrl: state.baseUrl,
    masterServeUrl: state.masterServeUrl ?? null,
    ports: state.ports,
    evidenceDir: state.evidenceDir,
    accessLogPath: state.accessLogPath,
    tunnelMapPath: state.tunnelMapPath,
    namespace: state.namespace ?? null,
    node1: {
      name: state.entries.node1?.name ?? NODES.node1.name,
      url: state.node1Url,
      fingerprint: state.node1Fingerprint,
      entry: state.entries.node1 ?? null,
    },
    node2: {
      name: state.entries.node2?.name ?? NODES.node2.name,
      url: state.node2Url,
      fingerprint: state.node2Fingerprint ?? null,
      entry: state.entries.node2 ?? null,
    },
  };
}

function writeState(state) {
  writeFileSync(
    path.join(state.dir, "state.json"),
    JSON.stringify(state, null, 2),
    { mode: 0o600 },
  );
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
 * master is still answering, then stop recorded PIDs, then remove what the run
 * created. Best-effort on each step so a half-failed rig still tears down, and
 * nothing the run did not create is ever touched.
 */
async function down() {
  let state;
  try {
    state = readRigState();
  } catch {
    log("no rig state; nothing to tear down");
    return;
  }

  if (state.profile === "k8s") {
    await downK8s(state);
  } else {
    await downTailnet(state);
  }

  rmSync(POINTER_PATH, { force: true });
  log(`rig down; artefacts remain at ${state.dir}`);
}

async function downTailnet(state) {
  try {
    await clearFleetBackends(state);
    log("cleared fleet_backends on the master agent server");
  } catch (error) {
    log(`could not clear fleet_backends: ${error.message}`);
  }

  if (state.masterServePort) {
    try {
      // Exactly the mapping this run created. Every other serve mapping on
      // this machine, including the everyday canvas's :8443, is left alone.
      sh("tailscale", [
        "serve",
        "--https",
        String(state.masterServePort),
        "off",
      ]);
      log(`removed the serve mapping on :${state.masterServePort}`);
    } catch (error) {
      log(`could not remove the serve mapping: ${error.message}`);
    }
  }

  for (const service of [...state.services].reverse()) {
    try {
      await stopService(service);
    } catch (error) {
      log(`could not stop ${service.name}: ${error.message}`);
    }
  }

  try {
    rmSync(path.join(state.home, ".openhands"), {
      recursive: true,
      force: true,
    });
    log("removed the rig secret store");
  } catch (error) {
    log(`could not remove the secret store: ${error.message}`);
  }

  for (const which of ["node1", "node2"]) {
    const node = NODES[which];
    if (trySsh(node.ssh, `rm -rf ${node.stagingDir}`) !== null) {
      log(`removed ${node.stagingDir} on ${node.name}`);
    }
  }
}

/**
 * Restores the VM to a plain VM.
 *
 * Install-from-nothing is part of the enterprise claim, so every run pays for
 * it: the helm releases this run created are removed by name, then k3s itself
 * is uninstalled. A release the run did not create is never named here.
 */
async function downK8s(state) {
  for (const service of [...state.services].reverse()) {
    try {
      await stopService(service);
    } catch (error) {
      log(`could not stop ${service.name}: ${error.message}`);
    }
  }

  for (const release of [state.releases?.canvas, state.releases?.pool]) {
    if (!release) continue;
    try {
      helm(state, ["uninstall", release, "-n", state.namespace, "--wait"]);
      log(`uninstalled ${release}`);
    } catch (error) {
      log(`could not uninstall ${release}: ${error.message.split("\n")[0]}`);
    }
  }
  try {
    kubectl(state, ["delete", "namespace", state.namespace, "--wait=false"]);
  } catch (error) {
    log(`could not delete the namespace: ${error.message.split("\n")[0]}`);
  }

  if (process.env.FLEET_RIG_KEEP_CLUSTER) {
    log("FLEET_RIG_KEEP_CLUSTER is set; leaving k3s installed");
    return;
  }
  trySsh(K8S.ssh, "sudo -n /usr/local/bin/k3s-uninstall.sh", {
    timeout: 300_000,
  });
  // k3s-uninstall.sh leaves /etc/rancher behind. This run wrote the config in
  // it, so this run removes it: "restored to a plain VM" has to mean it.
  trySsh(K8S.ssh, "sudo -n rm -rf /etc/rancher/k3s/config.yaml");
  log("k3s uninstalled; the VM is a plain VM again");
}

async function clearFleetBackends(state) {
  const url = `http://127.0.0.1:${state.ports.masterAgentServer}/api/settings`;
  const response = await fetch(url, {
    method: "PATCH",
    headers: {
      "X-Session-API-Key": state.keys.master,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      misc_settings_diff: { fleet_backends: { entries: [] } },
    }),
  });
  if (!response.ok) {
    throw new Error(`settings patch returned ${response.status}`);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Entry point
// ───────────────────────────────────────────────────────────────────────────

const PROFILES = { tailnet: upTailnet, k8s: upK8s };

function requestedProfile() {
  const flag = process.argv.indexOf("--profile");
  const value =
    (flag !== -1 ? process.argv[flag + 1] : null) ??
    process.env.PROFILE ??
    "tailnet";
  if (!(value in PROFILES)) {
    throw new Error(
      `unknown profile "${value}"; expected one of ${Object.keys(PROFILES).join(", ")}`,
    );
  }
  return value;
}

const COMMANDS = {
  /**
   * A half-built rig is worse than none: its processes keep running, its
   * `tailscale serve` mapping keeps pointing at a dead port, and the next
   * attempt inherits both. So a failed bring-up tears down what it created
   * before it reports the failure, and the failure is what the caller sees.
   */
  async up() {
    const profile = requestedProfile();
    let state;
    try {
      state = await PROFILES[profile](
        // The partially-built state, handed over as soon as it exists, so a
        // failure has something to tear down.
        (partial) => {
          state = partial;
        },
      );
    } catch (error) {
      if (state) {
        log("bring-up failed; tearing down what it created");
        writeState(state);
        try {
          await down();
        } catch (teardownError) {
          log(`teardown after failure also failed: ${teardownError.message}`);
        }
      }
      throw error;
    }
  },
  down,
  /**
   * Re-runs a node's enrolment. Only that machine holds its host key, so a
   * re-registration has to originate there; the spec shells out to this
   * rather than growing its own SSH knowledge.
   */
  async "reenrol-node1"() {
    const state = readRigState();
    console.log(await enrolNode(state, "node1"));
  },
  async "reenrol-node2"() {
    const state = readRigState();
    console.log(await enrolNode(state, "node2"));
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
      console.log(
        `${alive ? "up  " : "down"} ${service.name} pid ${service.pid}`,
      );
    }
  },
};

const isMainModule =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  const command = COMMANDS[process.argv[2] ?? "status"];
  if (!command) {
    console.error(
      `usage: rig.mjs <${Object.keys(COMMANDS).join("|")}> [--profile tailnet|k8s]`,
    );
    process.exit(2);
  }
  command().catch((error) => {
    console.error(`[rig] ${error instanceof Error ? error.stack : error}`);
    process.exit(1);
  });
}
