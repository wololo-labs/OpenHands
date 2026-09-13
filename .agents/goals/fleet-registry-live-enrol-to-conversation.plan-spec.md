# Specification: Fleet Registry — Live Enrol to Conversation

**Generated from:** `.agents/goals/fleet-registry-live-enrol-to-conversation.plan.md`
**Interview date:** 2026-09-04
**Version:** 1.0

## Executive Summary

Phases 1 to 5 of the fleet registry are implemented and unit-tested but have
never run for real. This spec covers a single unattended run that stands up a
live two-machine rig, proves the enrol → pending → approve → conversation →
revoke loop against a real remote agent server, and then ships the branch to
`main` behind a hard merge gate.

## Objectives

### Primary Goals

- Prove the registry works against real machines, not fakes.
- Prove the security claim the design exists for: no fleet key in the browser.
- Prove trust can be withdrawn, not just granted.
- Land 33 files of working-tree-only work as reviewed history on `main`.

### Success Metrics

```
1  two nodes enrol -> preseed=active, unknown=pending
   -> approve -> real conversation through the proxy
2  no fleet key in the browser, AND a fresh browser
   context with empty storage shows the whole fleet
3  revoke node A -> 403 + gone, node B still works
```

| # | Criterion | Proven by |
|---|---|---|
| 1 | Both nodes enrol into one fleet: claude-hetzner is pre-seeded and lands `active`, the local second node is unknown and lands `pending` and non-selectable until approved; a real conversation then runs through `/backend/<id>`; re-running `enrol` on either node updates in place so the entry count stays 2 | Playwright spec + registry API responses |
| 2 | No storage value in the browser equals either node's session key, no browser request toward `/backend/<id>/*` carries `X-Session-API-Key`, the master's outbound request demonstrably does, and a fresh browser context with empty storage renders the full fleet with nothing pasted (FR-010) | Storage dump + network interception + `browser.newContext()` |
| 3 | Revoking one node returns `403` on its proxy path and removes it from the switcher, while the other node stays connectable and its own credential still resolves (per-entry isolation) | Proxy responses + Playwright assertion |

## Scope

### In Scope

- This repository only: `/Users/stevengonsalvez/.agents-in-a-box/worktrees/by-name/OpenHands--f-registry-phase1--7ecb84fb`
- Standing up a throwaway master stack (agent server + ingress + registry + proxy)
- Running `agent-canvas enrol` on claude-hetzner over SSH
- A second local throwaway agent server enrolled as node 2 with its own keypair
- A fresh-browser-context hydration proof (FR-010)
- A durable Playwright live spec committed to the repo
- Per-phase signed commits, PR, and merge to `main`

### Out of Scope

- `fleet-lambda` (`infra/openhands-backend/*`) — the installer flags are a different repo, not checked out here
- Provisioning any new host
- Reinstalling or reconfiguring anything on claude-hetzner
- The mac mini (`mac.tailfd6f5e.ts.net`) — offline at preflight, and a shared node whose reverse reachability is not guaranteed

### Future Considerations

- Installer integration (`--registry`, `--secret-provider`, `--preseed`) in fleet-lambda
- A shared-vault credential path once `op` CLI app integration is enabled
- Self-enrolment for shared tailnet nodes, where node → master may be blocked

## Technical Requirements

### Architecture

```
 ┌────────────────────────────────┐            ┌──────────────────────────────┐
 │ Stevens-MacBook-Pro-5  MASTER  │  tailnet   │ claude-hetzner        NODE   │
 │                                │            │                              │
 │  throwaway agent-server :RAND  │◀── enrol ──│  agent-server 1.44.0         │
 │  ingress + registry    :RAND   │            │  /etc/ssh/ssh_host_ed25519   │
 │  /backend/:id proxy            │─── proxy ─▶│  :8443 via tailscale serve   │
 │  file secret provider          │            │  node v22.23.0               │
 │  playwright + agent-browser    │            │                              │
 └────────────────────────────────┘            └──────────────────────────────┘
        state: $TMPDIR/fleet-rig-<ts>                  NOT reinstalled
        never touches ~/.openhands                     enrol only reads its key
        never signals 127.0.0.1:8000
              │
              │ second throwaway agent-server, own generated keypair
              ▼
        ┌──────────────────────────┐
        │ local-node-2   :RAND     │  NOT pre-seeded -> enrols `pending`
        └──────────────────────────┘
```

### Device roles

Probed live. Only two machines are reachable unattended, so the fleet's second
member is a local throwaway rather than a third box.

| Device | State | Role | Note |
| --- | --- | --- | --- |
| Stevens-MacBook-Pro-5 | online | master + browser + local node 2 | this machine |
| claude-hetzner | online | node 1, real remote agent server | pre-seeded, lands `active` |
| MB1412 (`100.98.203.32`) | online | none | SSH open but publickey denied |
| Mac / mac mini (shared) | offline | none | unreachable; also a shared node, so node-to-master may be one-way |
| iPhone 15, iPad153, Pixel 10 Pro, Pixel 3a | offline | none | 19-381 days offline |
| claude-contabo, claude-container | offline | none | 4d / 77d offline |

"A device that has never seen the fleet" is proven with a fresh Playwright
browser context (empty storage) rather than a physical second device, since no
second device is reachable unattended.

### Components

| Component | Purpose | Technology |
|---|---|---|
| Throwaway agent server | Registry storage via `misc_settings.fleet_backends` | `openhands-agent-server` 1.44.0 via uvx |
| Ingress + registry | Serves `/api/registry/*` and `/backend/:id/*` | `scripts/ingress.mjs`, Node 22 ESM |
| Secret provider | Resolves hetzner's key at proxy time | `scripts/registry/secrets/file.mjs` |
| Enrolment client | Signs and posts the registration | `bin/enrol.mjs` on hetzner |
| Live e2e spec | Durable, re-runnable proof | Playwright 1.62 |
| Debug driver | Eyes on the page when the spec fails | `agent-browser` skill |

### Integrations

- **claude-hetzner** (`100.125.222.64`): SSH `BatchMode=yes` as `claude`; agent server on `127.0.0.1:18000`, published `:8443`
- **Tailnet** (`tailae910a.ts.net`): MagicDNS lookup fails on the Mac, so requests use `--resolve` or the raw IP
- **1Password**: NOT used; `op` is installed but not signed in

### Performance Requirements

- Hard 3h wall-clock ceiling; report whatever is proven at the bound

### Security Requirements

| Requirement | Assertion |
|---|---|
| Browser holds no fleet key | Full `localStorage` + `sessionStorage` dump contains no substring equal to hetzner's session key |
| Browser sends no fleet key | No request to `/backend/<id>/*` carries `X-Session-API-Key` |
| Proxy does inject | Master's outbound request to hetzner does carry it, proving injection rather than absent auth |
| Revocation is real | `403` at the proxy after revoke |
| Live server untouched | `127.0.0.1:8000` never restarted, reconfigured or stopped |
| No blast-radius kills | Kill by recorded PID only; never `pkill node` |

## User Experience

### User Flows

```
 ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐
 │ start    │─▶│ enrol on │─▶│ canvas   │─▶│ approve  │─▶│ revoke   │
 │ master   │  │ hetzner  │  │ pending, │  │ + run a  │  │ + assert │
 │ stack    │  │ signed   │  │ greyed   │  │ convo    │  │ 403      │
 └──────────┘  └──────────┘  └──────────┘  └──────────┘  └──────────┘
                                                 │
                                                 ▼
                                    storage + network key assertions
```

### Edge Cases

| Scenario | Expected Behavior |
|---|---|
| hetzner goes offline mid-run | Rebuild the rig locally, finish every remaining assertion, mark cross-host claims UNPROVEN |
| MagicDNS fails to resolve hetzner | Use `--resolve` or the raw tailnet IP; do not treat as a failure |
| No LLM credential on hetzner | Degrade criterion 1 to an authenticated API round-trip through the proxy and mark the conversation claim PARTIAL |
| Registry entry already exists from a prior run | Re-enrol must update in place, never duplicate; assert entry count stays 2 |
| Both nodes present | Their fingerprints must differ, and the proxy must resolve each entry's own credential, never the other's |
| Revoking one node | The other stays `active` and connectable |
| Review finds a high or medium issue | Fix, re-run the gate; if unresolvable, do not merge and report why |
| 3h ceiling reached | Stop, tear down per the cleanup contract, report proven vs unproven |

## Constraints & Dependencies

### Technical Constraints

- Never restart, reconfigure or stop the live agent server on `127.0.0.1:8000`
- Never read or write `~/.openhands`; use `$TMPDIR/fleet-rig-<ts>/.openhands`
- Never reinstall or reconfigure claude-hetzner; `enrol` only reads its host key
- Random ports in `39000-39999`, recorded to a state file
- Long-running processes in tmux, never foreground, never bare `&`
- `/etc/ssh/ssh_host_ed25519_key` on the Mac needs sudo, so a local node uses `--key`
- The `file` secret provider is master-local, so hetzner enrols with `--cred-ref` only and the run places the key into the master's provider out of band

### External Dependencies

| Dependency | State at preflight |
|---|---|
| claude-hetzner SSH + agent server | reachable, `200` |
| Bidirectional tailnet reachability | verified both directions |
| `helm` | installed via brew this session |
| `op` CLI | installed, NOT signed in, unused |
| mac mini | offline, unusable |

### Timeline Constraints

- 3h hard ceiling, degrade rather than stall

## Risks & Mitigations

| Risk | Impact | Likelihood | Mitigation |
|---|---|---|---|
| Unattended merge lands a defect on `main` | High | Med | Hard gate: 3 criteria + full suite + code-reviewer with zero unresolved high/med |
| Throwaway server pollutes real state | High | Low | Isolated state dir, random ports, PID-tracked teardown |
| No LLM key on hetzner blocks the conversation | Med | Med | Degrade to authenticated round-trip, mark PARTIAL, do not stall |
| hetzner drops mid-run | Med | Low | Fall back to local rig, mark cross-host claims unproven |
| Playwright live spec is flaky in CI | Med | Med | Keep it out of the default `npm test` path; run it explicitly |
| Killing the wrong process | High | Low | Kill by recorded PID only; `pkill`/`killall` forbidden |

## Decisions Made

### Key Trade-offs

- **Decision:** MacBook master + claude-hetzner node, no new host.
  **Alternatives considered:** full installer deploy to a mac mini; pure-local rig.
  **Rationale:** the mac mini was offline and unreachable at preflight and its
  installer path needs a repo that is not checked out, so it would stall; a
  pure-local rig never proves the cross-machine hop or the real host key.

- **Decision:** Merge to `main` unattended, behind a hard gate.
  **Alternatives considered:** stop at a PR; stop at a report.
  **Rationale:** 33 files are working-tree-only and at risk; the gate, not a
  human pause, is what protects `main`.

- **Decision:** Playwright spec as the primary driver, `agent-browser` for debugging.
  **Alternatives considered:** ad-hoc `agent-browser` only.
  **Rationale:** the validation becomes a re-runnable repo artefact rather than
  a session transcript, while keeping eyes-on-page available when it fails.

- **Decision:** Out-of-band `--cred-ref` rather than a shared vault.
  **Alternatives considered:** `op` provider.
  **Rationale:** `op` is not signed in and waiting on that would block the run.

### Deferred Decisions

- Shared-vault credential path: deferred until `op` app integration is enabled.
- Installer flags in fleet-lambda: deferred, different repository.
- Whether the live spec joins CI: deferred; it needs a live host.

## Implementation Notes

### Priority Order

1. Stand up the isolated master stack, verify `/api/registry` returns `401` without a key
2. Enrol from hetzner with its fingerprint pre-seeded, assert it lands `active`
3. Start local node 2, enrol it un-seeded, assert it lands `pending`
4. Playwright: pending is visible and non-selectable; approve it
5. Run the conversation through `/backend/<id>` against hetzner
6. Storage and network key assertions, then fresh-context hydration (FR-010)
7. Re-enrol both, assert the entry count stays 2
8. Revoke one, assert `403` and disappearance, assert the other still works
7. Commit per phase, review, gate, merge

### Technical Debt Accepted

- The live spec needs a real remote host, so it cannot run in ordinary CI.
- Cross-host `--secret-provider file` remains a footgun; documented, not fixed.

## Open Questions

- [ ] None blocking. Behaviour on a missing LLM credential is defined as a degrade path rather than a question.

---

*This specification was generated through systematic interview of the plan author.*
