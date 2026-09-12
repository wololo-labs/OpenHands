import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  answeredByNode,
  checkEvents,
  checkProxy,
  checkTrailers,
  collectStrings,
  createSignatureVerifier,
  isTunnelledToNode,
  parseProxyLog,
  publicKeyFingerprint,
  readCommits,
  readTrailers,
  verifyChain,
} from "../../scripts/verify-fleet-chain.mjs";

const NONCE = "0123456789abcdef0123456789abcdef";
const FINGERPRINT = "SHA256:node-host-key";
const LOCAL = "http://127.0.0.1:39123";
const TUNNEL_MAP = {
  [LOCAL]: {
    node: "claude-hetzner",
    ssh: "claude@100.125.222.64",
    remote: "127.0.0.1:8000",
    fingerprint: FINGERPRINT,
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
    entryHost: LOCAL,
    credential: "injected",
    outcome: "proxied:200",
    error: null,
    ...overrides,
  };
}

function agentEvent(text: string) {
  return { id: "e1", source: "agent", kind: "ACPToolCallEvent", title: text };
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

  it("reads only the trailing block, so a decoy in the body is not a trailer", () => {
    const message = [
      "feat: x",
      "",
      "Fleet-Conversation: decoy",
      "",
      "Fleet-Conversation: real",
    ].join("\n");

    expect(readTrailers(message)).toMatchObject({
      "Fleet-Conversation": "real",
    });
  });

  it("accepts no space after the colon, as git interpret-trailers does", () => {
    expect(readTrailers("x\n\nFleet-Run:abc")).toMatchObject({
      "Fleet-Run": "abc",
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

describe("isTunnelledToNode", () => {
  it("requires the forward to reach that fingerprint, not merely to exist", () => {
    // Membership of the key set only says the port is one the map mentions.
    expect(isTunnelledToNode(proxyLine(), TUNNEL_MAP, FINGERPRINT)).toBe(true);
    expect(isTunnelledToNode(proxyLine(), { [LOCAL]: null }, FINGERPRINT)).toBe(
      false,
    );
    expect(
      isTunnelledToNode(
        proxyLine(),
        { [LOCAL]: { fingerprint: "SHA256:another-machine" } },
        FINGERPRINT,
      ),
    ).toBe(false);
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
    ).toMatchObject({ ok: false });
  });

  it("fails when nothing was actually proxied with a credential", () => {
    // "Through the injecting proxy" is part of the claim, so a refusal, or a
    // request served without resolving a credential, does not support it.
    for (const line of [
      proxyLine({ outcome: "refused:403", credential: "none" }),
      proxyLine({ credential: "none" }),
    ]) {
      const result = checkProxy([line], base);
      expect(result.ok).toBe(false);
      expect(result.reason).toContain("never answered by the node");
    }
  });

  /**
   * The hole this closes: anyone holding the master key can address
   * `/backend/<node>/api/conversations/<invented id>` at a real node. The
   * request is proxied, a credential IS injected, and the node 404s it. Taken
   * as proof, that mints link 3 for a conversation in which nothing ever ran.
   */
  it("fails on a line the node answered with an error", () => {
    for (const outcome of ["proxied:404", "proxied:401", "proxied:502"]) {
      const result = checkProxy([proxyLine({ outcome })], base);
      expect(result.ok).toBe(false);
      expect(result.reason).toContain("never answered by the node");
    }
  });

  it("fails on a log written before the node's status was recorded", () => {
    // A bare `proxied` cannot tell a served request from a refused one, so it
    // verifies as broken rather than as proof.
    const result = checkProxy([proxyLine({ outcome: "proxied" })], base);
    expect(result.ok).toBe(false);
  });

  it("passes on an accepted event socket", () => {
    expect(checkProxy([proxyLine({ outcome: "proxied:101" })], base).ok).toBe(
      true,
    );
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

  it("fails when the tunnel map's forward reaches a different machine", () => {
    const result = checkProxy([proxyLine()], {
      ...base,
      tunnelMap: { [LOCAL]: { fingerprint: "SHA256:another-machine" } },
    });
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

describe("collectStrings", () => {
  it("finds strings at any depth, so a subject is matched unescaped", () => {
    expect(
      collectStrings({ a: [{ b: 'git commit -m "fix: quoted"' }] }),
    ).toEqual(['git commit -m "fix: quoted"']);
  });
});

describe("checkEvents", () => {
  it("passes when an agent event names the commit subject", () => {
    expect(
      checkEvents([agentEvent('git commit -m "feat: surface stale"')], {
        subject: "feat: surface stale",
      }).ok,
    ).toBe(true);
  });

  it("rejects a subject that appears only in the master's own prompt", () => {
    // A user message asking for a commit with a given subject contains that
    // subject just as surely as the agent's own tool call does.
    const result = checkEvents(
      [{ id: "u1", source: "user", text: 'commit as "feat: surface stale"' }],
      { subject: "feat: surface stale" },
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("no agent-sourced events");
  });

  it("matches a subject containing quotes, which JSON encoding would escape", () => {
    const subject = 'fix: do not "crash" on null';
    expect(
      checkEvents([agentEvent(`git commit -m '${subject}'`)], { subject }).ok,
    ).toBe(true);
  });

  it("fails when the conversation has no events exported", () => {
    expect(checkEvents([], { subject: "feat: x" }).ok).toBe(false);
  });

  it("fails when no agent event mentions the subject", () => {
    expect(
      checkEvents([agentEvent("npm test")], { subject: "feat: x" }).ok,
    ).toBe(false);
  });

  it("fails, rather than throwing, on a commit with no subject", () => {
    expect(checkEvents([agentEvent("x")], { subject: undefined }).ok).toBe(
      false,
    );
  });
});

describe("verifyChain", () => {
  const passing = {
    runNonce: NONCE,
    fingerprint: FINGERPRINT,
    proxyEntries: [],
    tunnelMap: TUNNEL_MAP,
    verifySignature: () => ({ ok: true, reason: "" }),
    eventsFor: () => [],
  };

  const commit = (overrides: Record<string, unknown> = {}) =>
    ({
      sha: "a".repeat(40),
      subject: "feat: x",
      committedAt: "2026-09-07T10:05:00.000Z",
      authorName: "Steven Gonsalvez",
      authorEmail: "steven.gonsalvez@gmail.com",
      committerName: "Steven Gonsalvez",
      committerEmail: "steven.gonsalvez@gmail.com",
      message: "feat: x",
      ...overrides,
    }) as never;

  it("fails an empty range: no commits is not a pass", () => {
    const result = verifyChain([], passing as never);
    expect(result.ok).toBe(false);
    expect(result.empty).toBe(true);
  });

  it("does not exempt a commit on the strength of its own author name", () => {
    // `GIT_COMMITTER_NAME=allhands-bot git commit` would otherwise skip every
    // link without touching a key, a log or an event file.
    const forged = commit({ committerName: "allhands-bot" });
    const result = verifyChain([forged], passing as never);
    expect(result.skipped).toHaveLength(0);
    expect(result.rows).toHaveLength(1);
    expect(result.ok).toBe(false);
  });

  it("ignores a short sha, because a prefix can exempt more than one commit", () => {
    const result = verifyChain([commit()], {
      ...passing,
      exemptShas: ["a".repeat(7)],
    } as never);
    expect(result.skipped).toHaveLength(0);
    expect(result.unmatched).toEqual(["a".repeat(7)]);
  });

  it("exempts a commit named by sha on the command line, and says so", () => {
    const result = verifyChain([commit()], {
      ...passing,
      exemptShas: ["a".repeat(40)],
    } as never);
    expect(result.skipped).toHaveLength(1);
    // Exempting every commit leaves nothing verified, which is not a pass.
    expect(result.ok).toBe(false);
  });

  it("fails an --exempt that matches no commit, rather than ignoring it", () => {
    // A stale exemption is how a real commit quietly stops being checked.
    const result = verifyChain([commit()], {
      ...passing,
      exemptShas: ["b".repeat(40)],
    } as never);
    expect(result.unmatched).toEqual(["b".repeat(40)]);
    expect(result.ok).toBe(false);
  });
});

/**
 * The falsifiers for link 1, run against real git and real ssh-keygen: a
 * commit signed by the node's key passes, the same tree signed by any other
 * key fails, and the verifier refuses to start against a key whose
 * fingerprint is not the one published for the run. Without that last one the
 * chain reduces to "the master says so", because the master chooses which key
 * file to point at.
 */
describe("createSignatureVerifier (real git, real keys)", () => {
  let root: string;
  let repo: string;
  let nodeKeyPub: string;
  let nodeFingerprint: string;
  let imposterKeyPub: string;
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
      { stdio: "ignore" },
    );
    return { private: file, public: `${file}.pub` };
  }

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "fleet-chain-test-"));
    repo = path.join(root, "repo");
    const node = keypair("node-key");
    const imposter = keypair("imposter-key");
    nodeKeyPub = node.public;
    imposterKeyPub = imposter.public;
    nodeFingerprint = publicKeyFingerprint(nodeKeyPub);

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
    git(["config", "user.signingkey", node.public]);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function verifier(publicKeyPath = nodeKeyPub) {
    return createSignatureVerifier({
      repo,
      publicKeyPath,
      expectedFingerprint: publicKeyFingerprint(publicKeyPath),
    });
  }

  it("refuses to be built without an expected fingerprint at all", () => {
    // Omitting it used to skip the anchor check silently, which is the one
    // line that reverts the whole point of this verifier.
    expect(() =>
      // The cast is the test: TypeScript already refuses this call, and the
      // runtime guard is what protects a JS caller from making it anyway.
      createSignatureVerifier({
        repo,
        publicKeyPath: imposterKeyPub,
      } as never),
    ).toThrow(/requires expectedFingerprint/);
  });

  it("accepts a commit signed by the node's key", () => {
    expect(verifier()(signedByNode).ok).toBe(true);
  });

  it("rejects a commit signed by any other key, however valid its signature", () => {
    expect(verifier()(signedByImposter).ok).toBe(false);
  });

  it("does not report a failed link as a good signature", () => {
    // git says `Good "git" signature with ED25519 key ...` for a valid
    // signature by an untrusted key, which read as "Good" beside "FAIL".
    const result = verifier()(signedByImposter);
    expect(result.reason).toContain("not signed by");
    expect(result.reason.startsWith("Good")).toBe(false);
  });

  it("refuses a key file whose fingerprint is not the published one", () => {
    // The anchor: the master must not be able to point the verifier at a key
    // it holds the private half of.
    expect(() =>
      createSignatureVerifier({
        repo,
        publicKeyPath: imposterKeyPub,
        expectedFingerprint: nodeFingerprint,
      }),
    ).toThrow(/not the published/);
  });

  it("reads the key type from the file instead of assuming ed25519", () => {
    const rsa = path.join(root, "rsa-key");
    execFileSync(
      "ssh-keygen",
      ["-t", "rsa", "-b", "2048", "-N", "", "-C", "rsa", "-f", rsa],
      { stdio: "ignore" },
    );
    git(["config", "user.signingkey", `${rsa}.pub`]);
    git(["commit", "-q", "--allow-empty", "-m", "feat: rsa commit"]);
    const sha = git(["rev-parse", "HEAD"]);
    git(["config", "user.signingkey", nodeKeyPub]);

    expect(verifier(`${rsa}.pub`)(sha).ok).toBe(true);
  });

  it("keeps a separator inside a commit message out of the parsed record", () => {
    // A delimited log format splits the record and loses the trailers that
    // follow the separator.
    git([
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      `feat: separator \x1e in body\n\nbody \x1f more\n\nFleet-Conversation: conv-1\nFleet-Run: ${NONCE}`,
    ]);
    const sha = git(["rev-parse", "HEAD"]);
    const commits = readCommits(`${sha}~1..${sha}`, { repo });

    expect(commits).toHaveLength(1);
    expect(checkTrailers(commits[0], { runNonce: NONCE })).toMatchObject({
      ok: true,
      conversationId: "conv-1",
    });
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
      verifySignature: verifier(),
      eventsFor: () => [agentEvent('git commit -m "feat: node commit"')],
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

describe("answeredByNode", () => {
  it.each(["proxied:101", "proxied:200", "proxied:302"])(
    "counts %s as the node answering",
    (outcome) => {
      expect(answeredByNode({ outcome })).toBe(true);
    },
  );

  it.each([
    "proxied",
    "proxied:401",
    "proxied:404",
    "proxied:500",
    "refused:403",
    "aborted:200",
    "upstream_error",
    undefined,
  ])("does not count %s", (outcome) => {
    expect(answeredByNode({ outcome })).toBe(false);
  });
});
