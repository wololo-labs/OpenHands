# Fleet Registry and Signed Enrolment (OpenHands Fork) Implementation Plan

## Overview

Give the Agent Canvas a server-side fleet registry so a user opening the UI on any
device sees every agent server that exists, and let a newly provisioned agent
server enrol itself by signing a request with its own keypair, with credentials
resolved from a pluggable secret provider rather than pasted into a browser.

## Current State Analysis

OpenHands 1.x is a static browser app plus N independent Agent Servers. There is
no discovery, no cross-server awareness, and no server-side registry:

- The registry is browser-local. `src/api/backend-registry/storage.ts` persists to
  `localStorage` keys `openhands-backends` and `openhands-active-backend`; entries
  are `{id, name, host, apiKey, kind, authMode, connectionRevision}`
  (`src/api/backend-registry/types.ts`).
- `src/api/backend-registry/active-store.ts` is the single in-memory store, with
  `getRegisteredBackends()`, `setRegisteredBackends()`, `getSnapshot()` and
  `subscribeActiveBackend()`. Every consumer (`src/root.tsx`,
  `src/contexts/active-backend-context.tsx`, `src/components/features/backends/*`)
  reads through it. This is the hydration seam.
- The only auto-created entry is the origin that served the page
  (`makeDefaultLocalBackend` in `src/api/backend-registry/default-backend.ts`),
  which is why a fresh browser shows exactly one backend.
- Agent-server auth is a single static key list. `OH_SESSION_API_KEYS_0`
  (`agent_server/config.py:24`), read at startup, sent as `X-Session-API-Key`.
  Verified live: no key → `401`, valid key → request served. No scoping, no expiry,
  no rotation.
- `GET /server_info` is **unauthenticated**, verified `200` with no key on both
  intel-mac and claude-hetzner, returning version, uptime and idle time. Liveness
  probing therefore needs no credential.
- `misc_settings` on the agent server is a free-form JSON store. Verified live:
  `PATCH /api/settings {"misc_settings_diff":{...}}` → `200`, read back intact,
  deleted with a `null` value.
- Secrets are encrypted at rest but readable with the same session key:
  `GET /api/settings/secrets` lists names only, while
  `GET /api/settings/secrets/{name}` returns the **plaintext value** as
  `text/plain`. Encryption at rest, not access control.
- `scripts/ingress.mjs` routes by path prefix and already handles one request
  class in-process (`isServerInfoRequest` / `proxyServerInfoRequest`), so adding a
  locally-served route is an established pattern rather than a new concept.
- The Helm chart (`helm/agent-canvas/`) deploys the all-in-one image as a
  single-replica StatefulSet with one PVC. Upstream documents it as
  "unauthenticated, single-tenant … all agents comingled on the same pod and PVC".
- `tailscale whois <ip>` returns machine **and** user identity for a tailnet peer
  (verified), giving an identity source at the ingress with no auth to build.

Two hosts run today, provisioned by `infra/openhands-backend/` in fleet-lambda:
intel-mac (full stack, launchd) and claude-hetzner (backend only, systemd). Both
bind loopback and are published by `tailscale serve` on `:8443`.

## Desired End State

- A user opens the canvas on any device, is identified, and the backend switcher
  is already populated with the live fleet. No key pasting, no manual Add Backend.
- `./deploy-openhands-backend.sh --host X` provisions a machine and that machine
  appears in the switcher without further human action.
- A backend's session key never transits the enrolment path and never reaches a
  browser: the provisioner writes it to a secret provider, the node enrols with a
  reference, and the ingress injects the credential when proxying.
- Adding a new secret provider (1Password, Vault, AWS SM) or a new enrolment
  source (k8s ServiceAccount, cloud IMDS) is a new module implementing an existing
  interface, not a redesign.

Verify by: provisioning a third host with one command and watching it appear,
`pending`, in the switcher on a browser that has never seen it; approving it;
running a conversation on it without the browser ever holding its key.

### Key Discoveries

- Hydration seam is `active-store.setRegisteredBackends()`, one function, all
  consumers already subscribe (`src/api/backend-registry/active-store.ts:164`).
- `storage.ts` becomes a cache layer rather than the source of truth; its
  validation (`isValidBackend`) already rejects malformed entries.
- The ingress can serve a route in-process today (`scripts/ingress.mjs:189`).
- `/server_info` needs no credential, so liveness and version-skew are free.
- Signature proves *possession*, never *authorisation*, so the deploy script must
  pre-seed fingerprints, or entries land in a `pending` queue.
- Every Linux/macOS host already has `/etc/ssh/ssh_host_ed25519_key`, a per-host
  keypair that needs no generation or backup.

## What We're NOT Doing

- No fork of `software-agent-sdk`, `automation`, or `typescript-client`. They stay
  pinned dependencies (`openhands-agent-server==1.44.0`, `openhands-sdk==1.44.0`,
  `openhands-automation==1.9.0`, `@openhands/typescript-client@1.39.0`).
- No key rotation without restart, no scoped or per-conversation credentials, no
  in-server audit, all require the SDK fork.
- No multi-tenancy inside a single agent server. Isolation comes from separate
  agent servers; identity→backend routing is in scope, per-user isolation inside
  one pod is not.
- No gossip/mesh membership, no private CA / mTLS in this pass.
- No changes to how conversations, tools or workspaces behave.

## Implementation Approach

Contract first, then the two ends, then the credential path. The registry is one
store fed by pluggable *enrolment sources* and read by the canvas; credentials are
resolved by a separate pluggable *secret provider* at proxy time. Keeping those two
interfaces apart is what lets k8s discovery or a vault land later without touching
the other half.

Signed self-registration ships first (works in every environment); tailnet and k8s
discovery become additional sources afterwards.

## User Journey (target state)

**Day 0, stand up the master.** One host runs the canvas plus the registry. Its URL
is the only address anyone else needs to know.

```
./install-openhands-backend.sh --mode full --registry-master
   -> canvas + agent server + registry
   -> prints REGISTRY_URL and the registry admin key
```

**Day 1, add an execution machine.** The node is handed the master URL; it is never
handed the master credentials.

```
./deploy-openhands-backend.sh \
  --host 100.125.222.64 --user claude \
  --registry https://<master>.<tailnet>.ts.net:8443 \
  --secret-provider op \
  --preseed
```

What happens at that moment:

```
 node                                      master registry
 1. install, patch, key, service
 2. health check passes
 3. read /etc/ssh/ssh_host_ed25519_key
 4. --preseed: operator pushes fpr  ---->  allowlist += SHA256:abc...
 5. session key -> secret provider
    ref: openhands/<host>/session-key
 6. POST /api/registry/register     ---->  verify signature
    {name,host,pubkey,credRef,...}         known fpr -> active
    + X-Registry-Signature                 unknown   -> pending
 7. exit 0                          <----  201 {id, state}
```

**Day 1, the user.** Opens the canvas, the switcher is already populated; selecting a
backend proxies through the master, which resolves the credential and injects it.

**Day 30, a new browser.** Same URL, full fleet immediately: `localStorage` is a
cache, not the source of truth.

### Behaviour at the edges

| situation | outcome |
| --- | --- |
| `--registry` omitted | installer behaves exactly as today, no enrolment |
| registry unreachable at deploy | install succeeds, registration retries, exit code unaffected |
| node not pre-seeded | entry lands `pending`, visible but not connectable |
| master down later | existing browsers work off cache, new browsers see nothing |
| node re-deployed | same fingerprint updates the entry, no duplicate |
| machine decommissioned | drop the fingerprint, entry revoked, proxy fails closed |

Requires bidirectional reachability: the node reaches the master to register, the
master reaches the node to probe and to proxy. Both verified on the current tailnet.

Design note: the node registers itself rather than the deploy script registering on
its behalf. Script-side registration is simpler and needs no keypair, but nothing
re-announces after a reboot, an address change, or a restore, so the registry drifts
from reality.

---

---

## Phase 1: Registry service and enrolment contract
<!-- wave: 1 | depends_on: [] | files: [scripts/registry/store.mjs, scripts/registry/providers/inline.mjs, scripts/registry/enrolment.mjs, scripts/registry/routes.mjs, scripts/ingress.mjs, __tests__/registry/enrolment.test.mjs] -->

### Overview
Add a registry served in-process by the existing node stack: entry store, signed
enrolment verification, approval states, and the REST surface the canvas will read.

### Changes Required:

#### 1. Entry store and provider interface
**File**: `scripts/registry/store.mjs`, `scripts/registry/providers/inline.mjs`
**Changes**: Entry shape and a storage provider interface with one implementation.

```js
// entry
// { id, name, host, pubkey, fingerprint, credRef, state, version, lastSeen }
// state: "pending" | "active" | "stale" | "revoked"

// provider interface (storage of the registry itself)
// list() -> entry[]            upsert(entry) -> entry
// remove(id) -> void           setState(id, state) -> entry
```

Inline provider persists to the agent server's `misc_settings.fleet_backends` via
`PATCH /api/settings` (read-modify-write, verified working) so there is no new
datastore to operate.

#### 2. Signed enrolment
**File**: `scripts/registry/enrolment.mjs`
**Changes**: Verify an ed25519 signature over a canonical payload, reject replays.

```js
// POST /api/registry/register
// body:   { name, host, pubkey, credRef, version, nonce, ts }
// header: X-Registry-Signature: base64(ed25519(priv, canonical(body)))
//
// verify(body, sig) -> proves possession of pubkey
// authorise(fingerprint):
//   pre-seeded fingerprint  -> state "active"
//   otherwise               -> state "pending"   (TOFU queue)
// replay guard: reject ts older than 300s, nonce seen within that window
// idempotent: same fingerprint updates its entry, never duplicates
```

#### 3. Routes on the ingress
**File**: `scripts/registry/routes.mjs`, `scripts/ingress.mjs`
**Changes**: Serve `/api/registry/*` in-process, following the existing
`isServerInfoRequest` precedent at `scripts/ingress.mjs:189`.

```
GET    /api/registry            list entries (session-key auth)
POST   /api/registry/register   signed enrolment (signature auth, no session key)
POST   /api/registry/:id/approve
POST   /api/registry/:id/revoke
```

### Success Criteria:

#### Automated Verification:
- [ ] Tests pass: `npm test`
- [ ] Type checking passes: `npm run typecheck`
- [ ] Linting passes: `npm run lint`
- [ ] Enrolment unit tests cover: valid signature, wrong key, replayed nonce, stale
      timestamp, pre-seeded auto-approve, TOFU pending, idempotent re-register
- [ ] `curl POST /api/registry/register` with a generated key returns `pending`
- [ ] `GET /api/registry` without a session key returns `401`

#### Manual Verification:
- [ ] Entries survive a service restart (written through to `misc_settings`)
- [ ] A rogue registration cannot reach `active` without approval

---

## Phase 2: Canvas hydrates from the registry
<!-- wave: 2 | depends_on: [1] | files: [src/api/backend-registry/registry-source.ts, src/api/backend-registry/active-store.ts, src/api/backend-registry/storage.ts, src/components/features/backends/backend-selector.tsx, src/components/features/backends/manage-backends-modal.tsx] -->

### Overview
Make the fleet list arrive from the registry, with `localStorage` demoted to a
cache, and surface trust state in the UI.

### Changes Required:

#### 1. Registry source
**File**: `src/api/backend-registry/registry-source.ts`
**Changes**: Fetch `/api/registry`, map entries to `Backend`, handle failure.

```ts
// hydrate(): on boot and on an interval
//   GET /api/registry -> entries
//   setRegisteredBackends(merge(cachedBackends, entries))
//   on network failure: keep the cache, mark entries "unverified"
```

#### 2. Hydration seam
**File**: `src/api/backend-registry/active-store.ts`, `storage.ts`
**Changes**: Registry entries win over cache; manual entries are preserved and
marked `local`. `writeStoredBackends` keeps caching so an offline browser still
opens.

#### 3. UI trust provenance
**File**: `src/components/features/backends/backend-selector.tsx`,
`manage-backends-modal.tsx`
**Changes**: Show `pending` entries as non-connectable with an Approve action, and
label provenance (pre-seeded / approved / manual).

### Success Criteria:

#### Automated Verification:
- [ ] Tests pass: `npm test`
- [ ] Type checking passes: `npm run typecheck`
- [ ] Build succeeds: `npm run build`
- [ ] Unit test: registry unreachable → cached list still renders

#### Manual Verification:
- [ ] A browser that has never seen the fleet shows every active backend
- [ ] A `pending` entry cannot be selected until approved
- [ ] Clearing site data and reloading restores the list from the registry

### Checkpoints:
- **`[CHECKPOINT:human-verify]`**: Review the switcher before wiring credentials
  - What was built: registry-backed backend list with trust states
  - How to verify: (1) open the canvas in a private window, (2) confirm the fleet
    appears without pasting a key, (3) confirm a pending entry is greyed out
  - Resume: Type "approved" or describe issues

---

## Phase 3: Enrolment client (`bin/enrol`) and installer integration
<!-- wave: 2 | depends_on: [1] | files: [bin/enrol.mjs, scripts/registry/sign.mjs, __tests__/registry/enrol.test.mjs] -->

### Overview
The fork owns the enrolment protocol. `bin/enrol` signs and posts a registration;
any deployment method (the fleet-lambda installer, Helm, Ansible, a human) invokes
it. A protocol change never requires editing another repository.

### Changes Required:

#### 1. Enrolment CLI
**File**: `bin/enrol.mjs`, `scripts/registry/sign.mjs`
**Changes**: One command that reads the host key, publishes the session key to the
configured secret provider, and posts a signed registration.

```
agent-canvas enrol \
  --registry https://<master>:8443 \
  --name hetzner \
  --host https://claude-hetzner.<tailnet>.ts.net:8443 \
  --secret-provider op \
  [--key /etc/ssh/ssh_host_ed25519_key] \
  [--print-fingerprint]

# reuses the host key by default, generates one only when absent
# --print-fingerprint exits after printing, for pre-seeding the allowlist
# idempotent: re-running updates the entry for that fingerprint
```

Signing reuses `ssh-keygen -Y sign -n registry`, so no crypto library is added and
the key format is one every host already has.

#### 2. Provisioning integration (repo: `fleet-lambda`)
**File**: `infra/openhands-backend/install-openhands-backend.sh`,
`deploy-openhands-backend.sh`, `README.md`
**Changes**: Add `--registry <url>`, `--secret-provider <name>` and `--preseed`.
The installer calls `agent-canvas enrol` after the health check and does not know
the payload shape, the signature scheme, or the endpoint. Enrolment is skipped when
`--registry` is absent, so current behaviour is unchanged.

### Success Criteria:

#### Automated Verification:
- [ ] Tests pass: `npm test`
- [ ] Unit tests: signature output verifies against the public key, `--print-fingerprint`
      matches `ssh-keygen -lf`, missing provider fails loudly
- [ ] `bin/enrol --registry <local> --print-fingerprint` exits 0 without network
- [ ] fleet-lambda side: `shellcheck -S warning infra/openhands-backend/*.sh` clean and
      `uv run --with pytest --with pyyaml pytest tests/test_infra_safety.py -q` passes

#### Manual Verification:
- [ ] A fresh deploy with `--registry` produces exactly one entry, `active` when
      pre-seeded and `pending` when not
- [ ] Re-running the deploy does not duplicate the entry
- [ ] Without `--registry` the installer behaves exactly as it does today

---

## Phase 4: Credential resolution and ingress injection
<!-- wave: 3 | depends_on: [2, 3] | files: [scripts/registry/secrets/interface.mjs, scripts/registry/secrets/file.mjs, scripts/registry/secrets/onepassword.mjs, scripts/proxy-backend.mjs, scripts/ingress.mjs] -->

### Overview
Resolve each backend's credential server-side and inject it when proxying, so the
browser never holds a fleet key.

### Changes Required:

#### 1. Secret provider interface
**File**: `scripts/registry/secrets/interface.mjs` plus `file.mjs`, `onepassword.mjs`
**Changes**: `get(ref) -> secret`, `put(ref, secret)`, `describe() -> {name, healthy}`.
File provider first (no dependency), 1Password second via the installed `op` CLI.

#### 2. Injecting proxy
**File**: `scripts/proxy-backend.mjs`, `scripts/ingress.mjs`
**Changes**: Route `/backend/:id/*` to the entry's host, resolve `credRef`, set
`X-Session-API-Key` outbound. Caller identity from `tailscale whois` on the source
address where available; policy decides whether that caller may reach that entry.

### Success Criteria:

#### Automated Verification:
- [ ] Tests pass: `npm test`
- [ ] A proxied request with no credential in the browser reaches the backend and
      returns `200`
- [ ] A revoked entry returns `403` at the proxy
- [ ] Provider tests: file provider round-trips; 1Password provider skips cleanly
      when `op` is absent

#### Manual Verification:
- [ ] A conversation runs end to end with no key in `localStorage`
- [ ] Killing the secret provider degrades to a clear error, never a silent fallback

---

## Phase 5: Kubernetes shape and additional enrolment sources
<!-- wave: 4 | depends_on: [4] | files: [helm/agent-canvas/values.yaml, helm/agent-canvas/templates/statefulset.yaml, helm/agent-canvas/templates/rbac.yaml, scripts/registry/sources/k8s.mjs, scripts/registry/sources/tailnet.mjs, docs/registry.md] -->

### Overview
Make the registry populate itself where a directory already exists, and ship the
chart changes for a canvas + agent-pool topology.

### Changes Required:

#### 1. Pull sources
**File**: `scripts/registry/sources/k8s.mjs`, `sources/tailnet.mjs`
**Changes**: List Services labelled `app.kubernetes.io/name=agent-server`; list
tailnet devices tagged `tag:openhands`. Both probe `/server_info` (unauthenticated)
for liveness and version, and feed the same store as signed enrolment.

#### 2. Chart
**File**: `helm/agent-canvas/values.yaml`, `templates/statefulset.yaml`,
`templates/rbac.yaml`
**Changes**: Registry configuration values, an optional agent-pool release, and the
RBAC role needed to list Services when k8s discovery is enabled.

#### 3. Docs
**File**: `docs/registry.md`
**Changes**: Enrolment, providers, sources, trust model, and the identity→backend
routing pattern.

### Success Criteria:

#### Automated Verification:
- [ ] `helm lint helm/agent-canvas`
- [ ] `helm template` renders with registry enabled and disabled
- [ ] Source unit tests with a faked API response

#### Manual Verification:
- [ ] In a kind/k3d cluster, scaling the agent pool changes the switcher contents
- [ ] Tagging a tailnet host makes it appear without running the installer

---

## Conventions

Upstream keeps numbered requirement checklists in `specs/` (see
`specs/backend-management.md`, entries like `BM-001`). Add `specs/fleet-registry.md`
with `FR-00x` entries as phases land, so the fork's own requirements follow the same
shape as upstream's.

## Testing Strategy

### Unit Tests
Signature verification (valid, wrong key, replay, clock skew), authorisation
(pre-seeded vs TOFU), entry idempotency, provider round-trips, registry-unreachable
fallback to cache.

### Integration Tests
Provision a throwaway host with the installer against a local registry, assert it
appears `pending`, approve it, run a conversation through the injecting proxy, then
revoke it and assert `403`.

### Manual Testing Steps
1. Open the canvas in a private window; confirm the fleet appears with no key paste.
2. Deploy a new host; confirm it appears without touching the browser.
3. Register with an unknown key; confirm `pending` and non-connectable.
4. Revoke a host; confirm it disappears and proxying fails closed.

## Performance Considerations

Proxy injection funnels all backend traffic through one host, adding a hop and
making that host a latency and availability path. Registry reads are cached in the
browser and refreshed on an interval; liveness probes are one unauthenticated GET
per entry per cycle, so probe interval should scale with fleet size.

## Migration Notes

Existing browsers keep their `localStorage` entries; hydration merges rather than
replaces, and manual entries stay marked `local`. Hosts provisioned before this
work enrol on their next deploy, or can be pre-seeded by hand. Nothing in Phase 1-3
changes how existing direct browser-to-host connections behave.

## References
- This plan lives in the fork; `fleet-lambda` keeps a pointer in
  `infra/openhands-backend/README.md`.
- Fork: `https://github.com/wololo-labs/OpenHands` (upstream name kept; rename
  deferred until divergence is real), clone at `~/Developer/OpenHands-wololo`
- Upstream boundaries: `README.md` repository table
- Provisioning scripts: `infra/openhands-backend/` (fleet-lambda, commits cd99624, 1f747e9)
- Explainer: `https://explainers.stevengonsalvez.com/openhands-canvas/`
