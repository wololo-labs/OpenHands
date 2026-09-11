#!/usr/bin/env node
/**
 * Verifies that every commit on a fleet node's branch was made BY that node,
 * THROUGH the injecting proxy, INSIDE a conversation the master can point at.
 *
 * A green PR proves nothing about where the work happened: `gh` on the node
 * authenticates as the same GitHub account as the master, so GitHub cannot
 * tell the two apart. Four links can:
 *
 *   1  signature   a good SSH signature from a key generated ON the node,
 *                  whose private half never left it. This is the only link
 *                  that covers the git push, which is not proxy-observable.
 *   2  trailers    `Fleet-Conversation` and `Fleet-Run` on the commit, the
 *                  run nonce matching the one published before the work.
 *   3  proxy       that conversation seen in the proxy's access log against
 *                  an entry whose fingerprint is the node's SSH host key, at
 *                  a time before the commit was made, with a credential
 *                  actually injected. The tunnel map has to agree that the
 *                  loopback port in the log forwards to that same
 *                  fingerprint, because a bare `127.0.0.1` proves nothing
 *                  about which machine answered.
 *   4  events      an agent-sourced event in that conversation naming the
 *                  commit's own subject line.
 *
 * WHAT THE TRUST ANCHOR IS, AND WHAT IT IS NOT. The links are only as strong
 * as the fact that the master did not choose the key it verifies against. So
 * `--signing-key-fingerprint` is required, is checked against the key file,
 * and is meant to be copied from the run's published issue, which carries a
 * server-side timestamp the master cannot backdate. Verifying against a key
 * the master picked at verify time proves only that four files it holds agree
 * with each other. If the fingerprint did not come from the published record,
 * this script is a consistency check and not a proof.
 *
 * COMMITS CI PUSHED. Workflows push commits the node did not make. They are
 * exempt only when named by sha on the command line, never on the strength of
 * anything written inside the commit: author and committer identity are
 * attacker-chosen strings, so a name-based exemption is one environment
 * variable away from exempting anything.
 *
 *   node scripts/verify-fleet-chain.mjs \
 *     --range origin/main..fleet/stale-ui \
 *     --signing-key evidence/node-signing-key.pub \
 *     --signing-key-fingerprint SHA256:H5ez... \
 *     --fingerprint SHA256:zCJ... \
 *     --run-nonce 0123456789abcdef0123456789abcdef \
 *     --proxy-log /tmp/fleet-rig-.../evidence/proxy-access.jsonl \
 *     --tunnel-map evidence/tunnel-map.json \
 *     --events-dir evidence/events \
 *     [--exempt <sha> ...]
 *
 * Exits 0 when every link holds for every commit, 1 when one does not, and 2
 * when the check could not be run at all.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

// ───────────────────────────────────────────────────────────────────────────
// Pure checks
// ───────────────────────────────────────────────────────────────────────────

/** JSONL, tolerant of a partially written last line. */
export function parseProxyLog(text) {
  return String(text ?? "")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

/**
 * Trailer values from a commit message.
 *
 * Only the trailing block is read. A `Key: value` line in the body would
 * otherwise be indistinguishable from a trailer, which would let a commit
 * carry a decoy conversation id in its prose and the real one at the end.
 */
export function readTrailers(message) {
  const lines = String(message ?? "")
    .replace(/\s+$/, "")
    .split("\n");
  const trailers = {};
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.trim() === "") break;
    // `git interpret-trailers` accepts no space after the colon.
    const match = line.match(/^([A-Za-z][A-Za-z0-9-]*):[ \t]*(.+?)\s*$/);
    if (!match) break;
    trailers[match[1]] = match[2];
  }
  return trailers;
}

export function checkTrailers(commit, { runNonce }) {
  const trailers = readTrailers(commit.message);
  const conversationId = trailers["Fleet-Conversation"] ?? null;
  const nonce = trailers["Fleet-Run"] ?? null;

  if (!conversationId) {
    return {
      ok: false,
      reason: "no Fleet-Conversation trailer",
      conversationId,
    };
  }
  if (!nonce) {
    return { ok: false, reason: "no Fleet-Run trailer", conversationId };
  }
  if (nonce !== runNonce) {
    return {
      ok: false,
      reason: `Fleet-Run ${nonce} is not the published nonce ${runNonce}`,
      conversationId,
    };
  }
  return { ok: true, reason: `conversation ${conversationId}`, conversationId };
}

/**
 * The loopback host in a proxy line, resolved through the SSH forward the rig
 * opened, reaches the node's own fingerprint.
 *
 * Membership of the map's key set is not enough: that only says the port is
 * one the map mentions. The map records which machine each forward reaches,
 * and that is the part worth checking.
 */
export function isTunnelledToNode(entry, tunnelMap, fingerprint) {
  const host = entry.entryHost;
  if (!host) return false;
  for (const [local, forward] of Object.entries(tunnelMap ?? {})) {
    if (host !== local && !host.startsWith(`${local}/`)) continue;
    return forward?.fingerprint === fingerprint;
  }
  return false;
}

/**
 * The conversation seen through the proxy, against the node's own
 * fingerprint, with a credential injected, before the commit was made.
 *
 * The time ordering is the load-bearing part: a proxy line written after the
 * fact could have been produced by anything, whereas a line that precedes the
 * commit is the master watching work it had already routed to that node.
 */
export function checkProxy(
  entries,
  { conversationId, committedAt, fingerprint, tunnelMap },
) {
  if (!tunnelMap || Object.keys(tunnelMap).length === 0) {
    return {
      ok: false,
      reason: "no tunnel map: a 127.0.0.1 host proves nothing",
    };
  }
  if (!conversationId) {
    return { ok: false, reason: "no conversation to look for" };
  }

  const forConversation = entries.filter(
    (entry) => entry.conversationId === conversationId,
  );
  if (forConversation.length === 0) {
    return { ok: false, reason: `${conversationId} never reached the proxy` };
  }

  // "Through the injecting proxy" is part of the claim, so a line the proxy
  // refused, or served without resolving a credential, does not support it.
  const proxied = forConversation.filter(
    (entry) => entry.outcome === "proxied" && entry.credential === "injected",
  );
  if (proxied.length === 0) {
    return {
      ok: false,
      reason: `${conversationId} reached the proxy but was never proxied with a credential`,
    };
  }

  const fromNode = proxied.filter(
    (entry) => entry.entryFingerprint === fingerprint,
  );
  if (fromNode.length === 0) {
    return {
      ok: false,
      reason: `${conversationId} was proxied, but never to ${fingerprint}`,
    };
  }

  const commitTime = Date.parse(committedAt);
  const before = fromNode.filter((entry) => Date.parse(entry.ts) <= commitTime);
  if (before.length === 0) {
    return {
      ok: false,
      reason: `every proxy line for ${conversationId} is after the commit`,
    };
  }

  const tunnelled = before.filter((entry) =>
    isTunnelledToNode(entry, tunnelMap, fingerprint),
  );
  if (tunnelled.length === 0) {
    return {
      ok: false,
      reason: "no proxy line forwards, per the tunnel map, to that fingerprint",
    };
  }

  return {
    ok: true,
    reason: `${tunnelled.length} proxy line(s) before the commit`,
  };
}

/**
 * Every string anywhere in a value, so a subject is compared against what an
 * event actually contains rather than against its JSON encoding. A subject
 * holding a quote or a backslash never matches a serialised event, because
 * the serialised form has escaped it.
 */
export function collectStrings(value, into = []) {
  if (typeof value === "string") into.push(value);
  else if (Array.isArray(value))
    for (const item of value) collectStrings(item, into);
  else if (value && typeof value === "object")
    for (const item of Object.values(value)) collectStrings(item, into);
  return into;
}

/**
 * An agent-sourced event in the conversation naming the commit's own subject.
 *
 * The source filter is what stops the master satisfying this link with its
 * own prompt: a user message asking for a commit with a given subject
 * contains that subject just as surely as the agent's own tool call does.
 *
 * The subject is matched as a substring because the node writes it inside a
 * bash command, where it is one field among many rather than a whole payload.
 */
export function checkEvents(events, { subject }) {
  if (!Array.isArray(events) || events.length === 0) {
    return { ok: false, reason: "no events exported for this conversation" };
  }
  const needle = String(subject ?? "").trim();
  if (!needle) return { ok: false, reason: "commit has no subject" };

  const fromAgent = events.filter((event) => event?.source === "agent");
  if (fromAgent.length === 0) {
    return { ok: false, reason: "no agent-sourced events in the export" };
  }

  const hit = fromAgent.find((event) =>
    collectStrings(event).some((text) => text.includes(needle)),
  );
  if (!hit) {
    return { ok: false, reason: `no agent event names "${needle}"` };
  }
  return { ok: true, reason: `event ${hit.id ?? "?"} names it` };
}

/** One commit, four links. */
export function verifyCommit(commit, context) {
  const signature = context.verifySignature(commit.sha);
  const trailers = checkTrailers(commit, context);
  const proxy = checkProxy(context.proxyEntries, {
    conversationId: trailers.conversationId,
    committedAt: commit.committedAt,
    fingerprint: context.fingerprint,
    tunnelMap: context.tunnelMap,
  });
  const events = checkEvents(context.eventsFor(trailers.conversationId), {
    subject: commit.subject,
  });

  const links = { signature, trailers, proxy, events };
  return {
    sha: commit.sha,
    subject: commit.subject,
    conversationId: trailers.conversationId,
    links,
    ok: Object.values(links).every((link) => link.ok),
  };
}

/**
 * @param {{ exemptShas?: Iterable<string> }} context exemptions come from the
 * operator, on the command line. Nothing written inside a commit can exempt
 * it: author and committer are attacker-chosen strings, so a name-based
 * exemption is one environment variable away from exempting anything. An
 * `--exempt` that matches no commit fails the run rather than being ignored,
 * because a stale exemption is how a real commit stops being checked.
 */
export function verifyChain(commits, context) {
  const exempt = [...(context.exemptShas ?? [])].map((sha) =>
    String(sha).toLowerCase(),
  );
  const matches = (commit, sha) =>
    sha.length >= 7 && commit.sha.toLowerCase().startsWith(sha);
  const isExempt = (commit) => exempt.some((sha) => matches(commit, sha));

  const skipped = commits.filter(isExempt);
  const rows = commits
    .filter((commit) => !isExempt(commit))
    .map((commit) => verifyCommit(commit, context));
  const unmatched = exempt.filter(
    (sha) => !commits.some((commit) => matches(commit, sha)),
  );

  return {
    ok:
      rows.length > 0 && rows.every((row) => row.ok) && unmatched.length === 0,
    empty: rows.length === 0,
    rows,
    skipped,
    unmatched,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Gathering
// ───────────────────────────────────────────────────────────────────────────

function git(args, { repo }) {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
}

/**
 * Commits in the range, oldest first.
 *
 * Read one at a time rather than as one delimited stream: a commit message is
 * arbitrary text and can contain whichever separator the format picked, which
 * splits the record and silently truncates the trailers that follow it.
 */
export function readCommits(range, { repo }) {
  const shas = git(["log", "--format=%H", range], { repo })
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .reverse();

  return shas.map((sha) => {
    const [
      subject,
      committedAt,
      authorName,
      authorEmail,
      committerName,
      committerEmail,
    ] = git(["show", "-s", "--format=%s%n%cI%n%an%n%ae%n%cn%n%ce", sha], {
      repo,
    }).split("\n");
    return {
      sha,
      subject,
      committedAt,
      authorName,
      authorEmail,
      committerName,
      committerEmail,
      message: git(["show", "-s", "--format=%B", sha], { repo }),
    };
  });
}

/** `SHA256:...` for a public key file, as `ssh-keygen -lf` reports it. */
export function publicKeyFingerprint(publicKeyPath) {
  const output = execFileSync("ssh-keygen", ["-lf", publicKeyPath], {
    encoding: "utf8",
  });
  const match = output.match(/(SHA256:[A-Za-z0-9+/=]+)/);
  if (!match)
    throw new Error(`cannot read a fingerprint from ${publicKeyPath}`);
  return match[1];
}

/**
 * Verifies against the node's public key alone, in a throwaway allowed-signers
 * file. Deliberately NOT the operator's `~/.ssh/allowed_signers`: a chain that
 * passes because the master's own key is trusted proves the opposite of what
 * this script is for.
 *
 * `expectedFingerprint` is the trust anchor. It is meant to come from the
 * run's published record, so the master cannot substitute a key it holds the
 * private half of.
 */
export function createSignatureVerifier({
  repo,
  publicKeyPath,
  expectedFingerprint,
}) {
  const actual = publicKeyFingerprint(publicKeyPath);
  if (expectedFingerprint && actual !== expectedFingerprint) {
    throw new Error(
      `${publicKeyPath} is ${actual}, not the published ${expectedFingerprint}`,
    );
  }

  const publicKey = readFileSync(publicKeyPath, "utf8").trim();
  // The key type is read from the file rather than assumed: an allowed-signers
  // line whose label disagrees with its key body never matches, which would
  // fail every commit on a node that does not sign with ed25519.
  const [keyType, keyBody] = publicKey.split(/\s+/);
  const allowedDir = mkdtempSync(path.join(tmpdir(), "fleet-chain-"));
  const allowedSigners = path.join(allowedDir, "allowed_signers");
  // The principal is a wildcard because the node signs as the same GitHub
  // identity as the master; the key, not the email, is the evidence here.
  writeFileSync(allowedSigners, `* ${keyType} ${keyBody}\n`, "utf8");

  return (sha) => {
    // spawnSync, not execFileSync: git writes the verification result to
    // stderr on BOTH outcomes, and the key fingerprint in that line is the
    // part worth keeping in the report.
    const result = spawnSync(
      "git",
      [
        "-C",
        repo,
        "-c",
        "gpg.format=ssh",
        "-c",
        `gpg.ssh.allowedSignersFile=${allowedSigners}`,
        "verify-commit",
        sha,
      ],
      { encoding: "utf8" },
    );
    const stderr = String(result.stderr ?? "");
    // A signature from a key that is valid but not this one reports
    // `Good "git" signature with ED25519 key ...` -- no `for <principal>` --
    // and exits non-zero. Repeating that line as the reason on a failed link
    // puts the word "Good" next to the word FAIL in the operator's report.
    const ok = result.status === 0 && /Good "git" signature for /.test(stderr);
    if (ok) return { ok, reason: firstLine(stderr) || "good signature" };
    const detail = firstLine(stderr);
    return {
      ok,
      reason: `not signed by ${actual}${detail ? ` (${detail})` : ""}`,
    };
  };
}

function firstLine(text) {
  return String(text ?? "")
    .trim()
    .split("\n")[0];
}

/**
 * `<events dir>/<conversation id>.json`, exported by the master over HTTP
 * through the proxy at each milestone. Accepts either a bare array or the
 * agent server's `{ items: [...] }` search response. The filename is matched
 * exactly, so events for `conv-1a` are never pooled into `conv-1`.
 */
export function createEventsReader(directory) {
  const cache = new Map();
  return (conversationId) => {
    if (!conversationId) return [];
    if (cache.has(conversationId)) return cache.get(conversationId);

    let events = [];
    try {
      const parsed = JSON.parse(
        readFileSync(path.join(directory, `${conversationId}.json`), "utf8"),
      );
      events = Array.isArray(parsed) ? parsed : (parsed?.items ?? []);
    } catch {
      events = [];
    }
    cache.set(conversationId, events);
    return events;
  };
}

// ───────────────────────────────────────────────────────────────────────────
// CLI
// ───────────────────────────────────────────────────────────────────────────

export function parseArgs(argv) {
  const options = {
    repo: process.cwd(),
    range: null,
    signingKey: null,
    signingKeyFingerprint: null,
    fingerprint: null,
    runNonce: null,
    proxyLog: null,
    tunnelMap: null,
    eventsDir: null,
    exempt: [],
  };
  // Null prototype: a bare `toString` in argv would otherwise resolve through
  // Object.prototype and silently swallow the argument after it.
  const flags = Object.assign(Object.create(null), {
    "--repo": "repo",
    "--range": "range",
    "--signing-key": "signingKey",
    "--signing-key-fingerprint": "signingKeyFingerprint",
    "--fingerprint": "fingerprint",
    "--run-nonce": "runNonce",
    "--proxy-log": "proxyLog",
    "--tunnel-map": "tunnelMap",
    "--events-dir": "eventsDir",
  });
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--exempt") {
      const sha = argv[++i];
      if (sha) options.exempt.push(sha);
      continue;
    }
    const key = flags[argv[i]];
    if (key) options[key] = argv[++i];
  }
  return options;
}

const REQUIRED = [
  ["range", "--range origin/main..<head>"],
  ["signingKey", "--signing-key evidence/node-signing-key.pub"],
  [
    "signingKeyFingerprint",
    "--signing-key-fingerprint SHA256:... (from the run's published issue)",
  ],
  ["fingerprint", "--fingerprint SHA256:..."],
  ["runNonce", "--run-nonce <hex>"],
  ["proxyLog", "--proxy-log <rig>/evidence/proxy-access.jsonl"],
  ["tunnelMap", "--tunnel-map evidence/tunnel-map.json"],
  ["eventsDir", "--events-dir evidence/events"],
];

export function render(result) {
  const lines = [];
  for (const row of result.rows) {
    lines.push(
      `${row.ok ? "PASS" : "FAIL"}  ${row.sha.slice(0, 12)}  ${row.subject}`,
    );
    for (const [name, link] of Object.entries(row.links)) {
      lines.push(
        `        ${link.ok ? "ok  " : "FAIL"} ${name.padEnd(9)} ${link.reason}`,
      );
    }
  }
  for (const commit of result.skipped) {
    lines.push(
      `SKIP  ${commit.sha.slice(0, 12)}  ${commit.subject}  (exempted on the command line)`,
    );
  }
  for (const sha of result.unmatched) {
    lines.push(`FAIL  --exempt ${sha} matches no commit in the range`);
  }
  if (result.empty) {
    lines.push("FAIL  no commits left to verify in range");
  }
  lines.push("");
  lines.push(result.ok ? "CHAIN VERIFIED" : "CHAIN BROKEN");
  return lines.join("\n");
}

/** Reads one input, naming which one failed rather than throwing a bare stack. */
function readInput(label, file, parse) {
  try {
    return parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`cannot read ${label} at ${file}: ${error.message}`);
  }
}

function main(argv) {
  const options = parseArgs(argv);
  const missing = REQUIRED.filter(([key]) => !options[key]);
  if (missing.length > 0) {
    console.error("missing required option(s):");
    for (const [, usage] of missing) console.error(`  ${usage}`);
    return 2;
  }

  let commits;
  let context;
  try {
    // An events directory that is not there would otherwise fail every commit
    // on link 4 and read as a broken chain rather than a broken invocation.
    statSync(options.eventsDir);
    commits = readCommits(options.range, { repo: options.repo });
    context = {
      runNonce: options.runNonce,
      fingerprint: options.fingerprint,
      exemptShas: options.exempt,
      proxyEntries: readInput("the proxy log", options.proxyLog, parseProxyLog),
      tunnelMap: readInput("the tunnel map", options.tunnelMap, JSON.parse),
      verifySignature: createSignatureVerifier({
        repo: options.repo,
        publicKeyPath: options.signingKey,
        expectedFingerprint: options.signingKeyFingerprint,
      }),
      eventsFor: createEventsReader(options.eventsDir),
    };
  } catch (error) {
    // Exit 2, not 1: "the check could not run" and "the chain is broken" are
    // different answers, and a wrapper has to be able to tell them apart.
    console.error(`cannot verify: ${error.message}`);
    return 2;
  }

  const result = verifyChain(commits, context);
  console.log(render(result));
  return result.ok ? 0 : 1;
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  process.exit(main(process.argv.slice(2)));
}
