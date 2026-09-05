/**
 * Fleet registry: entry shape and the storage-provider facade.
 *
 * An entry is one agent server the canvas may offer in its backend switcher:
 *
 *   { id, name, host, pubkey, fingerprint, credRef, state, version, lastSeen,
 *     source }
 *
 * `fingerprint` is the identity the entry is keyed by, and `id` is derived
 * from it, so a host that re-announces after a reboot, an address change, or a
 * restore updates its own entry instead of adding a duplicate. Signed
 * enrolment uses the SSH fingerprint; a pull source (Kubernetes, a tailnet)
 * uses a stable identifier from that directory instead and has no `pubkey`,
 * because it proves nothing by possession: the directory it was read from is
 * the authorisation.
 *
 * A storage provider is anything implementing:
 *
 *   list()             -> entry[]
 *   upsert(entry)      -> entry
 *   remove(id)         -> boolean (whether an entry went)
 *   removeIf(id, check) -> boolean (check throws to refuse, under the lock)
 *   setState(id, state)-> entry
 *
 * `createStore()` wraps a provider with validation and a `get()` helper, so
 * providers stay dumb persistence and the shape is enforced in one place.
 */

import { createHash } from "node:crypto";

export const ENTRY_STATES = Object.freeze([
  "pending",
  "active",
  "stale",
  "revoked",
]);

export const ENTRY_SOURCES = Object.freeze(["enrolment", "k8s", "tailnet"]);

const ENTRY_STATE_SET = new Set(ENTRY_STATES);
const ENTRY_SOURCE_SET = new Set(ENTRY_SOURCES);
const MAX_FIELD_LENGTH = 512;

/**
 * Error carrying the HTTP status and machine-readable code the registry
 * routes report. Everything that can fail on a request path throws one of
 * these so `routes.mjs` never has to guess a status.
 */
export class RegistryError extends Error {
  /**
   * `details` are extra fields the response body carries alongside the code.
   * A caller that has to *act* on a refusal needs the particulars -- which
   * host an entry moved to, say -- and re-deriving them by parsing the prose
   * message is how a client ends up showing "something went wrong".
   */
  constructor(status, code, message, details = null) {
    super(message);
    this.name = "RegistryError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** Stable, URL-safe entry id derived from an SSH fingerprint. */
export function entryId(fingerprint) {
  return createHash("sha256")
    .update(String(fingerprint))
    .digest("hex")
    .slice(0, 32);
}

/**
 * The credential reference an entry is allowed to resolve, derived from its
 * own identity.
 *
 * Deliberately not taken from the registration. A signature proves which
 * machine is calling and says nothing about which secret it may point at, so a
 * node that chose its own reference could name *another* entry's -- enrol,
 * wait to be approved, then repoint `host` at itself and have the proxy
 * deliver that machine's session key. Deriving it removes the choice, and with
 * it the whole class of bug: there is no reference a node can name but does
 * not own.
 */
export function credRefFor(fingerprint) {
  return `openhands/${entryId(fingerprint)}/session-key`;
}

export function assertSource(source) {
  if (!ENTRY_SOURCE_SET.has(source)) {
    throw new RegistryError(
      400,
      "invalid_source",
      `source must be one of ${ENTRY_SOURCES.join(", ")}`,
    );
  }
  return source;
}

export function assertState(state) {
  if (!ENTRY_STATE_SET.has(state)) {
    throw new RegistryError(
      400,
      "invalid_state",
      `state must be one of ${ENTRY_STATES.join(", ")}`,
    );
  }
  return state;
}

function requireString(value, field, { maxLength = MAX_FIELD_LENGTH } = {}) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new RegistryError(400, "invalid_field", `${field} must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw new RegistryError(
      400,
      "invalid_field",
      `${field} must be at most ${maxLength} characters`,
    );
  }
  return trimmed;
}

function optionalString(value, field, options) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  return requireString(value, field, options);
}

/**
 * The host is proxied to and rendered in the switcher, so it is validated at
 * the trust boundary rather than wherever it is first dereferenced.
 */
export function normaliseHost(value) {
  const host = requireString(value, "host");
  let url;
  try {
    url = new URL(host);
  } catch {
    throw new RegistryError(400, "invalid_field", "host must be a URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new RegistryError(400, "invalid_field", "host must be http or https");
  }
  return url.origin + url.pathname.replace(/\/+$/, "");
}

export function normaliseEntry(input) {
  const fingerprint = requireString(input?.fingerprint, "fingerprint");
  return {
    id: input?.id
      ? requireString(input.id, "id", { maxLength: 64 })
      : entryId(fingerprint),
    name: requireString(input?.name, "name", { maxLength: 128 }),
    host: normaliseHost(input?.host),
    pubkey: optionalString(input?.pubkey, "pubkey", { maxLength: 1024 }),
    fingerprint,
    source: assertSource(input?.source ?? "enrolment"),
    credRef: optionalString(input?.credRef, "credRef"),
    state: assertState(input?.state ?? "pending"),
    version: optionalString(input?.version, "version", { maxLength: 64 }),
    lastSeen: optionalString(input?.lastSeen, "lastSeen", { maxLength: 64 }),
  };
}

export function createStore(provider) {
  // Bumped by every mutation so a reader can tell, without asking the
  // provider, whether anything it cached is still current. The fleet proxy
  // reads the entry list on every proxied request, and a per-request round
  // trip to the agent server is both a latency cost on the hot path and an
  // amplification lever; this is what lets it cache without going stale
  // across an approval or a revocation.
  let revision = 0;

  return {
    getRevision() {
      return revision;
    },
    async list() {
      return provider.list();
    },
    async get(id) {
      const entries = await provider.list();
      return entries.find((entry) => entry.id === id) ?? null;
    },
    async upsert(entry) {
      const stored = await provider.upsert(normaliseEntry(entry));
      revision += 1;
      return stored;
    },

    /**
     * Decide and write under the provider's lock.
     *
     * `apply(existing, entries)` receives the entry, and the whole entry list,
     * as they are at the moment of writing, and returns the entry to store.
     * Returning `undefined` writes nothing, for a caller whose decision is
     * "leave it alone" once it sees the entry as it really is. Anything it
     * throws aborts the write. Use this rather than reading with
     * `get()`/`list()` and then calling `upsert`/`setState`: between those two
     * the registry can change, and every precondition checked that way is a
     * race -- whether it is about one entry or about how many there are.
     */
    async mutate(id, apply) {
      let wrote = false;
      const stored = await provider.mutate(id, async (existing, entries) => {
        const next = await apply(existing, entries);
        if (next === undefined) return undefined;
        wrote = true;
        return normaliseEntry(next);
      });
      if (wrote) revision += 1;
      return stored;
    },
    /**
     * Remove unless `check(existing)` throws. The check runs inside the
     * provider's lock, so a decision landing between reading the entry and
     * deleting it -- a revoke -- is seen rather than discarded.
     */
    async removeIf(id, check) {
      const removed = await provider.removeIf(id, check);
      if (removed) revision += 1;
      return removed;
    },
    async remove(id) {
      // Only a real deletion is a revision. Counting a no-op DELETE would
      // throw away every proxy's entry cache for nothing.
      const removed = await provider.remove(id);
      if (removed) revision += 1;
      return removed;
    },
    async setState(id, state) {
      const updated = await provider.setState(id, assertState(state));
      revision += 1;
      return updated;
    },
  };
}
