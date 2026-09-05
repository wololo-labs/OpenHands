/**
 * Shared machinery for pull sources.
 *
 * A pull source reads a directory that already knows which machines exist (a
 * Kubernetes namespace, a tailnet) and feeds the same store signed enrolment
 * writes to. Membership of that directory is the authorisation, so a
 * discovered machine lands `active` without an approval step; what it still
 * has to earn is liveness, which comes from the unauthenticated `/server_info`
 * probe rather than from the directory's opinion.
 */

import { entryId } from "../store.mjs";

const DEFAULT_PROBE_TIMEOUT_MS = 3_000;

/**
 * Asks a candidate host whether it is an agent server. `/server_info` needs no
 * credential, so liveness and version cost nothing and need no secret.
 */
/**
 * @param {string} host
 * @param {{ fetchImpl?: typeof globalThis.fetch, timeoutMs?: number }} [options]
 */
export async function probeServerInfo(
  host,
  { fetchImpl = fetch, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS } = {},
) {
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetchImpl(new URL("/server_info", host).toString(), {
      signal,
    });
    if (!response.ok) return { reachable: false, version: null };
    const body = await response.json();
    return { reachable: true, version: body?.version ?? null };
  } catch {
    return { reachable: false, version: null };
  }
}

/**
 * A directory listing never overrides a decision an operator made: a revoked
 * entry stays revoked even while the machine is still in the cluster.
 */
function nextState(existing, reachable) {
  if (existing?.state === "revoked") return "revoked";
  return reachable ? "active" : "stale";
}

/**
 * Writes one source's view of the world into the store.
 *
 * Entries that this source used to report and no longer does go `stale` rather
 * than being deleted: a machine missing from one listing is usually a blip,
 * and dropping the entry would also drop the operator's revocation of it.
 *
 * @param {{
 *   store: any,
 *   source: string,
 *   entries: any[],
 *   now?: () => number,
 * }} options
 */
export async function syncSourceEntries({
  store,
  source,
  entries,
  now = () => Date.now(),
}) {
  const existing = await store.list();
  const byId = new Map(existing.map((entry) => [entry.id, entry]));
  const seen = new Set();
  const lastSeen = new Date(now()).toISOString();

  const synced = [];
  for (const entry of entries) {
    const id = entryId(entry.fingerprint);
    seen.add(id);
    synced.push(
      await store.upsert({
        ...entry,
        id,
        source,
        state: nextState(byId.get(id), entry.reachable !== false),
        lastSeen,
      }),
    );
  }

  for (const entry of existing) {
    if (
      entry.source === source &&
      !seen.has(entry.id) &&
      entry.state !== "stale" &&
      entry.state !== "revoked"
    ) {
      await store.setState(entry.id, "stale");
    }
  }

  return synced;
}

export const DEFAULT_SOURCE_INTERVAL_MS = 60_000;

/**
 * Runs one source on an interval, swallowing a failed cycle so a directory
 * being briefly unreachable never takes the registry down with it. Returns a
 * stop function.
 *
 * @param {{
 *   name: string,
 *   sync: () => Promise<unknown>,
 *   intervalMs?: number,
 *   onError?: (name: string, error: unknown) => void,
 * }} options
 */
export function startSourceLoop({
  name,
  sync,
  intervalMs = DEFAULT_SOURCE_INTERVAL_MS,
  onError = (label, error) =>
    console.error(`[registry:${label}] sync failed:`, error),
}) {
  let stopped = false;
  let timer;

  const tick = async () => {
    try {
      await sync();
    } catch (error) {
      onError(name, error);
    }
    if (stopped) return;
    timer = setTimeout(tick, intervalMs);
    // Never hold the process open just to run a discovery cycle.
    timer.unref?.();
  };

  void tick();

  return () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
  };
}
