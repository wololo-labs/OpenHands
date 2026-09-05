# Fleet Registry Specs

Requirements for the server-side fleet registry and signed enrolment described
in `docs/fleet-registry-plan.md`. Entries land as each phase ships.

---

## Phase 1: registry service and enrolment contract

### FR-001: Registry is off unless configured

- [x] The ingress shall serve `/api/registry/*` in-process only when a registry
      session key is configured. Without it, the path shall route exactly as it
      does today.

### FR-002: Entries persist without a new datastore

- [x] Registry entries shall be written through to the agent server's
      `misc_settings.fleet_backends`, so they survive a service restart.

### FR-003: Registration proves possession of a host key

- [x] `POST /api/registry/register` shall verify an ed25519 signature over the
      canonical form of the request body, and reject a signature made with any
      other key.

### FR-004: Registration is replay-resistant

- [x] A registration shall be rejected when its timestamp is outside the
      300-second window, or when its nonce has already been used inside that
      window.

- [x] A registration the registry refuses shall not consume a nonce slot. The
      table is finite, so spending one on a rejected call lets a flood fill it
      and answer `503` to the enrolments that would have been accepted.

### FR-005: A signature is not an authorisation

- [x] A pre-seeded fingerprint shall enrol as `active`. Any other fingerprint
      shall enrol as `pending` and shall not be connectable until approved.

### FR-006: Registration is idempotent

- [x] Re-registering the same fingerprint shall update that entry rather than
      creating a second one.

### FR-007: Re-registration never escalates trust

- [x] A revoked entry shall stay revoked when it re-registers, and an approved
      entry shall stay approved once its fingerprint leaves the pre-seed list.

- [x] A hand-approved entry that changes its host shall return to `pending`.
      An approval is of a machine at an address, and the address was part of
      what the operator could see; silently repointing the proxy at somewhere
      they never agreed to is the same escalation by another route. A
      pre-seeded fingerprint is exempt, because pre-seeding trusts an identity
      rather than an address, and re-announcing after a reboot or a
      reassignment is the case self-enrolment exists for.

### FR-008: Reads and approvals require the session key

- [x] `GET /api/registry` and the approve/revoke routes shall return `401`
      without a valid session key. Only registration is unauthenticated.

### FR-009: An unreachable store fails loudly

- [x] When the registry cannot reach its storage, requests shall fail with a
      `store_unavailable` error rather than silently reporting an empty fleet.

---

## Phase 2: canvas hydrates from the registry

### FR-010: The fleet arrives from the server, not from the browser

- [x] On a browser that has never seen the fleet, the backend list shall be
      populated from `GET /api/registry` with no key pasted and no manual add.

### FR-011: `localStorage` is a cache, not the source of truth

- [x] When the registry is unreachable the cached list shall still render, and
      the UI shall say the list is unverified. A deployment that serves no
      registry shall behave exactly as it does today.

### FR-012: A pending entry is not connectable

- [x] A `pending` entry shall be listed but shall refuse selection, in the
      switcher and in Manage Backends, until it is approved.

### FR-013: Provenance is visible

- [x] Each row shall say whether it came from the fleet registry or was added
      manually, and manual entries shall survive hydration untouched.

### FR-014: Fleet entries are server-owned

- [x] A fleet entry shall offer approve and revoke rather than edit and delete,
      because the browser's copy is a cache the next hydration overwrites.

---

## Phase 3: enrolment client

### FR-015: The fork owns the enrolment protocol

- [x] `agent-canvas enrol` shall sign and post a registration, so no other
      repository needs to know the payload shape, signature scheme or endpoint.

### FR-016: Enrolment reuses the machine's existing identity

- [x] Signing shall use the host's ed25519 SSH key by default, and
      `--print-fingerprint` shall print what `ssh-keygen -lf` prints for it and
      exit without touching the network.

### FR-017: A misconfigured secret provider fails loudly

- [x] An unknown or unusable secret provider shall abort enrolment rather than
      registering without publishing the key.

### FR-018: The session key never enters the registration

- [x] The registration shall carry only a credential reference; the key itself
      goes to the secret provider.

- [x] The stored reference shall be derived from the entry's fingerprint rather
      than taken from the registration, so no machine can name a reference
      belonging to another. Pinning a caller-supplied reference at first
      enrolment is insufficient: the first enrolment can be the attacker's.

---

## Phase 4: credential resolution and ingress injection

### FR-019: The browser never holds a fleet key

- [x] `/backend/:id/*` shall resolve the entry's credential server-side and
      attach it outbound, and shall strip any credential the caller sent, in
      the header and in the query string alike.

### FR-019a: The proxy authenticates its caller

- [x] `/backend/:id/*` shall require the master's session key, in the
      `X-Session-API-Key` header or the `session_api_key` query parameter, and
      shall answer `401` without it before it reads the registry. The proxy
      satisfies the node's own authentication on the caller's behalf, so a
      caller it does not check is a caller granted the whole fleet.

- [x] A fleet WebSocket shall present that key on the handshake URL, since a
      browser can set no header on an upgrade and a proxy cannot act on a
      post-open `auth` frame, and shall not also send that frame, which would
      relay this origin's key to the fleet machine unrewritten.

### FR-020: The proxy fails closed

- [x] An unknown entry shall be `404`, an entry that is not `active` shall be
      `403`, an entry carrying no credential reference shall be `403`, and a
      credential the provider cannot resolve shall be `502`. None shall fall
      back to proxying without a credential.

- [x] A deployment that wants an uncredentialed entry proxied anyway shall say
      so explicitly with `--registry-allow-uncredentialed`. Discovered entries
      have no credential reference by construction, so this is the difference
      between a source that lists a machine and a source that grants
      unauthenticated access to it.

### FR-021: Caller identity is available to a policy

- [x] Where `tailscale whois` can name the caller, a configured policy shall
      decide whether that caller may reach that entry. With no policy
      configured no identity lookup shall run.

---

## Phase 5: Kubernetes shape and additional enrolment sources

### FR-022: A directory that already knows the fleet populates the registry

- [x] Services labelled `app.kubernetes.io/name=agent-server` and tailnet peers
      tagged `tag:openhands` shall feed the same store as signed enrolment,
      with liveness and version from the unauthenticated `/server_info` probe.

### FR-023: A discovered machine that disappears goes stale, not missing

- [x] An entry a source stops reporting shall become `stale` rather than being
      deleted, so an operator's revocation is never lost to a blip in a listing.

### FR-024: Discovery asks for only the permission it needs

- [x] Enabling Kubernetes discovery shall create a namespace-scoped Role for
      listing Services, independent of the chart's broad `admin` binding.
