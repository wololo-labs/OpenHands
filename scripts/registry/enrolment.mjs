/**
 * Signed self-enrolment.
 *
 * A node proves possession of its SSH host key and asks to be listed:
 *
 *   POST /api/registry/register
 *   body:   { name, host, pubkey, credRef, version, nonce, ts }
 *   header: X-Registry-Signature: base64(ed25519(hostkey, canonical(body)))
 *
 * `canonical(body)` is JSON over the signed fields in alphabetical order with
 * null/absent fields omitted (see `canonicalPayload`). Signer and verifier
 * import the same function, so the wire format cannot drift between them.
 *
 * `ts` is Unix epoch **seconds**. A client that sends milliseconds lands far
 * in the future and is rejected rather than silently accepted.
 *
 * A signature proves possession, never authorisation: a pre-seeded
 * fingerprint enrols straight to `active`, anything else lands in the
 * `pending` TOFU queue and needs an explicit approval.
 */

import {
  createHash,
  createPublicKey,
  verify as verifyEd25519,
} from "node:crypto";

import {
  credRefFor,
  entryId,
  normaliseEntry,
  normaliseHost,
  RegistryError,
} from "./store.mjs";

/** Fields covered by the signature, in canonical (alphabetical) order. */
export const SIGNED_FIELDS = Object.freeze([
  "credRef",
  "host",
  "name",
  "nonce",
  "pubkey",
  "ts",
  "version",
]);

export const DEFAULT_REPLAY_WINDOW_SECONDS = 300;
/**
 * Ceiling on entries awaiting approval. Registration is unauthenticated by
 * design, and any self-generated keypair is a new fingerprint, so without a
 * cap anyone who can reach the route can mint entries without limit -- each
 * one a read-modify-write of the whole entry array into the agent server's
 * settings. The queue is something an operator reads and acts on, so a number
 * far past what anyone would work through is already past useful.
 */
export const DEFAULT_MAX_PENDING_ENTRIES = 100;
/**
 * Nonces one fingerprint may spend inside a replay window.
 *
 * The table has to be bounded, and bounding it *globally* is what made it a
 * weapon: an entry that already exists skips the pending cap, so a single
 * enrolled keypair could re-register with fresh nonces until the table was
 * full and every other machine's enrolment answered "too many in flight".
 * Bounded per identity, a flood costs the flooder its own budget and nobody
 * else's. Well above what any real node needs -- one registration per boot,
 * plus retries.
 */
export const DEFAULT_MAX_NONCES_PER_FINGERPRINT = 32;
/**
 * Backstop on total tracked nonces. Unreachable by one identity now that the
 * per-fingerprint bound exists, and unreachable by many because a new
 * fingerprint has to get past the pending cap before it can spend anything.
 */
const MAX_TRACKED_NONCES = 100_000;
const SSH_ED25519 = "ssh-ed25519";
const ED25519_RAW_KEY_BYTES = 32;
const ED25519_SIGNATURE_BYTES = 64;
// DER SPKI header for an Ed25519 public key; the 32 raw key bytes follow it.
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/**
 * Deterministic serialisation of the signed fields. Absent and null fields
 * are omitted, so an optional `credRef` produces the same bytes whether the
 * client sends `null` or leaves the key out entirely.
 */
export function canonicalPayload(body) {
  const canonical = {};
  for (const field of SIGNED_FIELDS) {
    const value = body?.[field];
    if (value === undefined || value === null) continue;
    canonical[field] = value;
  }
  return JSON.stringify(canonical);
}

/** Parses an `ssh-ed25519 AAAA... [comment]` public key line. */
export function parseSshEd25519PublicKey(pubkey) {
  const fields = String(pubkey ?? "")
    .trim()
    .split(/\s+/);
  if (fields.length < 2 || fields[0] !== SSH_ED25519) {
    throw new RegistryError(
      400,
      "invalid_pubkey",
      `pubkey must be an ${SSH_ED25519} public key`,
    );
  }

  let blob;
  try {
    blob = Buffer.from(fields[1], "base64");
  } catch {
    throw new RegistryError(
      400,
      "invalid_pubkey",
      "pubkey is not valid base64",
    );
  }

  // Wire format: string("ssh-ed25519") || string(32 raw key bytes), where a
  // string is a big-endian uint32 length followed by that many bytes.
  const typeLength = 4 + SSH_ED25519.length;
  const expectedLength = typeLength + 4 + ED25519_RAW_KEY_BYTES;
  if (
    blob.length !== expectedLength ||
    blob.readUInt32BE(0) !== SSH_ED25519.length ||
    blob.subarray(4, typeLength).toString("utf8") !== SSH_ED25519 ||
    blob.readUInt32BE(typeLength) !== ED25519_RAW_KEY_BYTES
  ) {
    throw new RegistryError(
      400,
      "invalid_pubkey",
      "pubkey is not a well-formed ssh-ed25519 key",
    );
  }

  return { blob, raw: blob.subarray(typeLength + 4) };
}

/** `SHA256:...` fingerprint, byte-identical to `ssh-keygen -lf`. */
export function fingerprintFromPublicKey(pubkey) {
  const { blob } = parseSshEd25519PublicKey(pubkey);
  return `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`;
}

/** Verifies the signature over `canonicalPayload(body)` with `body.pubkey`. */
export function verifySignature(body, signature) {
  const { raw } = parseSshEd25519PublicKey(body?.pubkey);
  if (typeof signature !== "string" || signature.trim() === "") {
    return false;
  }

  const decoded = Buffer.from(signature, "base64");
  if (decoded.length !== ED25519_SIGNATURE_BYTES) {
    return false;
  }

  const key = createPublicKey({
    key: Buffer.concat([SPKI_ED25519_PREFIX, raw]),
    format: "der",
    type: "spki",
  });
  return verifyEd25519(
    null,
    Buffer.from(canonicalPayload(body), "utf8"),
    key,
    decoded,
  );
}

/** Accepts `SHA256:abc…` or a bare `abc…` fingerprint. */
export function normaliseFingerprint(value) {
  const trimmed = String(value ?? "").trim();
  if (trimmed === "") return null;
  return trimmed.startsWith("SHA256:") ? trimmed : `SHA256:${trimmed}`;
}

/**
 * Re-registration never escalates trust on its own:
 *
 *   - a revoked entry stays revoked until an operator approves it again,
 *     so dropping a decommissioned host from the allowlist is final;
 *   - an already-approved entry keeps its state even once its fingerprint
 *     leaves the pre-seed list;
 *   - a pending entry is promoted only by a pre-seeded fingerprint;
 *   - a hand-approved entry that changes address returns to `pending`, so
 *     the operator decides again about the machine as it now is.
 *
 * A `stale` entry is only ever produced by a pull source, and a pull source
 * writes through `sources/sync.mjs` rather than here, so the `stale` branch
 * of this function is unreachable from enrolment today.
 *
 * @param {object|null} existing        the stored entry, or null on a first
 *                                      registration
 * @param {boolean}     preSeeded       whether the fingerprint is allowlisted
 * @param {string}      requestedHost   normalised host being registered
 */
export function nextState(existing, preSeeded, requestedHost) {
  if (!existing) return preSeeded ? "active" : "pending";
  // Required rather than defaulted: a missing host used to mean "no move",
  // so a caller that forgot the argument silently lost the check.
  if (typeof requestedHost !== "string" || requestedHost === "") {
    throw new RegistryError(
      500,
      "invalid_state",
      "nextState requires the host being registered",
    );
  }
  if (existing.state === "revoked") return "revoked";
  if (existing.state === "pending") return preSeeded ? "active" : "pending";
  // An approval is of a machine *at an address*. A pre-seeded fingerprint is
  // trusted as an identity, so it may move freely -- that is what pre-seeding
  // means, and re-announcing after a reboot or an address change is the case
  // self-enrolment exists for. An entry approved by hand was approved on what
  // the operator could see, and the host was part of it, so moving one sends
  // it back to the queue they already have rather than silently repointing
  // the proxy at somewhere they never agreed to.
  if (!preSeeded && requestedHost && requestedHost !== existing.host) {
    return "pending";
  }
  return existing.state;
}

/**
 * Whether an entry resolves a credential, and which one.
 *
 * The registration only gets to say *that* a credential was published, never
 * *where*: the reference is derived from the fingerprint. Letting a node name
 * its own reference -- even pinned to its first registration -- lets it name
 * one it does not own. Enrol as a new machine claiming another entry's
 * reference, wait for the routine approval, then repoint `host`, and the
 * proxy resolves the victim's session key and delivers it. The approval is no
 * defence: an operator approving a machine sees a name and a host, not a
 * secret reference.
 *
 * `host` stays updatable, which is only safe *because* the reference is
 * derived: repointing an entry now yields the credential of the machine that
 * enrolled it, which is the one whose host key signed the registration.
 */
export function resolveCredRef(existing, fingerprint, requested) {
  // Sticky, because a re-registration that simply omits the flag is the
  // ordinary case: a node re-announcing after a reboot or an address change
  // has no reason to restate that its key was published. Clearing the
  // reference there leaves an entry that is still `active` and still in the
  // switcher while every request through it 403s. There is no reason to ever
  // unset it now that it cannot be forged.
  return requested || existing?.credRef ? credRefFor(fingerprint) : null;
}

function requireBodyString(body, field) {
  const value = body?.[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new RegistryError(400, "invalid_body", `${field} is required`);
  }
  return value.trim();
}

/**
 * @param {{
 *   store: {
 *     list(): Promise<any[]>,
 *     mutate(id: string, apply: (existing: any) => any): Promise<any>,
 *   },
 *   allowlist?: string[],
 *   now?: () => number,
 *   replayWindowSeconds?: number,
 *   maxPendingEntries?: number,
 *   maxNoncesPerFingerprint?: number,
 * }} options
 */
export function createEnrolment({
  store,
  allowlist = [],
  now = () => Date.now(),
  replayWindowSeconds = DEFAULT_REPLAY_WINDOW_SECONDS,
  maxPendingEntries = DEFAULT_MAX_PENDING_ENTRIES,
  maxNoncesPerFingerprint = DEFAULT_MAX_NONCES_PER_FINGERPRINT,
}) {
  const preSeeded = new Set(
    allowlist.map(normaliseFingerprint).filter((value) => value !== null),
  );
  /**
   * `"<fingerprint>:<nonce>"` -> epoch ms it was accepted, pruned on every
   * call. Keyed by fingerprint as well as nonce so one machine's traffic can
   * never evict another's, and so two nodes picking the same nonce are not
   * mistaken for a replay.
   */
  const seenNonces = new Map();
  /** fingerprint -> how many of its nonces are currently tracked. */
  const nonceCounts = new Map();

  function assertFresh(ts, nowMs) {
    if (typeof ts !== "number" || !Number.isFinite(ts)) {
      throw new RegistryError(400, "invalid_body", "ts must be a number");
    }
    const skewSeconds = Math.abs(nowMs / 1000 - ts);
    if (skewSeconds > replayWindowSeconds) {
      throw new RegistryError(
        401,
        "stale_timestamp",
        `ts must be within ${replayWindowSeconds}s of now (epoch seconds)`,
      );
    }
  }

  function pruneNonces(nowMs) {
    const windowMs = replayWindowSeconds * 1000;
    for (const [key, entry] of seenNonces) {
      if (nowMs - entry.at <= windowMs) continue;
      seenNonces.delete(key);
      const remaining = (nonceCounts.get(entry.fingerprint) ?? 1) - 1;
      if (remaining > 0) {
        nonceCounts.set(entry.fingerprint, remaining);
      } else {
        nonceCounts.delete(entry.fingerprint);
      }
    }
  }

  /**
   * Replay and budget checks, without spending anything.
   *
   * Split from the spend so it can run *before* the store is read. A refusal
   * that happens after the read still costs one full settings fetch from the
   * agent server per attempt, which is the amplification a flood actually
   * wants; checking first means a machine over its budget is turned away for
   * the price of a Map lookup.
   */
  function checkNonce(fingerprint, nonce, nowMs) {
    pruneNonces(nowMs);

    const key = `${fingerprint}:${nonce}`;
    if (seenNonces.has(key)) {
      throw new RegistryError(
        401,
        "replayed_nonce",
        "nonce has already been used",
      );
    }

    const spent = nonceCounts.get(fingerprint) ?? 0;
    if (spent >= maxNoncesPerFingerprint) {
      // This machine's own budget, so the refusal lands on the flooder rather
      // than on whoever tries to enrol next.
      throw new RegistryError(
        429,
        "too_many_registrations",
        `this key has registered ${spent} times in the last ` +
          `${replayWindowSeconds}s; slow down`,
      );
    }

    if (seenNonces.size >= MAX_TRACKED_NONCES) {
      throw new RegistryError(
        503,
        "nonce_table_full",
        "too many registrations in flight, retry shortly",
      );
    }
    return key;
  }

  function spendNonce(fingerprint, nonce, nowMs) {
    const key = checkNonce(fingerprint, nonce, nowMs);
    seenNonces.set(key, { at: nowMs, fingerprint });
    nonceCounts.set(fingerprint, (nonceCounts.get(fingerprint) ?? 0) + 1);
  }

  /** Hands a slot back when the write it was spent on never happened. */
  function releaseNonce(fingerprint, nonce) {
    if (!seenNonces.delete(`${fingerprint}:${nonce}`)) return;
    const remaining = (nonceCounts.get(fingerprint) ?? 1) - 1;
    if (remaining > 0) {
      nonceCounts.set(fingerprint, remaining);
    } else {
      nonceCounts.delete(fingerprint);
    }
  }

  return {
    isPreSeeded(fingerprint) {
      const normalised = normaliseFingerprint(fingerprint);
      return normalised !== null && preSeeded.has(normalised);
    },

    /**
     * Verifies a registration and upserts its entry. Returns the stored entry
     * and whether this call created it, so the route can answer 201 vs 200.
     */
    async register(body, signature) {
      requireBodyString(body, "name");
      requireBodyString(body, "host");
      requireBodyString(body, "pubkey");
      const nonce = requireBodyString(body, "nonce");

      const nowMs = now();
      assertFresh(body?.ts, nowMs);

      // Signature first: an unauthenticated caller must not be able to grow
      // the nonce table.
      if (!verifySignature(body, signature)) {
        throw new RegistryError(
          401,
          "invalid_signature",
          "signature does not verify against pubkey",
        );
      }

      const fingerprint = fingerprintFromPublicKey(body.pubkey);
      const isPreSeeded = preSeeded.has(fingerprint);
      const id = entryId(fingerprint);

      // Before the store is touched. A caller over its budget, or replaying,
      // is turned away for a Map lookup rather than a settings fetch.
      checkNonce(fingerprint, nonce, nowMs);
      // Normalised here rather than left to the store, because the state
      // machine below compares it against what is already stored and a
      // trailing slash is not an address change.
      const host = normaliseHost(body.host);
      const entries = await store.list();
      const existing = entries.find((entry) => entry.id === id) ?? null;

      // Only a *new* entry that would land pending is capped. A machine that is
      // already listed, and one whose fingerprint is pre-seeded, always gets
      // through, so a flood cannot lock out the fleet it is trying to drown.
      if (!existing && !isPreSeeded) {
        const pending = entries.filter(
          (entry) => entry.state === "pending",
        ).length;
        if (pending >= maxPendingEntries) {
          throw new RegistryError(
            429,
            "too_many_pending",
            `${pending} registrations are already awaiting approval; ` +
              "approve or revoke some before enrolling another machine",
          );
        }
      }

      // Shaped and validated before the nonce is spent, not after. Every way
      // this call can be refused for its *body* -- an over-long name, a
      // version string past its limit, anything `normaliseEntry` rejects --
      // used to throw after the nonce was consumed, so a signed but malformed
      // registration still cost a slot. `state` here is a placeholder: the
      // real one is decided under the lock below.
      normaliseEntry({
        id,
        name: body.name,
        host,
        pubkey: body.pubkey,
        fingerprint,
        credRef: resolveCredRef(existing, fingerprint, body.credRef),
        version: body.version,
        state: "pending",
        lastSeen: new Date(nowMs).toISOString(),
      });

      spendNonce(fingerprint, nonce, nowMs);

      let created = false;
      let entry;
      try {
        // The trust decision is made against the entry as it is at the moment
        // of writing, not against the copy read above. Deciding outside the
        // lock let a registration already in flight overwrite an operator's
        // revoke with a `state` computed before it: revocation did not stick
        // against a machine that was still re-registering, which is the one
        // machine it has to stick against.
        entry = await store.mutate(id, (current) => {
          created = current === null;

          return {
            id,
            name: body.name,
            host,
            pubkey: body.pubkey,
            fingerprint,
            credRef: resolveCredRef(current, fingerprint, body.credRef),
            version: body.version,
            state: nextState(current, isPreSeeded, host),
            lastSeen: new Date(nowMs).toISOString(),
          };
        });
      } catch (error) {
        // A write that never happened did not really use its nonce; holding it
        // would let an agent-server outage burn a node's whole budget and lock
        // it out of re-enrolling for the rest of the window, exactly when
        // re-enrolling matters.
        releaseNonce(fingerprint, nonce);
        throw error;
      }

      return { entry, created };
    },
  };
}
