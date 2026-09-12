/**
 * Proof that the fleet suite can fail.
 *
 * A green suite is worth exactly what its ability to go red is worth, and the
 * registry's earlier suites shipped every race green because they tested
 * wiring rather than outcomes. This file is the standing answer to "how do you
 * know these assertions bite", in two layers:
 *
 *   negative controls  the same checks the run relies on, pointed at evidence
 *                      that should not satisfy them. Each must come back
 *                      false. If one of these ever passes, every green run
 *                      that used that check meant nothing.
 *   forgery            attacks, executed for real against the running rig,
 *                      each of which must fail closed rather than merely be
 *                      reported.
 *
 * The third layer — reverting each gating fix and watching a named assertion
 * go red — cannot live here, because it edits the source the run is using. It
 * is `tests/e2e/live/fleet-registry/deliberate-breakage.mjs`.
 *
 * Both layers run in both profiles, except where a profile has no such thing
 * to forge; those say so in their skip reason.
 *
 * @spec FR-006 FR-007 FR-019 FR-020 FR-021
 */

import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";

import { expect, test, type APIRequestContext } from "@playwright/test";

import {
  answeredByNode,
  checkProxy,
  isTunnelledToNode,
  verifyChain,
} from "../../../../scripts/verify-fleet-chain.mjs";
import { readRigState, type RigEntry, type RigState } from "./rig-state";
import "./magicdns.mjs";

const rig: RigState = readRigState();
const PROFILE = rig.profile ?? "tailnet";
const TAILNET = PROFILE === "tailnet";
const masterAuth = { "X-Session-API-Key": rig.keys.master };

const ENROLMENT_ONLY = "enrolment is a push-profile step; k8s discovers";

test.describe.configure({ mode: "serial" });

async function listEntries(request: APIRequestContext): Promise<RigEntry[]> {
  const response = await request.get(`${rig.baseUrl}/api/registry`, {
    headers: masterAuth,
  });
  expect(response.status()).toBe(200);
  return (await response.json()).entries as RigEntry[];
}

// ═══════════════════════════════════════════════════════════════════════════
// Layer 2 — negative controls
//
// Permanent, and deliberately not about the fleet: they feed each check the
// evidence an attacker would have and require the answer "no".
// ═══════════════════════════════════════════════════════════════════════════

const NODE_FINGERPRINT = "SHA256:zCJmiJ7wModXHdGhaB0xktp+IBjT0NsgiNJaQtiIMHw";
const OTHER_FINGERPRINT = "SHA256:x9NoMCXf3bkGH++jPmCFWXSLYFFNiU9CETbuirCqYw4";
const NODE_HOST = "https://claude-hetzner.tailae910a.ts.net:8443";

const TUNNEL_MAP = {
  [NODE_HOST]: { node: "claude-hetzner", fingerprint: NODE_FINGERPRINT },
};

/** A proxy line the node answered, of the shape a real run produces. */
function proxyLine(overrides: Record<string, unknown> = {}) {
  return {
    ts: "2026-09-12T10:00:00.000Z",
    conversationId: "conv-1",
    entryHost: NODE_HOST,
    entryFingerprint: NODE_FINGERPRINT,
    credential: "injected",
    outcome: "proxied:200",
    ...overrides,
  };
}

const COMMITTED_AT = "2026-09-12T11:00:00.000Z";

test("control: a proxy line for another machine does not prove this one", () => {
  const verdict = checkProxy([proxyLine({ entryFingerprint: OTHER_FINGERPRINT })], {
    conversationId: "conv-1",
    committedAt: COMMITTED_AT,
    fingerprint: NODE_FINGERPRINT,
    tunnelMap: TUNNEL_MAP,
  });

  expect(verdict.ok, "another machine's fingerprint satisfied the check").toBe(
    false,
  );
  expect(verdict.reason).toContain("but never to");
});

test("control: a line the node answered 4xx is not proof of work", () => {
  // `/api/conversations/<any id>` reaches the proxy from anyone holding the
  // master key, and the node 404s it. Without this, minting evidence for a
  // conversation that never ran costs one request.
  expect(answeredByNode(proxyLine({ outcome: "proxied:404" }))).toBe(false);
  expect(answeredByNode(proxyLine({ outcome: "proxied:403" }))).toBe(false);
  expect(answeredByNode(proxyLine({ outcome: "refused" }))).toBe(false);
  // A log written before the proxy recorded the node's own answer cannot tell
  // the two apart, so it verifies as broken rather than as proof.
  expect(answeredByNode(proxyLine({ outcome: "proxied" }))).toBe(false);

  expect(answeredByNode(proxyLine())).toBe(true);
  expect(answeredByNode(proxyLine({ outcome: "proxied:101" }))).toBe(true);
});

test("control: a line with no credential injected is not proof of the proxy", () => {
  const verdict = checkProxy([proxyLine({ credential: "none" })], {
    conversationId: "conv-1",
    committedAt: COMMITTED_AT,
    fingerprint: NODE_FINGERPRINT,
    tunnelMap: TUNNEL_MAP,
  });

  expect(verdict.ok).toBe(false);
  expect(verdict.reason).toContain("never answered by the node");
});

test("control: a host the tunnel map does not vouch for is not that machine", () => {
  // Membership of the map's key set is not the check. The map records which
  // machine each address reaches, and that is the part worth checking.
  expect(
    isTunnelledToNode(proxyLine(), TUNNEL_MAP, OTHER_FINGERPRINT),
    "the map vouches for a different machine than the one claimed",
  ).toBe(false);
  expect(
    isTunnelledToNode(
      proxyLine({ entryHost: "http://127.0.0.1:39999" }),
      TUNNEL_MAP,
      NODE_FINGERPRINT,
    ),
    "an address the map never mentions was accepted",
  ).toBe(false);

  expect(isTunnelledToNode(proxyLine(), TUNNEL_MAP, NODE_FINGERPRINT)).toBe(
    true,
  );
});

test("control: a proxy line written after the commit proves nothing", () => {
  const verdict = checkProxy(
    [proxyLine({ ts: "2026-09-12T12:00:00.000Z" })],
    {
      conversationId: "conv-1",
      committedAt: COMMITTED_AT,
      fingerprint: NODE_FINGERPRINT,
      tunnelMap: TUNNEL_MAP,
    },
  );

  expect(verdict.ok).toBe(false);
  expect(verdict.reason).toContain("after the commit");
});

test("control: a stale --exempt fails the run instead of being ignored", () => {
  // An exemption that matches nothing is how a real commit quietly stops being
  // checked: the sha it named was rebased away, and the check it was hiding
  // came back with nobody looking. So an unmatched exemption is a failure, not
  // a no-op.
  const commit = {
    sha: "a".repeat(40),
    subject: "a commit the verifier will refuse",
    committedAt: COMMITTED_AT,
    message: "no trailers here",
  };
  // The full context `verifyCommit` reads. The links are stubbed to fail:
  // what is under test here is what the exemption list does, not the links.
  const context = {
    runNonce: "0".repeat(32),
    fingerprint: NODE_FINGERPRINT,
    tunnelMap: TUNNEL_MAP,
    proxyEntries: [],
    verifySignature: () => ({ ok: false, reason: "no signature" }),
    eventsFor: () => [],
  };

  const stale = verifyChain([commit], {
    ...context,
    exemptShas: ["b".repeat(40)],
  });
  expect(stale.ok, "a stale exemption passed").toBe(false);
  expect(stale.unmatched).toEqual(["b".repeat(40)]);

  // And a real exemption that leaves nothing to check is not a pass either: a
  // range where every commit is exempted has verified nothing.
  const everything = verifyChain([commit], { ...context, exemptShas: [commit.sha] });
  expect(everything.ok, "an empty range passed").toBe(false);
  expect(everything.empty).toBe(true);

  // A prefix must never exempt: it can match two commits and hide both.
  const prefix = verifyChain([commit], {
    ...context,
    exemptShas: [commit.sha.slice(0, 12)],
  });
  expect(prefix.skipped, "a short sha exempted a commit").toHaveLength(0);
});

// ═══════════════════════════════════════════════════════════════════════════
// Layer 4 — forgery, executed for real
// ═══════════════════════════════════════════════════════════════════════════

test("forgery: a conversation that never ran leaves a line that proves nothing", async ({
  request,
}) => {
  // The attack is cheap and looks exactly like evidence: hold the master key,
  // ask the proxy for an invented conversation id, and the access log gains a
  // line naming that id against the node's own fingerprint. What stops it is
  // the outcome the node actually returned.
  const invented = `forged-${randomBytes(8).toString("hex")}`;
  const entry = rig.entries.node1;

  const response = await request.get(
    `${rig.baseUrl}/backend/${entry.id}/api/conversations/${invented}`,
    { headers: masterAuth, failOnStatusCode: false },
  );

  expect(
    response.status(),
    "the node has no such conversation, so it must refuse",
  ).toBeGreaterThanOrEqual(400);

  // That is precisely the line an attacker would offer, so the check that
  // reads it must reject it.
  const minted = proxyLine({
    conversationId: invented,
    outcome: `proxied:${response.status()}`,
    entryHost: entry.host,
  });
  expect(answeredByNode(minted)).toBe(false);
  expect(
    checkProxy([minted], {
      conversationId: invented,
      committedAt: COMMITTED_AT,
      fingerprint: entry.fingerprint,
      tunnelMap: { [entry.host]: { fingerprint: entry.fingerprint } },
    }).ok,
  ).toBe(false);
});

test("forgery: the verifier refuses a signing key the master holds", () => {
  // Link 1 is the only one that tells the node apart from this Mac, and it
  // holds only while the node signs with a key this machine does not have.
  // Pointing the verifier at a locally generated key is the whole attack.
  const keyDir = `${rig.dir}/evidence`;
  execFileSync("ssh-keygen", [
    "-t",
    "ed25519",
    "-N",
    "",
    "-C",
    "master-held",
    "-f",
    `${keyDir}/master-held-key`,
  ]);

  let exitCode = 0;
  let output = "";
  try {
    execFileSync(
      "node",
      [
        "scripts/verify-fleet-chain.mjs",
        "--range",
        "HEAD~1..HEAD",
        "--signing-key",
        `${keyDir}/master-held-key.pub`,
        // The fingerprint published before the run, which is the node's.
        "--signing-key-fingerprint",
        NODE_FINGERPRINT,
        "--fingerprint",
        NODE_FINGERPRINT,
        "--run-nonce",
        "0".repeat(32),
        "--proxy-log",
        "/dev/null",
        "--tunnel-map",
        "/dev/null",
        "--events-dir",
        keyDir,
      ],
      { encoding: "utf8", stdio: "pipe" },
    );
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    exitCode = failure.status ?? 0;
    output = `${failure.stdout ?? ""}${failure.stderr ?? ""}`;
  }

  expect(
    exitCode,
    "a key the master generated verified as the node's",
  ).not.toBe(0);
  expect(output.toLowerCase()).toMatch(/fingerprint/);
});

test("forgery: a registration flood cannot crowd out a real node", async ({
  request,
}) => {
  // @spec FR-021
  // Registration is the one route with no session key, because a freshly
  // provisioned node has its own host key and none of the master's
  // credentials. That makes it the fleet's only unauthenticated write, and a
  // throwaway keypair costs nothing to mint.
  const before = await listEntries(request);

  const attempts = 40;
  const statuses: number[] = [];
  for (let i = 0; i < attempts; i += 1) {
    const response = await request.post(`${rig.baseUrl}/api/registry/register`, {
      headers: { "Content-Type": "application/json" },
      data: {
        name: `flood-${i}`,
        host: "http://127.0.0.1:1",
        pubkey: `ssh-ed25519 ${randomBytes(51).toString("base64")} flood@${i}`,
        nonce: randomBytes(16).toString("hex"),
        ts: Math.floor(Date.now() / 1000),
      },
      failOnStatusCode: false,
    });
    statuses.push(response.status());
  }

  // Every one of them is refused: an unsigned registration is not a
  // registration, and a signature over a key the caller minted is not an
  // identity the master ever agreed to.
  expect(
    statuses.every((status) => status >= 400),
    `the flood created entries: ${statuses.join(",")}`,
  ).toBe(true);

  const after = await listEntries(request);
  expect(
    after.map((entry) => entry.id).sort(),
    "the flood changed the fleet",
  ).toEqual(before.map((entry) => entry.id).sort());

  // And the fleet still works, which is the part a nonce table exhausted by
  // junk would have broken.
  const response = await request.get(
    `${rig.baseUrl}/backend/${rig.entries.node1.id}/server_info`,
    { headers: masterAuth, failOnStatusCode: false },
  );
  expect(response.status()).toBe(200);
});

test("forgery: approving an entry whose host moved is refused, not ratified", async ({
  request,
}) => {
  test.skip(!TAILNET, ENROLMENT_ONLY);

  // The operator reads the queue, the entry re-registers somewhere else —
  // still pending, so nothing on screen looks different — and the approval
  // that lands ratifies a host nobody looked at.
  const entries = await listEntries(request);
  const target = entries.find((entry) => entry.state !== "revoked");
  expect(target, "no entry to approve").toBeDefined();

  const response = await request.post(
    `${rig.baseUrl}/api/registry/${(target as RigEntry).id}/approve`,
    {
      headers: { ...masterAuth, "Content-Type": "application/json" },
      data: { host: "https://somewhere-else.example:8443" },
      failOnStatusCode: false,
    },
  );

  expect(
    response.status(),
    "an approval naming the wrong host was accepted",
  ).toBe(409);
  const body = await response.json();
  // The answer has to name the address the entry actually carries, or the
  // operator cannot tell what they nearly approved.
  expect(JSON.stringify(body)).toContain((target as RigEntry).host);
});

test("forgery: an approval without the master key is refused", async ({
  request,
}) => {
  const target = rig.entries.node2;
  const attempts: Record<string, string>[] = [
    {},
    { "X-Session-API-Key": "not-the-key" },
  ];
  // A node's own key authorises that node, never a decision about the fleet.
  if (rig.keys.node1) attempts.push({ "X-Session-API-Key": rig.keys.node1 });

  for (const headers of attempts) {
    const response = await request.post(
      `${rig.baseUrl}/api/registry/${target.id}/approve`,
      {
        headers: { ...headers, "Content-Type": "application/json" },
        data: { host: target.host },
        failOnStatusCode: false,
      },
    );
    expect(
      response.status(),
      `approval accepted with headers ${JSON.stringify(headers)}`,
    ).toBe(401);
  }
});

test("forgery: a revoked node stays revoked however it comes back", async ({
  request,
}) => {
  // @spec FR-007
  const entries = await listEntries(request);
  const victim = entries.find((entry) => entry.state === "active");
  expect(victim, "nothing active to revoke").toBeDefined();
  const target = victim as RigEntry;

  const revoke = await request.post(
    `${rig.baseUrl}/api/registry/${target.id}/revoke`,
    { headers: masterAuth, failOnStatusCode: false },
  );
  expect(revoke.status()).toBe(200);

  const proxied = await request.get(
    `${rig.baseUrl}/backend/${target.id}/server_info`,
    { headers: masterAuth, failOnStatusCode: false },
  );
  expect(proxied.status(), "a revoked entry is still reachable").toBe(403);

  if (TAILNET) {
    // Re-registering from the machine itself, with its real host key: the
    // strongest form of the attack, because every signature is genuine.
    const which = target.id === rig.entries.node1.id ? "node1" : "node2";
    execFileSync(
      "node",
      ["tests/e2e/live/fleet-registry/rig.mjs", `reenrol-${which}`],
      { encoding: "utf8" },
    );
  } else {
    // The cluster still lists the Service, so the next poll is the attack:
    // a directory listing must never undo an operator's decision.
    await new Promise((resolve) =>
      setTimeout(resolve, (rig.sourceIntervalMs ?? 60_000) * 2),
    );
  }

  const after = await listEntries(request);
  const same = after.find((entry) => entry.id === target.id);
  expect(same?.state, "revocation did not hold").toBe("revoked");
  expect(
    (
      await request.get(`${rig.baseUrl}/backend/${target.id}/server_info`, {
        headers: masterAuth,
        failOnStatusCode: false,
      })
    ).status(),
  ).toBe(403);
});

test("the fingerprint an entry carries is the machine's own key", async ({
  request,
}) => {
  test.skip(!TAILNET, ENROLMENT_ONLY);

  // The identity in the registry has to be derivable from the key itself; a
  // fingerprint the registration merely asserted would let any node claim any
  // identity.
  for (const entry of await listEntries(request)) {
    const pubkey = (entry as RigEntry & { pubkey?: string }).pubkey;
    expect(pubkey, `${entry.name} carries no public key`).toBeTruthy();
    const blob = Buffer.from(String(pubkey).split(/\s+/)[1], "base64");
    const derived = `SHA256:${createHash("sha256")
      .update(blob)
      .digest("base64")
      .replace(/=+$/, "")}`;
    expect(
      entry.fingerprint,
      `${entry.name}'s fingerprint is not its key's`,
    ).toBe(derived);
  }
});
