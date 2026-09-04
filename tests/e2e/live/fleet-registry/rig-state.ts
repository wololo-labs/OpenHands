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
  name: string;
  host: string;
  fingerprint: string;
  credRef: string | null;
  state: "pending" | "active" | "stale" | "revoked";
  version: string | null;
}

export interface RigState {
  rigId: string;
  dir: string;
  baseUrl: string;
  node1Url: string;
  node2Url: string;
  node1Fingerprint: string;
  node2Fingerprint: string;
  ports: {
    masterAgentServer: number;
    node2AgentServer: number;
    static: number;
    ingress: number;
    node1Tunnel: number;
  };
  keys: { master: string; node1: string; node2: string };
  entries: { node1: RigEntry; node2: RigEntry };
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
