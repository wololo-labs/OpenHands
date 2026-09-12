# Goal: A node enrols against a live registry, appears pending in the canvas, is approved, and serves a real conversation through the injecting proxy with no fleet key in the browser.

This is a stub plan for an autonomous coding agent run. The final outcome —
what "done" looks like in one line — is stated above. Conduct an interview
to gather the remaining context the autonomous agent will need to execute
this end-to-end without supervision.

## Context fields the interview must produce

The autonomous run consumes these as its operating context. Each must be
explicit and specific.

- **Project** — what is being built (one paragraph product/feature summary)
- **Stack** — languages, frameworks, infrastructure (be specific; versions matter)
- **Current state** — what exists today; the starting point the agent inherits
- **Working dir** — absolute path or repo URL where work happens
- **Constraints** — budget, time, off-limits items, must-not-touch areas
- **Audience** — who this is for (end users · internal · both)

## Success criteria the interview must produce

The agent will check itself against three specific, measurable outcomes
before stopping. Surface all three.

- Success criterion 1 — a single specific measurable outcome
- Success criterion 2 — a single specific measurable outcome
- Success criterion 3 — a single specific measurable outcome

## Interview guidance

- Focus on the six context fields and the three success criteria above.
  Skip the broader `/interview` spec template categories that don't map to
  the mega-prompt — depth elsewhere is wasted.
- Be specific. "Make it fast" is not a success criterion; "p95 latency
  under 200ms for /search across 10k rows" is.
- The agent will run autonomously for hours. Every ambiguity costs hours
  of wasted work. Push back on vague answers.
- If the user offers a constraint, dig into the *why* — it usually
  changes the success criteria.

---

## ALREADY SETTLED — do not re-ask any of this

These were decided before the interview. Treat as fixed context.

### Outcome shape
Validate the live loop on existing infrastructure. No new host is provisioned.
Provisioning needs credentials an unattended run may not hold, and a stall
there defeats the purpose.

### Repository scope
This repository only. The `fleet-lambda` installer changes
(`infra/openhands-backend/install-openhands-backend.sh`,
`deploy-openhands-backend.sh`) are explicitly OUT of scope. That repo is not
even checked out on this machine. The enrolment CLI those scripts would call
already exists and works.

### Test rig — decided after a live preflight
```
 ┌──────────────────────────────┐            ┌────────────────────────────┐
 │ Stevens-MacBook-Pro-5        │  tailnet   │ claude-hetzner             │
 │ role: MASTER                 │            │ role: ENROLLING NODE       │
 │  - throwaway agent-server    │◀── enrol ──│  - agent-server 1.44.0     │
 │  - ingress + registry        │            │  - real /etc/ssh host key  │
 │  - /backend/:id proxy        │─── proxy ─▶│  - :8443 tailscale serve   │
 │  - headless browser          │            │  - node v22.23.0 present   │
 └──────────────────────────────┘            └────────────────────────────┘
```

Preflight results, verified by command:

| Check | Result |
| --- | --- |
| MacBook to hetzner `:8443/server_info` | `200` (needs `--resolve`, MagicDNS lookup fails on the Mac) |
| hetzner to MacBook tailscale IP `100.92.43.128` | `200`, so the enrolment direction works |
| hetzner SSH as `claude@100.125.222.64` | works, `BatchMode=yes`, no password |
| hetzner node version | `v22.23.0`, satisfies the package's `>=22.12.0` |
| hetzner agent server | `127.0.0.1:18000` internal, published on `:8443` by `tailscale serve` |
| mac mini (`mac.tailfd6f5e.ts.net`, a shared node) | OFFLINE, last seen 5h ago; ping, `:22` and `:8443` all unreachable |
| `mb1412-1` | online, `:22` open, no agent server on `:8000` or `:8443` |
| `op` CLI | installed 2.32.0 but NOT signed in |
| `/etc/ssh/ssh_host_ed25519_key` on the MacBook | not readable without sudo |

### Rejected options and why
- **Mac mini**: offline and unreachable at preflight. It is also a *shared*
  tailnet node, and sharing is frequently one-way, so the node-to-master
  direction that self-enrolment depends on may be blocked even when it is up.
  Worth a note in the final report as a real deployment constraint.
- **Full installer deploy**: needs the fleet-lambda repo, host credentials, and
  an installer change that is out of scope. Would stall.
- **Pure-local rig**: safe and fast but never proves the cross-machine hop, the
  real host key, or tailnet reachability.

### Credential path
The `file` secret provider is master-local, so `enrol --secret-provider file`
run on hetzner would write the secret on the wrong machine. Only a shared vault
works cross-host, and `op` is not signed in. So the run uses the supported
out-of-band path: hetzner enrols with `--cred-ref` only and its session key
never leaves it; the run separately places that key into the master's file
provider, which the ingress resolves with `--registry-secret-provider file`.

### Starting state
Phases 1 through 5 of `docs/fleet-registry-plan.md` are implemented on branch
`f/registry-phase1` and unit-tested: 5683 tests pass, `typecheck`, `lint`,
`build`, `helm lint` and `helm template` are all green. Nothing is committed
(0 commits ahead of `main`; 12 new files, 21 modified in the working tree).

What has never happened is any live exercise. No ingress has run with the
registry enabled, no real node has enrolled, and no conversation has been
driven through the injecting proxy in a browser. Every existing test uses
fakes.

---

## What the interview still needs to settle

Concentrate only on these. Everything above is fixed.

1. **Ports and process hygiene** — which ports the throwaway master stack may
   use, and how it guarantees it never disturbs the live agent server on
   `127.0.0.1:8000` or its key at `~/.openhands/canvas-api-key`.
2. **Browser automation** — which tooling drives the canvas headlessly, and
   what artefact counts as proof for each browser assertion.
3. **Proof of "no fleet key in the browser"** — the exact assertion, and where
   the evidence is written.
4. **Cleanup contract** — what the run must tear down on hetzner and locally,
   pass or fail, so a second run starts clean.
5. **Delivery scope** — whether committing, pushing, or opening a PR counts as
   part of "done", or whether the run stops at a green validation report.
6. **Bounds** — wall-clock and cost ceiling before the run stops and reports
   what it has, plus what it should do if hetzner goes offline mid-run.
7. **Audience** — confirm this is internal-only tooling for Stevie and fleet
   operators rather than an end-user-facing deliverable.
