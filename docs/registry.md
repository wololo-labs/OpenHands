# Fleet Registry

A user opening the Agent Canvas on any device sees every agent server that
exists, and a newly provisioned machine appears there without anyone pasting a
key. This page describes how that works, what it trusts, and how to turn it on.

The implementation plan this grew from is `docs/fleet-registry-plan.md`; the
numbered requirements are in `specs/fleet-registry.md`.

## Shape

```
 browser                    master (canvas + registry)          fleet node
 ┌──────────┐   GET /api/registry   ┌────────────────────┐
 │ switcher │ ◀────────────────────▶│ registry store     │
 └────┬─────┘                       │  misc_settings     │
      │                             ├────────────────────┤   POST register
      │ /backend/<id>/api/...       │ enrolment verify   │◀───────────────┐
      └────────────────────────────▶│ injecting proxy    │                │
                                    └─────────┬──────────┘         ┌──────┴─────┐
                                              │  X-Session-API-Key │ agent      │
                                              └───────────────────▶│ server     │
                                    ┌────────────────────┐         └────────────┘
                                    │ secret provider    │
                                    │  file | op         │
                                    └────────────────────┘
```

Two interfaces are kept apart on purpose. _Enrolment sources_ decide which
machines exist; _secret providers_ decide how a machine's credential is
resolved. Adding a vault or a new discovery mechanism is a new module behind an
existing interface, not a redesign.

## Turning it on

The registry is off unless a session key is configured, so an ingress started
the way it is today behaves exactly as it does today.

```bash
node scripts/ingress.mjs \
  --port 8000 \
  --route "/api=http://localhost:18000" \
  --default "http://localhost:3001" \
  --registry-session-key "$OH_SESSION_API_KEYS_0" \
  --registry-secret-provider file \
  --registry-preseed "SHA256:8NeiIgzltMXycwvv3RnvRhfFAVAiqHx+kkUgfMYO2iA"
```

| Flag                         | Environment variable       | Meaning                                                                |
| ---------------------------- | -------------------------- | ---------------------------------------------------------------------- |
| `--registry-session-key`     | `REGISTRY_SESSION_KEY`     | Enables the registry and authenticates its read and approval routes    |
| `--registry-agent-server`    | `REGISTRY_AGENT_SERVER`    | Where entries are stored (defaults to whichever backend serves `/api`) |
| `--registry-preseed`         | `REGISTRY_PRESEED`         | Fingerprints that enrol straight to `active`                           |
| `--registry-secret-provider` | `REGISTRY_SECRET_PROVIDER` | Resolves a fleet backend's key when proxying (`file`, `op`)            |
| `--registry-allow-uncredentialed` | `REGISTRY_ALLOW_UNCREDENTIALED` | Proxy entries that carry no credential reference (off by default) |

Entries live in the agent server's `misc_settings.fleet_backends`, so there is
no second datastore to operate and they survive a restart.

## Trust model

A signature proves **possession**, never **authorisation**. A node proves it
holds its own SSH host key; whether that node may be reached is a separate
decision:

| Situation                                        | Outcome                                              |
| ------------------------------------------------ | ---------------------------------------------------- |
| Fingerprint pre-seeded before the node registers | `active`, connectable immediately                    |
| Fingerprint not pre-seeded                       | `pending`, listed but not connectable until approved |
| Entry revoked, then the node re-registers        | Stays `revoked`; re-registering never restores trust |
| Entry approved, then un-seeded                   | Stays `active`; the approval already happened        |
| A source stops reporting a discovered machine    | `stale`, not deleted, so a revocation is never lost  |

Reads and approvals need the session key. Registration is the one route that
does not, because a freshly provisioned node holds its own host key and none of
the master's credentials.

Replay is bounded: a registration's timestamp must be within 300 seconds
(epoch **seconds**, not milliseconds) and its nonce must not have been used
inside that window. The nonce is only recorded after the signature verifies, so
an unauthenticated caller cannot grow the nonce table. The nonce set is
process-local, so an ingress restart forgets it and a captured registration is
replayable for the remainder of its window.

A registration proves which machine is calling and nothing else, so a
re-registration may not rewrite what the entry points *at*: `credRef` is pinned
at first enrolment and ignored thereafter. Without that, a node holding only its
own host key could re-register naming another entry's reference and have the
proxy hand it that machine's session key. `host` stays updatable, because
re-announcing after an address change is the case this design exists for, and a
caller who can sign as a node already holds the credential on it.

The pending queue is capped (100 by default). Registration is unauthenticated
and every fresh keypair is a new fingerprint, so the cap is what stops anyone
who can reach the route from minting entries without limit. An already-listed
machine and a pre-seeded one are never refused, so a flood cannot lock out the
fleet it is trying to drown.

## Enrolment

`agent-canvas enrol` is the whole client. Any deployment method invokes it and
none of them need to know the payload shape, the signature scheme, or the
endpoint.

```bash
# Pre-seed step: print the fingerprint, no network involved
agent-canvas enrol --print-fingerprint

# After the installer's health check passes
agent-canvas enrol \
  --registry https://master.example.ts.net:8443 \
  --name hetzner \
  --host https://claude-hetzner.example.ts.net:8443 \
  --secret-provider op
```

It signs with `/etc/ssh/ssh_host_ed25519_key`, the key every Linux and macOS
host already has, so there is nothing to generate, distribute, or back up, and
the fingerprint an operator pre-seeds is the one `ssh-keygen -lf` already
prints. Re-running updates that fingerprint's entry; it never creates a second.

The node registers itself rather than the deploy script registering on its
behalf. Script-side registration is simpler and needs no keypair, but nothing
re-announces after a reboot, an address change, or a restore, so the registry
drifts from reality.

### The signed payload

```
POST /api/registry/register
body:   { name, host, pubkey, credRef, version, nonce, ts }
header: X-Registry-Signature: base64(ed25519(hostkey, canonical(body)))
```

`canonical(body)` is JSON over those fields in alphabetical order with
null and absent fields omitted. Signer and verifier import the same
`canonicalPayload()` function, so the wire format cannot drift between them.

## Credentials

A backend's session key never transits enrolment and never reaches a browser.
The provisioner writes it to a secret provider, the node registers a reference
such as `openhands/hetzner/session-key`, and the ingress resolves that
reference when proxying `/backend/<id>/*`.

| Provider | Backed by                                                             | Notes                                                                         |
| -------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `file`   | One 0600 file per reference under `~/.openhands/agent-canvas/secrets` | No dependency, no daemon; as confidential as the filesystem                   |
| `op`     | The installed `op` CLI                                                | Maps a reference to `op://<vault>/<item>/password`; must already be signed in |

The proxy authenticates its caller with the master's session key, the one the
canvas already holds for this origin, and answers `401` without it. That check
is not optional decoration: `/api/*` reaches an agent server that authenticates
for itself, whereas here the proxy satisfies the node's authentication on the
caller's behalf, so an unchecked caller is a caller handed the whole fleet. A
WebSocket handshake cannot set a header, so the key is also accepted as a
`session_api_key` query parameter.

What the browser sends is never what the node receives. Every channel a caller
credential can arrive in is stripped -- `X-Session-API-Key`, `Authorization`,
`Proxy-Authorization`, `Cookie`, `X-API-Key`, and the query parameter -- and the
entry's own credential is attached in its place. Cookies matter here because the
proxy shares an origin with the canvas, so the browser attaches them without
being asked.

The proxy fails closed. An unauthenticated caller is `401`, an unknown entry is
`404`, an entry that is not `active` is `403`, an entry with no credential
reference is `403`, and a credential the provider cannot resolve is `502`. None
of those fall back to proxying without a credential.

An entry with no `credRef` is refused rather than relayed to uncredentialed.
Discovered entries are that shape by construction, so a deployment that wants
them reachable has to say so with `--registry-allow-uncredentialed` and accept
what it means: the proxy will forward to those machines with no credential at
all, which on an agent server that does not authenticate makes `/backend/:id` an
open relay into whatever the source listed.

Where `tailscale whois` can name the caller, a configured policy decides
whether that caller may reach that entry. With no policy configured no identity
lookup runs at all, so the subprocess costs nothing on a deployment that has no
policy to apply.

## Identity to backend routing

The proxy is where a per-caller routing policy belongs. It receives the
resolved tailnet identity and the entry being requested, and returns whether
that pairing is allowed:

```js
createBackendProxy({
  store,
  secrets,
  proxy,
  authorize: ({ identity, entry }) =>
    identity?.user === "alice@example.com" || entry.name.startsWith("shared-"),
});
```

This is routing, not isolation. Two people routed to the same agent server
share it; isolation comes from giving them separate agent servers.

## Pull sources

Where a directory already knows which machines exist, the registry reads it
instead of waiting to be told.

| Source    | Reads                                                                                                                 | Identity                 |
| --------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| `k8s`     | Services labelled `app.kubernetes.io/name=agent-server` in the pod's namespace, through the in-cluster ServiceAccount | `k8s:<namespace>/<name>` |
| `tailnet` | Peers tagged `tag:openhands` in the local `tailscale status --json`                                                   | `tailnet:<node id>`      |

Both probe the unauthenticated `/server_info` for liveness and version, so
neither needs a credential to tell a live agent server from a dead address, and
both feed the same store as signed enrolment. A discovered machine lands
`active` without an approval step: membership of your own cluster or tailnet is
the authorisation. A machine a source stops reporting goes `stale`.

Probing is one unauthenticated GET per entry per cycle, so the probe interval
should scale with fleet size.

## Kubernetes

```bash
# The canvas plus the registry
helm install canvas helm/agent-canvas \
  --set registry.enabled=true \
  --set secrets.sessionApiKey.existingSecret=canvas-session-key \
  --set registry.sources.kubernetes.enabled=true

# A pool the canvas release discovers
helm install pool helm/agent-canvas \
  --set agentPool.enabled=true \
  --set agentPool.replicas=3
```

`registry.enabled` requires `secrets.sessionApiKey.existingSecret`: the
registry authenticates with the session key, and the entrypoint's
auto-generated key is not visible to the chart. Enabling Kubernetes discovery
creates a namespace-scoped Role for listing Services, independent of the
chart's broad `admin` binding, which stays off by default.

`agentPool.enabled` labels the release's Service so discovery finds it and
raises the replica count. Pool members run the same all-in-one image; they
simply serve a canvas nobody visits. Each member keeps its own PVC, because the
agent server's state is not shareable.

## What the browser does

`localStorage` is a cache, not the source of truth. On boot and on an interval
the canvas reads `/api/registry` and merges it into the backend list:

- Registry entries replace the previously hydrated set, so a revoked machine
  disappears.
- Manual entries survive untouched, including one pointing at the same host as
  a fleet entry: the manual entry carries a working credential and the fleet
  entry does not, so collapsing the two would remove a backend that works.
- When the registry cannot be reached the cached list stays on screen and
  Manage Backends says it is unverified.
- A deployment that serves no registry answers `404`, hydration stops polling,
  and everything behaves exactly as it did before.

A fleet entry's host is this origin's `/backend/<entry id>` rather than the
node's own address, so the browser never holds its key. A path prefix works as
a base URL because the SDK resolves request paths relative to it and the
websocket helpers carry the prefix through, the same shape as the existing
`/runtime/<port>` proxy deployments.

A fleet entry carries an empty `apiKey`, and that empty value is load-bearing:
`getAgentServerClientOptions()` resolves a host and its credential from the
same source, so a call that names its own host sends that host's key or none at
all. Resolving them separately would send the active backend's key to a host it
does not belong to — for a fleet entry, that would put the key that authorises
registry approvals on every proxied request.

## Operational notes

Proxy injection funnels all backend traffic through the master, which adds a
hop and makes that host a latency and availability path. Existing browsers keep
working off their cache when the master is down; a browser that has never seen
the fleet sees nothing until it is back.

The path requires reachability in both directions: the node reaches the master
to register, and the master reaches the node to probe and to proxy.

## Validating against real machines

Every other registry test in this repository uses a fake. The live rig runs the
whole loop against real agent servers, one of them on another host, enrolled
with that host's own SSH key:

```bash
node tests/e2e/live/fleet-registry/rig.mjs up      # stand it up and enrol both nodes
npm run test:e2e:fleet-registry                    # enrol -> pending -> approve -> proxy -> revoke
node tests/e2e/live/fleet-registry/rig.mjs down    # kill by recorded PID, drop secrets, clear entries
```

The rig is deliberately hermetic: random ports in 39000-39999, a state
directory under `$TMPDIR/fleet-rig-<ts>`, and `HOME` pointed inside it so the
`file` provider and `--generate-key` cannot reach a real `~/.openhands`. Every
process runs in its own tmux session and is stopped by the PID recorded at
launch. `rig.mjs status` prints what is still alive.

It expects the fleet as `up` leaves it (node 1 `active`, node 2 `pending`) and
says so if it finds anything else. Re-run `up` before re-running the spec: the
`pending` state cannot be restored through the API by design, since re-enrolment
never de-escalates trust.

Point it at your own machines with `FLEET_RIG_NODE1_SSH`,
`FLEET_RIG_NODE1_NAME`, `FLEET_RIG_NODE1_PORT` and `FLEET_RIG_MASTER_ADDRESS`.
The spec cannot run in ordinary CI, which is why it is not in `npm test` and
not in the default Playwright project.

### Reaching a node published by `tailscale serve`

`tailscale serve` terminates TLS on the MagicDNS name and rejects a connection
whose SNI does not match, so a node published that way cannot be reached by its
tailnet IP — the handshake fails before any certificate check, and disabling
verification does not help. The master must resolve the MagicDNS name.

Where it cannot (macOS clients where `tailscaled` installs a search domain but
no resolver for it are the common case), the fix is a resolver entry:

```bash
printf 'nameserver 100.100.100.100\n' | sudo tee /etc/resolver/ts.net
```

Where that is not available, forward the node's port instead and register the
forwarded address as the entry's host:

```bash
ssh -N -L 127.0.0.1:39165:127.0.0.1:8000 claude@100.125.222.64
```

The hop still runs over the tailnet; only name resolution moves. This is what
the live rig does, so it does not depend on the operator's DNS.
