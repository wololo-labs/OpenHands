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
 *   remove(id)         -> void
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
  constructor(status, code, message) {
    super(message);
    this.name = "RegistryError";
    this.status = status;
    this.code = code;
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
    async remove(id) {
      const removed = await provider.remove(id);
      revision += 1;
      return removed;
    },
    async setState(id, state) {
      const updated = await provider.setState(id, assertState(state));
      revision += 1;
      return updated;
    },
  };
}
