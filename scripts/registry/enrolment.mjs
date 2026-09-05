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

import { credRefFor, entryId, RegistryError } from "./store.mjs";

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
const MAX_TRACKED_NONCES = 10_000;
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
 *   - a pending entry is promoted only by a pre-seeded fingerprint.
 */
export function nextState(existing, preSeeded) {
  if (!existing) return preSeeded ? "active" : "pending";
  if (existing.state === "revoked") return "revoked";
  if (existing.state === "pending") return preSeeded ? "active" : "pending";
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
 *     get(id: string): Promise<any>,
 *     upsert(entry: any): Promise<any>,
 *   },
 *   allowlist?: string[],
 *   now?: () => number,
 *   replayWindowSeconds?: number,
 * }} options
 */
export function createEnrolment({
  store,
  allowlist = [],
  now = () => Date.now(),
  replayWindowSeconds = DEFAULT_REPLAY_WINDOW_SECONDS,
  maxPendingEntries = DEFAULT_MAX_PENDING_ENTRIES,
}) {
  const preSeeded = new Set(
    allowlist.map(normaliseFingerprint).filter((value) => value !== null),
  );
  /** nonce -> epoch ms it was accepted, pruned on every call. */
  const seenNonces = new Map();

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

  function consumeNonce(nonce, nowMs) {
    const windowMs = replayWindowSeconds * 1000;
    for (const [seen, at] of seenNonces) {
      if (nowMs - at > windowMs) seenNonces.delete(seen);
    }
    if (seenNonces.has(nonce)) {
      throw new RegistryError(
        401,
        "replayed_nonce",
        "nonce has already been used",
      );
    }
    if (seenNonces.size >= MAX_TRACKED_NONCES) {
      throw new RegistryError(
        503,
        "nonce_table_full",
        "too many registrations in flight, retry shortly",
      );
    }
    seenNonces.set(nonce, nowMs);
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
      consumeNonce(nonce, nowMs);

      const fingerprint = fingerprintFromPublicKey(body.pubkey);
      const id = entryId(fingerprint);
      const entries = await store.list();
      const existing = entries.find((entry) => entry.id === id) ?? null;

      // Only a *new* entry that would land pending is capped. A machine that is
      // already listed, and one whose fingerprint is pre-seeded, always gets
      // through, so a flood cannot lock out the fleet it is trying to drown.
      if (!existing && !preSeeded.has(fingerprint)) {
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

      const entry = await store.upsert({
        id,
        name: body.name,
        host: body.host,
        pubkey: body.pubkey,
        fingerprint,
        credRef: resolveCredRef(existing, fingerprint, body.credRef),
        version: body.version,
        state: nextState(existing, preSeeded.has(fingerprint)),
        lastSeen: new Date(nowMs).toISOString(),
      });

      return { entry, created: existing === null };
    },
  };
}
