#!/usr/bin/env node
/**
 * Verifies that every commit on a fleet node's branch was made BY that node,
 * THROUGH the injecting proxy, INSIDE a conversation the master can point at.
 *
 * A green PR proves nothing about where the work happened: `gh` on the node
 * authenticates as the same GitHub account as the master, so GitHub cannot
 * tell the two apart. Four independent links can:
 *
 *   1  signature   a good SSH signature from a key generated ON the node,
 *                  whose private half never left it. This is the only link
 *                  that covers the git push, which is not proxy-observable.
 *   2  trailers    `Fleet-Conversation` and `Fleet-Run` on the commit, the
 *                  run nonce matching the one published in the issue before
 *                  any of this existed.
 *   3  proxy       that conversation seen in the proxy's access log against
 *                  an entry whose fingerprint is the node's SSH host key, at
 *                  a time before the commit was made. The tunnel map is
 *                  required because the rig reaches the node through an SSH
 *                  forward, so a bare `127.0.0.1` host in the log would
 *                  otherwise prove nothing about which machine answered.
 *   4  events      an agent event in that conversation naming the commit's
 *                  own subject line.
 *
 * Any failing row fails the run, even when the PR is green. Commits authored
 * by `allhands-bot` are exempt (CI workflows push them) and are listed
 * explicitly rather than silently dropped.
 *
 *   node scripts/verify-fleet-chain.mjs \
 *     --range origin/main..fleet/stale-ui \
 *     --signing-key evidence/node-signing-key.pub \
 *     --fingerprint SHA256:zCJ... \
 *     --run-nonce 0123456789abcdef0123456789abcdef \
 *     --proxy-log /tmp/fleet-rig-.../evidence/proxy-access.jsonl \
 *     --tunnel-map evidence/tunnel-map.json \
 *     --events-dir evidence/events
 *
 * Exits 0 when every link holds for every commit, 1 otherwise.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const BOT_AUTHORS = Object.freeze(["allhands-bot"]);
// ASCII record/unit separators: a commit message holds arbitrary printable
// text, including newlines, so the log format cannot be delimited by one.
const RECORD_SEPARATOR = "\x1e";
const FIELD_SEPARATOR = "\x1f";

// ───────────────────────────────────────────────────────────────────────────
// Pure checks
// ───────────────────────────────────────────────────────────────────────────

/** `true` when CI, not the node, made this commit. Exempt from the chain. */
export function isBotCommit(commit) {
  const who = `${commit.authorName} <${commit.authorEmail}> ${commit.committerName} <${commit.committerEmail}>`;
  return BOT_AUTHORS.some((bot) => who.includes(bot));
}

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

/** Trailer values from a full commit message, as `git interpret-trailers` sees them. */
export function readTrailers(message) {
  const trailers = {};
  for (const line of String(message ?? "").split("\n")) {
    const match = line.match(/^([A-Za-z][A-Za-z0-9-]*):[ \t]+(.+?)\s*$/);
    if (match) trailers[match[1]] = match[2];
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
 * The conversation seen through the proxy, against the node's own
 * fingerprint, before the commit was made.
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
  if (!conversationId)
    return { ok: false, reason: "no conversation to look for" };

  const forConversation = entries.filter(
    (entry) => entry.conversationId === conversationId,
  );
  if (forConversation.length === 0) {
    return { ok: false, reason: `${conversationId} never reached the proxy` };
  }

  const fromNode = forConversation.filter(
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

  const tunnelled = before.some((entry) => isTunnelledToNode(entry, tunnelMap));
  if (!tunnelled) {
    return {
      ok: false,
      reason: `no proxy line resolves through the tunnel map to the node`,
    };
  }

  return {
    ok: true,
    reason: `${before.length} proxy line(s) before the commit`,
  };
}

/**
 * `{ "http://127.0.0.1:39123": { host, sshTarget } }` -- the SSH `-L` forward
 * the rig opened. An entry host that is not in the map is not the node.
 */
export function isTunnelledToNode(entry, tunnelMap) {
  const host = entry.entryHost;
  if (!host) return false;
  return Object.keys(tunnelMap).some(
    (local) => host === local || host.startsWith(`${local}/`),
  );
}

/**
 * An agent event in the conversation naming the commit's own subject.
 *
 * The subject is matched as a substring of the serialised event because the
 * node writes it inside a bash command (`git commit -m "..."`), where it is
 * one field among many rather than the whole payload.
 */
export function checkEvents(events, { subject }) {
  if (!Array.isArray(events) || events.length === 0) {
    return { ok: false, reason: "no events exported for this conversation" };
  }
  const needle = subject.trim();
  if (!needle) return { ok: false, reason: "commit has no subject" };

  const hit = events.find((event) => JSON.stringify(event).includes(needle));
  if (!hit) {
    return { ok: false, reason: `no event names "${needle}"` };
  }
  return {
    ok: true,
    reason: `event ${hit.id ?? hit.event_id ?? "?"} names it`,
  };
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

export function verifyChain(commits, context) {
  const bots = commits.filter(isBotCommit);
  const nodeCommits = commits.filter((commit) => !isBotCommit(commit));
  const rows = nodeCommits.map((commit) => verifyCommit(commit, context));
  return {
    ok: rows.length > 0 && rows.every((row) => row.ok),
    empty: rows.length === 0,
    rows,
    bots,
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

export function readCommits(range, { repo }) {
  const format = ["%H", "%s", "%cI", "%an", "%ae", "%cn", "%ce", "%B"].join(
    FIELD_SEPARATOR,
  );
  const raw = git(["log", `--format=${format}${RECORD_SEPARATOR}`, range], {
    repo,
  });
  return raw
    .split(RECORD_SEPARATOR)
    .map((record) => record.replace(/^\n/, ""))
    .filter((record) => record.trim() !== "")
    .map((record) => {
      const [
        sha,
        subject,
        committedAt,
        authorName,
        authorEmail,
        committerName,
        committerEmail,
        message,
      ] = record.split(FIELD_SEPARATOR);
      return {
        sha,
        subject,
        committedAt,
        authorName,
        authorEmail,
        committerName,
        committerEmail,
        message,
      };
    })
    .reverse();
}

/**
 * Verifies against the node's public key alone, in a throwaway allowed-signers
 * file. Deliberately NOT the operator's `~/.ssh/allowed_signers`: a chain that
 * passes because the master's own key is trusted proves the opposite of what
 * this script is for.
 */
export function createSignatureVerifier({ repo, publicKeyPath }) {
  const publicKey = readFileSync(publicKeyPath, "utf8").trim();
  const [, keyBody] = publicKey.split(/\s+/);
  const allowedDir = mkdtempSync(path.join(tmpdir(), "fleet-chain-"));
  const allowedSigners = path.join(allowedDir, "allowed_signers");
  // The principal is a wildcard because the node signs as the same GitHub
  // identity as the master; the key, not the email, is the evidence here.
  writeFileSync(allowedSigners, `* ssh-ed25519 ${keyBody}\n`, "utf8");

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
    const ok = result.status === 0 && /Good "git" signature/.test(stderr);
    return {
      ok,
      reason: firstLine(stderr) || (ok ? "good signature" : "no signature"),
    };
  };
}

function firstLine(text) {
  return (
    String(text ?? "")
      .trim()
      .split("\n")[0] ?? ""
  );
}

/**
 * `evidence/events/<conversation id>.json`, exported by the master over HTTP
 * through the proxy at each milestone. Accepts either a bare array or the
 * agent server's `{ items: [...] }` search response.
 */
export function createEventsReader(directory) {
  const cache = new Map();
  return (conversationId) => {
    if (!conversationId) return [];
    if (cache.has(conversationId)) return cache.get(conversationId);

    let events = [];
    try {
      const names = readdirSync(directory).filter(
        (name) => name.startsWith(conversationId) && name.endsWith(".json"),
      );
      events = names.flatMap((name) => {
        const parsed = JSON.parse(
          readFileSync(path.join(directory, name), "utf8"),
        );
        return Array.isArray(parsed) ? parsed : (parsed?.items ?? []);
      });
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
    fingerprint: null,
    runNonce: null,
    proxyLog: null,
    tunnelMap: null,
    eventsDir: null,
  };
  const flags = {
    "--repo": "repo",
    "--range": "range",
    "--signing-key": "signingKey",
    "--fingerprint": "fingerprint",
    "--run-nonce": "runNonce",
    "--proxy-log": "proxyLog",
    "--tunnel-map": "tunnelMap",
    "--events-dir": "eventsDir",
  };
  for (let i = 0; i < argv.length; i++) {
    const key = flags[argv[i]];
    if (key) options[key] = argv[++i];
  }
  return options;
}

const REQUIRED = [
  ["range", "--range origin/main..<head>"],
  ["signingKey", "--signing-key evidence/node-signing-key.pub"],
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
  for (const bot of result.bots) {
    lines.push(
      `SKIP  ${bot.sha.slice(0, 12)}  ${bot.subject}  (${bot.authorName}, exempt)`,
    );
  }
  if (result.empty) {
    lines.push("FAIL  no node commits in range: nothing to verify");
  }
  lines.push("");
  lines.push(result.ok ? "CHAIN VERIFIED" : "CHAIN BROKEN");
  return lines.join("\n");
}

function main(argv) {
  const options = parseArgs(argv);
  const missing = REQUIRED.filter(([key]) => !options[key]);
  if (missing.length > 0) {
    console.error("missing required option(s):");
    for (const [, usage] of missing) console.error(`  ${usage}`);
    return 2;
  }

  const commits = readCommits(options.range, { repo: options.repo });
  const result = verifyChain(commits, {
    runNonce: options.runNonce,
    fingerprint: options.fingerprint,
    proxyEntries: parseProxyLog(readFileSync(options.proxyLog, "utf8")),
    tunnelMap: JSON.parse(readFileSync(options.tunnelMap, "utf8")),
    verifySignature: createSignatureVerifier({
      repo: options.repo,
      publicKeyPath: options.signingKey,
    }),
    eventsFor: createEventsReader(options.eventsDir),
  });

  console.log(render(result));
  return result.ok ? 0 : 1;
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  process.exit(main(process.argv.slice(2)));
}
