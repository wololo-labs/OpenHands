/**
 * Tailnet pull source.
 *
 * Lists tailnet peers tagged `tag:openhands` and feeds them to the registry,
 * so tagging a host makes it appear in the switcher without running the
 * installer's enrolment step.
 *
 * Reads the local `tailscale status --json`, which needs no API key and no
 * control-plane credentials: the node already knows its own tailnet.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { probeServerInfo, syncSourceEntries } from "./sync.mjs";

const execFileAsync = promisify(execFile);

export const OPENHANDS_TAG = "tag:openhands";
export const TAILNET_SOURCE = "tailnet";
/** `tailscale serve` publishes the agent server here on every fleet host. */
export const DEFAULT_TAILNET_PORT = 8443;
const STATUS_TIMEOUT_MS = 5_000;

function trimDot(value) {
  return String(value ?? "").replace(/\.$/, "");
}

/**
 * A peer's tailnet node ID is stable across address changes and re-installs,
 * so it is the identity a discovered entry is keyed by.
 */
export function peerFingerprint(peer) {
  const id = peer?.ID ?? trimDot(peer?.DNSName);
  return id ? `tailnet:${id}` : null;
}

export function peerToCandidate(peer, { port = DEFAULT_TAILNET_PORT } = {}) {
  const dnsName = trimDot(peer?.DNSName);
  const fingerprint = peerFingerprint(peer);
  if (!dnsName || !fingerprint) return null;
  return {
    name: peer?.HostName || dnsName.split(".")[0],
    host: `https://${dnsName}:${port}`,
    fingerprint,
  };
}

export function listTaggedPeers(status, { tag = OPENHANDS_TAG, port } = {}) {
  const peers = Object.values(status?.Peer ?? {});
  return peers
    .filter((peer) => (peer?.Tags ?? []).includes(tag))
    .map((peer) => peerToCandidate(peer, { port }))
    .filter((candidate) => candidate !== null);
}

export async function readTailnetStatus({
  binary = "tailscale",
  run = execFileAsync,
} = {}) {
  const { stdout } = await run(binary, ["status", "--json"], {
    timeout: STATUS_TIMEOUT_MS,
  });
  return JSON.parse(stdout);
}

/**
 * Lists, probes for liveness and version, then writes into the store.
 *
 * @param {{
 *   store: any,
 *   tag?: string,
 *   port?: number,
 *   fetchImpl?: typeof globalThis.fetch,
 *   readStatus?: () => Promise<any>,
 *   now?: () => number,
 * }} options
 */
export async function syncTailnetSource({
  store,
  tag = OPENHANDS_TAG,
  port = DEFAULT_TAILNET_PORT,
  fetchImpl = fetch,
  readStatus = readTailnetStatus,
  now,
}) {
  const candidates = listTaggedPeers(await readStatus(), { tag, port });

  const entries = await Promise.all(
    candidates.map(async (candidate) => {
      const probe = await probeServerInfo(candidate.host, { fetchImpl });
      return {
        ...candidate,
        version: probe.version,
        reachable: probe.reachable,
      };
    }),
  );

  return syncSourceEntries({ store, source: TAILNET_SOURCE, entries, now });
}
