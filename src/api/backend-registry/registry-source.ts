import { getRegisteredBackends, setRegisteredBackends } from "./active-store";
import { makeDefaultLocalBackend } from "./default-backend";
import type { Backend, RegistryEntryState } from "./types";

/**
 * Hydrates the backend list from the fleet registry served by this origin's
 * ingress (`scripts/registry/routes.mjs`).
 *
 * `localStorage` is demoted to a cache: the registry is the source of truth
 * for the entries it owns, manual entries are left alone, and a registry that
 * cannot be reached leaves the cached list on screen rather than emptying the
 * switcher.
 */

export const REGISTRY_ENDPOINT = "/api/registry";

/** Prefix that distinguishes a hydrated entry's id from a manual backend's. */
export const REGISTRY_ID_PREFIX = "registry:";

export const REGISTRY_HYDRATION_INTERVAL_MS = 60_000;

/** Path prefix the ingress mounts the credential-injecting proxy on. */
export const BACKEND_PROXY_PREFIX = "/backend";

export interface RegistryEntry {
  id: string;
  name: string;
  host: string;
  fingerprint: string;
  state: RegistryEntryState;
  credRef?: string | null;
  version?: string | null;
  lastSeen?: string | null;
}

/**
 * - `idle`      nothing fetched yet
 * - `ok`        last fetch succeeded
 * - `unreachable` last fetch failed; the list on screen is the cache
 * - `disabled`  this deployment serves no registry, so nothing is hydrated
 */
export type RegistryStatus = "idle" | "ok" | "unreachable" | "disabled";

type Listener = () => void;

let status: RegistryStatus = "idle";
const listeners = new Set<Listener>();

export function getRegistryStatus(): RegistryStatus {
  return status;
}

export function subscribeRegistryStatus(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function setStatus(next: RegistryStatus): void {
  if (status === next) return;
  status = next;
  listeners.forEach((listener) => listener());
}

function isRegistryEntry(value: unknown): value is RegistryEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Partial<RegistryEntry>;
  return (
    typeof entry.id === "string" &&
    entry.id.length > 0 &&
    typeof entry.name === "string" &&
    typeof entry.host === "string" &&
    (entry.state === "pending" ||
      entry.state === "active" ||
      entry.state === "stale" ||
      entry.state === "revoked")
  );
}

export function registryBackendId(entryId: string): string {
  return `${REGISTRY_ID_PREFIX}${entryId}`;
}

/** Recovers the registry's own entry id from a hydrated backend. */
export function registryEntryId(backend: Backend): string | null {
  return backend.id.startsWith(REGISTRY_ID_PREFIX)
    ? backend.id.slice(REGISTRY_ID_PREFIX.length)
    : null;
}

/**
 * A fleet entry is reached through this origin's injecting proxy rather than
 * directly, so the browser never holds its key: the master resolves the
 * credential from the secret provider and attaches it on the way out.
 *
 * A path prefix is a usable base URL here because the SDK resolves request
 * paths relative to it and the websocket helpers carry the prefix through
 * (the same shape as the existing `/runtime/<port>` proxy deployments).
 */
export function backendProxyHost(entryId: string): string {
  const origin =
    typeof window === "undefined"
      ? ""
      : window.location.origin.replace(/\/+$/, "");
  return `${origin}${BACKEND_PROXY_PREFIX}/${encodeURIComponent(entryId)}`;
}

/**
 * Whether a URL is reached through this origin's fleet proxy.
 *
 * A fleet backend's host is `<origin>/backend/<entry id>`, and traffic to it
 * has to authenticate to the proxy rather than to the machine at the far end.
 * That changes how a WebSocket must present its credential, which is why the
 * question is asked about a URL rather than carried on the backend record: the
 * socket layer only ever sees the URL.
 */
export function isFleetProxyUrl(url: string | null | undefined): boolean {
  if (!url || typeof window === "undefined") return false;
  try {
    const target = new URL(url, window.location.origin);
    // Both halves matter. The path alone would also match a *manual* backend
    // someone pointed at `https://elsewhere.example/backend/x`, and that host
    // is not this proxy: it expects the post-open frame, and putting the key
    // in its URL would write the credential into a third party's logs.
    return (
      target.origin === window.location.origin &&
      target.pathname.startsWith(`${BACKEND_PROXY_PREFIX}/`)
    );
  } catch {
    return false;
  }
}

/**
 * The session key this origin issued us, which is also what the ingress
 * expects on `/api/registry` and on `/backend/:id`.
 */
function originSessionKey(): string {
  return makeDefaultLocalBackend()?.apiKey ?? "";
}

/**
 * A fleet entry is reached at this origin, so it carries this origin's
 * credential -- not the node's, which the browser never sees. The ingress
 * checks this key to decide whether the caller may use the proxy at all, then
 * strips it and substitutes the node's own before the request goes out.
 *
 * The distinction is the whole security property: what the browser holds
 * authorises it against the master it already talks to, and buys it nothing if
 * it leaks to a fleet machine.
 */
function toBackend(entry: RegistryEntry): Backend {
  return {
    id: registryBackendId(entry.id),
    name: entry.name,
    host: backendProxyHost(entry.id),
    apiKey: originSessionKey(),
    kind: "local",
    provenance: "registry",
    registryState: entry.state,
    registryHost: entry.host,
  };
}

/**
 * Registry entries replace the previously hydrated set; manual entries are
 * kept untouched, including one that happens to point at the same host. A
 * manual entry carries that host's own credential and reaches it directly,
 * where a fleet entry goes through this origin's proxy, so silently collapsing
 * the two would take away a backend that works today.
 *
 * Revoked entries are dropped rather than shown: a decommissioned host must
 * disappear from the switcher.
 */
export function mergeRegistryEntries(
  cached: Backend[],
  entries: RegistryEntry[],
): Backend[] {
  const manual = cached.filter((backend) => backend.provenance !== "registry");
  const hydrated = entries
    .filter((entry) => entry.state !== "revoked")
    .map(toBackend);
  return [...manual, ...hydrated];
}

function sessionHeaders(): Record<string, string> {
  // The registry is served by the same ingress that serves this page and
  // authenticates with the same session key the launcher baked in.
  const apiKey = originSessionKey();
  return apiKey ? { "X-Session-API-Key": apiKey } : {};
}

async function registryRequest(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  return fetch(path, {
    ...init,
    headers: { ...sessionHeaders(), ...(init?.headers ?? {}) },
  });
}

/**
 * Reads the registry. Returns `null` when this deployment serves no registry,
 * which is the default: the ingress only mounts the route when a registry
 * session key is configured, and otherwise the path reaches the agent server,
 * which does not implement it.
 */
export async function fetchRegistryEntries(): Promise<RegistryEntry[] | null> {
  const response = await registryRequest(REGISTRY_ENDPOINT);
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`registry responded with ${response.status}`);
  }

  const body: unknown = await response.json();
  const entries = (body as { entries?: unknown } | null)?.entries;
  // A deployment without a registry can answer this path with something else
  // entirely; anything that is not the documented shape counts as "no registry".
  if (!Array.isArray(entries)) return null;
  return entries.filter(isRegistryEntry);
}

/**
 * Fetches the fleet and pushes it through the store's hydration seam.
 * Returns `false` once it learns there is no registry to hydrate from, so the
 * caller can stop polling.
 */
export async function hydrateFromRegistry(): Promise<boolean> {
  try {
    const entries = await fetchRegistryEntries();
    if (entries === null) {
      setStatus("disabled");
      return false;
    }
    setRegisteredBackends(
      mergeRegistryEntries(getRegisteredBackends(), entries),
    );
    setStatus("ok");
    return true;
  } catch {
    // Keep the cached list on screen; the UI marks it unverified.
    setStatus("unreachable");
    return true;
  }
}

/**
 * A registry refusal, carrying the machine-readable code and whatever
 * particulars came with it.
 *
 * The code matters to the caller: `entry_changed` is not a transient failure
 * to retry, it means the machine moved and the operator has to look again.
 * Collapsing it into a generic error turns a working safeguard into something
 * that goes away on the second click.
 */
export class RegistryActionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly host?: string,
  ) {
    super(message);
    this.name = "RegistryActionError";
  }
}

async function setRegistryEntryState(
  backend: Backend,
  action: "approve" | "revoke",
): Promise<void> {
  const entryId = registryEntryId(backend);
  if (!entryId) return;

  // Approve names the address it is approving, so an entry that moved between
  // the operator reading the row and clicking is refused rather than ratified.
  if (action === "approve" && !backend.registryHost) {
    throw new RegistryActionError(
      "host_unknown",
      "this entry has no address to approve",
    );
  }

  const init: RequestInit =
    action === "approve"
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ host: backend.registryHost }),
        }
      : { method: "POST" };

  const response = await registryRequest(
    `${REGISTRY_ENDPOINT}/${encodeURIComponent(entryId)}/${action}`,
    init,
  );
  if (!response.ok) {
    const failure = (await response.json().catch(() => null)) as {
      error?: string;
      message?: string;
      details?: { host?: string };
    } | null;
    // Re-read before surfacing, so whatever the operator is shown next is the
    // entry as it now is rather than the copy they clicked on.
    await hydrateFromRegistry();
    throw new RegistryActionError(
      failure?.error ?? `http_${response.status}`,
      failure?.message ?? `registry ${action} failed with ${response.status}`,
      failure?.details?.host,
    );
  }
  await hydrateFromRegistry();
}

export function approveRegistryEntry(backend: Backend): Promise<void> {
  return setRegistryEntryState(backend, "approve");
}

export function revokeRegistryEntry(backend: Backend): Promise<void> {
  return setRegistryEntryState(backend, "revoke");
}

/**
 * Hydrates on boot and on an interval. Returns a stop function; polling also
 * stops on its own once the deployment is known to serve no registry.
 */
export function startRegistryHydration(
  intervalMs: number = REGISTRY_HYDRATION_INTERVAL_MS,
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const tick = async () => {
    const keepPolling = await hydrateFromRegistry();
    if (stopped || !keepPolling) return;
    timer = setTimeout(tick, intervalMs);
  };

  void tick();

  return () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
  };
}

/** Test-only: forget the last known registry status. */
export function __resetRegistryStatusForTests(): void {
  status = "idle";
  listeners.clear();
}
