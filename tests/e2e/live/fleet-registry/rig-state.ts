import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * The rig's state file, written by `tests/e2e/live/fleet-registry/rig.mjs up`.
 *
 * The live spec reads it rather than taking configuration of its own: the rig
 * chooses random ports and generates fresh keys on every run, so anything the
 * spec hard-coded would be wrong by the second run.
 */
export interface RigEntry {
  id: string;
  source?: string;
  name: string;
  host: string;
  fingerprint: string;
  credRef: string | null;
  state: "pending" | "active" | "stale" | "revoked";
  version: string | null;
}

/**
 * Which reachability profile the rig was brought up in. The spec reads this
 * rather than an environment variable, so it can never run the k8s assertions
 * against two VMs and call the result green.
 */
export type RigProfile = "tailnet" | "k8s";

export interface RigState {
  profile: RigProfile;
  rigId: string;
  dir: string;
  baseUrl: string;
  node1Url: string;
  node2Url: string;
  node1Fingerprint: string;
  node2Fingerprint: string;
  ports: {
    masterAgentServer?: number;
    static?: number;
    ingress?: number;
    /** k8s only: the local end of the rig-managed `kubectl port-forward`. */
    portForward?: number;
  };
  /**
   * `node1`/`node2` exist only in the tailnet profile, where each machine has
   * a session key of its own that must never reach the browser. The k8s
   * profile distributes no keys at all.
   */
  keys: { master: string; node1?: string; node2?: string };
  entries: { node1: RigEntry; node2: RigEntry };

  /** tailnet only: the `tailscale serve` URL nodes enrol against. */
  masterServeUrl?: string;

  /** The wire record of every hop to a fleet node, and what vouches for it. */
  evidenceDir: string;
  accessLogPath: string;
  tunnelMapPath: string;

  /** k8s only. */
  kubeconfig?: string;
  namespace?: string;
  releases?: { canvas: string; pool: string };
  canvasService?: string;
  poolService?: string;
  sourceIntervalMs?: number;
}

export const RIG_STATE_PATH = path.resolve(
  process.env.FLEET_RIG_STATE ?? ".tmp/fleet-rig.json",
);

export function readRigState(): RigState {
  try {
    return JSON.parse(readFileSync(RIG_STATE_PATH, "utf8")) as RigState;
  } catch (error) {
    throw new Error(
      `no live fleet rig at ${RIG_STATE_PATH}. Start one with:\n` +
        `  node tests/e2e/live/fleet-registry/rig.mjs up\n` +
        `(${error instanceof Error ? error.message : String(error)})`,
    );
  }
}
