import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  checkEvents,
  checkProxy,
  checkTrailers,
  createSignatureVerifier,
  isBotCommit,
  parseProxyLog,
  readCommits,
  readTrailers,
  verifyChain,
} from "../../scripts/verify-fleet-chain.mjs";

const NONCE = "0123456789abcdef0123456789abcdef";
const FINGERPRINT = "SHA256:node-host-key";
const TUNNEL_MAP = {
  "http://127.0.0.1:39123": {
    host: "100.125.222.64:8000",
    sshTarget: "claude@node",
  },
};

function proxyLine(overrides: Record<string, unknown> = {}) {
  return {
    ts: "2026-09-07T10:00:00.000Z",
    kind: "http",
    method: "GET",
    url: "/backend/abc/api/conversations/conv-1/events/search",
    conversationId: "conv-1",
    entryId: "abc",
    entryName: "claude-hetzner",
    entryFingerprint: FINGERPRINT,
    entryHost: "http://127.0.0.1:39123",
    credential: "injected",
    outcome: "proxied",
    error: null,
    ...overrides,
  };
}

describe("parseProxyLog", () => {
  it("skips a half-written trailing line rather than throwing", () => {
    const text = `${JSON.stringify(proxyLine())}\n{"ts":"2026-`;
    expect(parseProxyLog(text)).toHaveLength(1);
  });
});

describe("readTrailers", () => {
  it("reads the fleet trailers off the end of a message", () => {
    const message = [
      "feat(backends): surface stale entries",
      "",
      "Body text.",
      "",
      "Fleet-Conversation: conv-1",
      `Fleet-Run: ${NONCE}`,
    ].join("\n");

    expect(readTrailers(message)).toMatchObject({
      "Fleet-Conversation": "conv-1",
      "Fleet-Run": NONCE,
    });
  });
});

describe("checkTrailers", () => {
  const commit = (message: string) => ({ message }) as never;

  it("passes when both trailers are present and the nonce matches", () => {
    const result = checkTrailers(
      commit(`x\n\nFleet-Conversation: conv-1\nFleet-Run: ${NONCE}`),
      { runNonce: NONCE },
    );
    expect(result).toMatchObject({ ok: true, conversationId: "conv-1" });
  });

  it("fails a commit that carries someone else's run nonce", () => {
    const result = checkTrailers(
      commit("x\n\nFleet-Conversation: conv-1\nFleet-Run: deadbeef"),
      { runNonce: NONCE },
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("not the published nonce");
  });

  it("fails a commit with no conversation at all", () => {
    expect(checkTrailers(commit("x"), { runNonce: NONCE }).ok).toBe(false);
  });
});

describe("checkProxy", () => {
  const base = {
    conversationId: "conv-1",
    committedAt: "2026-09-07T10:05:00.000Z",
    fingerprint: FINGERPRINT,
    tunnelMap: TUNNEL_MAP,
  };

  it("passes on a line for that conversation, to that node, before the commit", () => {
    expect(checkProxy([proxyLine()], base).ok).toBe(true);
  });

  it("fails when the conversation never reached the proxy", () => {
    expect(
      checkProxy([proxyLine({ conversationId: "other" })], base),
    ).toMatchObject({
      ok: false,
    });
  });

  it("fails when the proxied entry is not the node's fingerprint", () => {
    const result = checkProxy(
      [proxyLine({ entryFingerprint: "SHA256:some-other-machine" })],
      base,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("never to");
  });

  it("fails when every proxy line postdates the commit", () => {
    const result = checkProxy(
      [proxyLine({ ts: "2026-09-07T11:00:00.000Z" })],
      base,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("after the commit");
  });

  it("fails with no tunnel map, because a loopback host proves nothing", () => {
    const result = checkProxy([proxyLine()], { ...base, tunnelMap: {} });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("tunnel map");
  });

  it("fails when the entry host is not the forward the rig opened", () => {
    const result = checkProxy(
      [proxyLine({ entryHost: "http://127.0.0.1:9999" })],
      base,
    );
    expect(result.ok).toBe(false);
  });
});

describe("checkEvents", () => {
  it("passes when an event names the commit subject", () => {
    const events = [
      {
        id: "e1",
        kind: "ActionAction",
        command: 'git commit -m "feat: surface stale"',
      },
    ];
    expect(checkEvents(events, { subject: "feat: surface stale" }).ok).toBe(
      true,
    );
  });

  it("fails when the conversation has no events exported", () => {
    expect(checkEvents([], { subject: "feat: x" }).ok).toBe(false);
  });

  it("fails when no event mentions the subject", () => {
    expect(
      checkEvents([{ id: "e1", command: "npm test" }], { subject: "feat: x" })
        .ok,
    ).toBe(false);
  });
});

describe("isBotCommit", () => {
  it("exempts a CI commit and holds a node commit to the chain", () => {
    const bot = {
      authorName: "allhands-bot",
      authorEmail: "bot@example.com",
      committerName: "GitHub",
      committerEmail: "noreply@github.com",
    };
    const node = {
      authorName: "Steven Gonsalvez",
      authorEmail: "steven.gonsalvez@gmail.com",
      committerName: "Steven Gonsalvez",
      committerEmail: "steven.gonsalvez@gmail.com",
    };
    expect(isBotCommit(bot as never)).toBe(true);
    expect(isBotCommit(node as never)).toBe(false);
  });
});

describe("verifyChain", () => {
  it("fails an empty range: no node commits is not a pass", () => {
    const result = verifyChain([], {
      runNonce: NONCE,
      fingerprint: FINGERPRINT,
      proxyEntries: [],
      tunnelMap: TUNNEL_MAP,
      verifySignature: () => ({ ok: true, reason: "" }),
      eventsFor: () => [],
    } as never);
    expect(result.ok).toBe(false);
    expect(result.empty).toBe(true);
  });
});

/**
 * The falsifier for link 1, run against real git and real ssh-keygen: a commit
 * signed by the node's key passes, and the same tree signed by any other key
 * fails. Without this the whole chain reduces to "the master says so".
 */
describe("createSignatureVerifier (real git, real keys)", () => {
  let root: string;
  let repo: string;
  let nodeKeyPub: string;
  let signedByNode: string;
  let signedByImposter: string;

  function git(args: string[], cwd = repo) {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
    }).trim();
  }

  function keypair(name: string) {
    const file = path.join(root, name);
    execFileSync(
      "ssh-keygen",
      ["-t", "ed25519", "-N", "", "-C", name, "-f", file],
      {
        stdio: "ignore",
      },
    );
    return { private: file, public: `${file}.pub` };
  }

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "fleet-chain-test-"));
    repo = path.join(root, "repo");
    const node = keypair("node-key");
    const imposter = keypair("imposter-key");
    nodeKeyPub = node.public;

    execFileSync("git", ["init", "-q", "-b", "main", repo], {
      stdio: "ignore",
    });
    for (const [key, value] of [
      ["user.name", "Steven Gonsalvez"],
      ["user.email", "steven.gonsalvez@gmail.com"],
      ["gpg.format", "ssh"],
      ["commit.gpgsign", "true"],
    ]) {
      git(["config", key, value]);
    }

    await writeFile(path.join(repo, "a.txt"), "one\n");
    git(["add", "a.txt"]);
    git(["config", "user.signingkey", node.public]);
    git([
      "commit",
      "-q",
      "-m",
      `feat: node commit\n\nFleet-Conversation: conv-1\nFleet-Run: ${NONCE}`,
    ]);
    signedByNode = git(["rev-parse", "HEAD"]);

    await writeFile(path.join(repo, "b.txt"), "two\n");
    git(["add", "b.txt"]);
    git(["config", "user.signingkey", imposter.public]);
    git(["commit", "-q", "-m", "feat: imposter commit"]);
    signedByImposter = git(["rev-parse", "HEAD"]);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("accepts a commit signed by the node's key", () => {
    const verify = createSignatureVerifier({ repo, publicKeyPath: nodeKeyPub });
    expect(verify(signedByNode).ok).toBe(true);
  });

  it("rejects a commit signed by any other key, however valid its signature", () => {
    const verify = createSignatureVerifier({ repo, publicKeyPath: nodeKeyPub });
    expect(verify(signedByImposter).ok).toBe(false);
  });

  it("reads subject, committer date and full message back off the log", () => {
    const commits = readCommits(`${signedByNode}..${signedByImposter}`, {
      repo,
    });
    expect(commits).toHaveLength(1);
    expect(commits[0]).toMatchObject({
      sha: signedByImposter,
      subject: "feat: imposter commit",
      authorName: "Steven Gonsalvez",
    });
    expect(Number.isNaN(Date.parse(commits[0].committedAt))).toBe(false);
  });

  it("verifies a whole range end to end, four links deep", () => {
    // The node commit is the root, so it has no `~1` to range against.
    const commits = readCommits(signedByNode, { repo });
    const result = verifyChain(commits, {
      runNonce: NONCE,
      fingerprint: FINGERPRINT,
      proxyEntries: [proxyLine({ ts: commits[0].committedAt })],
      tunnelMap: TUNNEL_MAP,
      verifySignature: createSignatureVerifier({
        repo,
        publicKeyPath: nodeKeyPub,
      }),
      eventsFor: () => [
        { id: "e1", command: 'git commit -m "feat: node commit"' },
      ],
    } as never);

    expect(result.rows[0].links).toMatchObject({
      signature: { ok: true },
      trailers: { ok: true },
      proxy: { ok: true },
      events: { ok: true },
    });
    expect(result.ok).toBe(true);
  });
});
