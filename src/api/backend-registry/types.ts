export type BackendKind = "local" | "cloud";
export type BackendAuthMode = "api-key" | "cookie";

/**
 * Where a registered backend came from. Absent means the same thing as
 * `"manual"`: entries persisted before the fleet registry existed are
 * user-added by definition.
 */
export type BackendProvenance = "manual" | "registry";

/** Trust state an entry carries in the fleet registry (see `scripts/registry`). */
export type RegistryEntryState = "pending" | "active" | "stale" | "revoked";

export interface Backend {
  id: string;
  name: string;
  host: string;
  apiKey: string;
  kind: BackendKind;
  authMode?: BackendAuthMode;
  /** Changes whenever connection credentials change, invalidating keyed data. */
  connectionRevision?: number;
  /** Set to `"registry"` on entries hydrated from the fleet registry. */
  provenance?: BackendProvenance;
  /** Registry trust state; only meaningful when `provenance` is `"registry"`. */
  registryState?: RegistryEntryState;
  /**
   * The address the fleet entry actually answers on, as opposed to `host`,
   * which is this origin's proxy path. Kept because an operator approving an
   * entry is approving a machine *at an address*, and the proxy path shows
   * them nothing about which machine that is.
   */
  registryHost?: string;
}

export interface BackendSelection {
  backendId: string;
  orgId?: string | null;
}

export interface ResolvedActiveBackend {
  backend: Backend;
  orgId: string | null;
}
