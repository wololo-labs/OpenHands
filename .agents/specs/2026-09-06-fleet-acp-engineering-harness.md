# Spec: Prove the fleet is an ACP engineering orchestration harness

**Generated from:** `.agents/specs/2026-09-06-fleet-acp-engineering-harness-stub.md`
**Date:** 2026-09-06
**Format:** diagram-first, table-second, no prose paragraphs

## Problem

| Question | Answer |
|----------|--------|
| What? | A fleet node running Claude via ACP takes a real GitHub issue and finishes it, reached only through the Agent Canvas and the credential-injecting proxy |
| Why? | The registry is proven as a pipe (15/15 live, PRs #1-#3). The only model turn ever run on a node emitted `FLEET-PROOF-OK` and stopped. Nothing shows a node doing a day's engineering |
| Who? | Stevie and fleet operators; internal, no external end user |

## Users + use cases

| Persona | Goal | Primary use case |
|---------|------|------------------|
| Stevie (operator) | Send work to a machine that is not this one | Pick hetzner in the switcher, paste a ticket, walk away |
| Stevie (sceptic) | Know the node did it, not the master | Replay all three recordings and check they agree |
| Fleet node (hetzner) | Execute a ticket end to end | clone, read, edit, test, commit, push, open PR |
| Orchestrator (master) | Gate the result | code-reviewer pass, CI, merge |

## Approach

| Option | Summary | Tradeoff | Picked? |
|--------|---------|----------|---------|
| A | Self-hosting ticket, pre-specified acceptance criteria | Self-referential repo, but "done" is not a judgement call | ✓ |
| B | Seeded bug, fault injected | Synthetic; a sceptic says the fix was pre-scripted | |
| C | Multi-node split, implement + review | 2 ACP configs, more failure modes, orchestration is not the claim | |

**Why A:** the acceptance criteria were written into `specs/fleet-registry.md` before this idea existed.

### The ticket

The single item under `## Deferred` is one the record argues **against** building
("a breaker that trips on a blip refuses enrolment to real nodes"). It is rejected
as a ticket. Three genuine gaps were found instead; the picked one is `stale`.

| Candidate | Gap | Picked? |
|---|---|---|
| `stale` in the UI | `"stale"` appears in `types.ts`, `storage.ts`, `registry-source.ts`, `mocks/` and in **no component**. A node a pull source stopped reporting renders as healthy and is selectable. FR-023 already defines the server semantics | ✓ |
| `source` badge | `enrolment` / `k8s` / `tailnet` never surfaced; rows show only registry-vs-manual | |
| Proxy access logging | Bigger and needed as the evidence layer, so it cannot be the ticket without a chicken-and-egg | moved to Phase 0 |

## Architecture

```
PHASE 0  master builds the observer, before it observes
┌────────────────┐   PR   ┌──────────────┐
│ proxy access   │───────▶│ merged first │
│ logging        │        │ reviewed     │
└────────────────┘        └──────────────┘

PHASE 1-2  the run
┌──────────────┐  prompt  ┌───────────────┐  /backend/<id> ┌──────────────┐
│ gh issue #N  │─────────▶│ Canvas        │───────────────▶│ hetzner ACP  │
│ stale in UI  │          │ switcher      │  key injected  │ claude-code  │
└──────────────┘          └───────┬───────┘                └──────┬───────┘
                                  │                               │
              ┌───────────────────┼───────────────────┐    clone,edit,test,
              ▼                   ▼                   ▼    commit,push,PR
        ┌───────────┐      ┌────────────┐      ┌───────────┐     │
        │ video +   │      │ node event │      │ proxy     │     ▼
        │ trace     │      │ stream     │      │ access log│  ┌────────┐
        └───────────┘      └────────────┘      └───────────┘  │ PR #M  │
              └───────── must all agree ───────────┘          └────────┘

PHASE 3  master reviews, merges
```

| Component | Purpose | Owns |
|-----------|---------|------|
| Canvas switcher | The only way work reaches the node | prompt entry, backend selection |
| `/backend/:id` proxy | Injects the node's credential, records the wire | access log, credential resolution |
| hetzner (ACP) | Does the engineering | clone, edit, test, commit, push, PR |
| Playwright | Drives the browser and records it | video.webm, trace.zip |
| code-reviewer | Gates the node's PR | findings, merge verdict |

## Data model

```
┌──────────────┐        ┌───────────────────┐        ┌──────────────┐
│ proxy entry  │ 1:N ──▶│ conversation      │ 1:N ──▶│ event        │
│ ts, method,  │        │ id, node id       │        │ id, kind,    │
│ path, entryId│        │                   │        │ payload      │
└──────────────┘        └─────────┬─────────┘        └──────┬───────┘
                                  │ 1:N                     │
                                  ▼                         │
                            ┌──────────┐                    │
                            │ commit   │◀───────────────────┘
                            │ sha      │   every commit traces back
                            └──────────┘
```

| Entity | Fields (key only) | Relationships |
|--------|-------------------|---------------|
| proxy entry | ts, method, path, entryId, credential injected | 1:N to conversation |
| conversation | id, node id | 1:N to event |
| event | id, kind, payload | N:1 to conversation |
| commit | sha, message | traced to event id |

## Interface

```
$ # PHASE 0 artefact: the proxy access log
$ tail -f ~/.openhands/agent-canvas/proxy-access.log
2026-09-06T10:01:02Z GET   /backend/abc123/api/settings      entry=hetzner cred=injected
2026-09-06T10:01:04Z POST  /backend/abc123/api/conversations entry=hetzner cred=injected
2026-09-06T10:01:09Z GET   /backend/abc123/api/conversations/c-77/events entry=hetzner
```

```
UI the ticket asks for, Manage Backends row
┌────────────────────────────────────────────────────────────┐
│ ● hetzner                                        [LOCAL]   │
│   https://.../backend/abc123                               │
│   From the fleet registry                                  │
│   Stale: not seen by tailnet source since 10:04    <- NEW  │
│                                          [approve][revoke] │
└────────────────────────────────────────────────────────────┘
```

| Surface | Trigger | Shape |
|---------|---------|-------|
| Canvas switcher | operator picks hetzner | dropdown option, stale not silently selectable |
| Manage Backends row | entry state is `stale` | state label plus reason |
| Proxy access log | any `/backend/:id/*` request | append-only line |
| `gh pr create` | node finishes the ticket | PR against `wololo-labs/OpenHands` |

## Behavior

Happy path:

```
[issue filed] ──prompt via canvas──▶ [node working] ──tests green──▶ [PR open]
                                            │                            │
                                            │                     review clean
                                            ▼                            ▼
                                     [self-corrects]              [merged] = PASS
```

Edge cases:

| Scenario | Trigger | Expected behavior |
|----------|---------|-------------------|
| Node drops mid-ticket | hetzner unreachable | Retry same node, bounded. Still down: STOP and report partial. NEVER move work to the master |
| Tests fail on the node | node's own run is red | Node diagnoses and fixes; that loop is the point, not a failure |
| Review finds high or medium | code-reviewer on the PR | Send back to the **node** to fix, not the master |
| A commit has no event id | attribution chain broken | Harness FAILED, even with a green PR |
| ACP fails at init | `permissions.defaultMode: "auto"` in the node's `/home/claude/.claude/settings.json` | Set `bypassPermissions`, or scope it with `acp_session_mode`. Config alone proves nothing: verify with agent-sourced `SystemPromptEvent` plus `ActionEvent`, never with `LLMBadRequestError`, which appears in successful runs too |
| 4h cap reached | wall clock | Stop, report what is proven and what is not |

## Errors

| Failure mode | User-visible surface | Recovery |
|--------------|----------------------|----------|
| Node unreachable | Run log plus final report | Bounded retry on the same node, then stop |
| ACP not configured | Model call fails on the node | Phase 0 makes ACP permanent; fail loudly if it regresses |
| Proxy log missing entries | Cross-check fails | Harness FAILED; do not paper over |
| Node `gh` auth expired | `gh pr create` fails | Report blocked; the master must NOT push on its behalf |
| Video artefact too large | Disk | Retain video regardless; trace may be trimmed |

## Testing strategy

| Layer | Scope | Coverage gate |
|-------|-------|---------------|
| E2E | The whole run, browser-driven, recorded three ways | All three records agree; every commit traces to an event and a proxy entry |
| Integration | Proxy access logging writes one line per proxied request | Must-pass before Phase 1 |
| Unit | `stale` rendering in switcher and Manage Backends | Must-pass; this is the node's own ticket |

## Out of scope

- `fleet-lambda` installer changes (different repository, not checked out)
- The mac mini and every other device (offline or refusing SSH)
- Multi-node orchestration; one node does this ticket
- Building the deferred registration-metering breaker; the record argues against it
- Any master edit to the repository during Phase 2

## Decisions locked

| Decision | Choice |
|---|---|
| Ticket source | Real gap with pre-written acceptance criteria: surface `stale` in the UI |
| ACP on hetzner | **Permanent**, not flipped per run; the node becomes a real fleet member |
| Recording | Three layers: browser video plus trace, node event stream, proxy access log |
| Falsifier | Any hop not traceable through the proxy to a node event |
| Node vs master | Node does clone through PR. Master prompts, reviews, merges. Master must not touch the repo |
| Merge authority | Master reviews and merges unattended on zero high or medium plus green CI |
| Review findings | Sent back to the node to fix, not fixed by the master |
| Bounds | 4h cap; on node loss retry the same node then stop; never silently switch |
| Prerequisite | Proxy access logging built and merged by the master first |

## Open questions for /plan

- [ ] Where the proxy access log is written, and whether it rotates
- [ ] How a commit is tied to an event id in practice: trailer, branch name, or commit-time correlation
- [ ] Whether ACP permanence on hetzner needs a systemd unit change or only agent settings
- [ ] Whether the node needs its own `~/workspace` provisioned before Phase 2
