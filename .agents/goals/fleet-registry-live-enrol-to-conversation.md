# /goal A node enrols against a live registry, appears pending in the canvas, is approved, and serves a real conversation through the injecting proxy with no fleet key in the browser.

— CONTEXT —
· Project: Prove the OpenHands fork's fleet registry works against real machines rather than fakes. Phases 1-5 of `docs/fleet-registry-plan.md` are implemented on branch `f/registry-phase1`: a registry served in-process by the ingress at `/api/registry/*` with entries persisted to the agent server's `misc_settings.fleet_backends`; signed ed25519 self-enrolment with a pre-seed allowlist and a pending TOFU queue; canvas hydration that demotes `localStorage` to a cache; a credential-injecting proxy at `/backend/:id/*`; secret providers (`file`, `op`); Kubernetes and tailnet pull sources; and a Helm chart. Requirements are numbered FR-001..FR-024 in `specs/fleet-registry.md`, operator docs are `docs/registry.md`. This run stands up a live rig of two real machines plus a second local throwaway node, proves the enrol → pending → approve → conversation → revoke loop end to end across a two-entry fleet, then lands the work on `main` behind a hard gate.
· Stack: Node 22 ESM scripts (`scripts/registry/*`, `scripts/proxy-backend.mjs`, `bin/enrol.mjs`); React 19.2.8 + react-router 7.18.2 canvas built with Vite 8; `@openhands/typescript-client` 1.39.0 against `openhands-agent-server` 1.44.0 run via uvx; vitest 4.1.10 for unit tests and Playwright 1.62.1 for e2e; Helm chart in `helm/agent-canvas` (helm v4.2.4 installed); tailscale for the cross-host hop; the `agent-browser` skill for interactive browser debugging.
· Current state: All five phases are implemented and unit-tested but have NEVER run live. `npm test` = 5683 passed with one pre-existing unrelated flake (`__tests__/i18n/library-namespace.test.ts` times out at 30000ms under load and passes alone in 17.55s); `npm run typecheck`, `npm run lint`, `npm run build`, `helm lint` and `helm template` all exit 0. Nothing is committed: 0 commits ahead of `main`, 12 new files and 21 modified in the working tree. Every existing registry test uses fakes; no ingress has ever run with the registry enabled, no real node has enrolled, and no conversation has been driven through the injecting proxy in a browser. Preflight verified: claude-hetzner (`100.125.222.64`) is online with agent-server 1.44.0 on `127.0.0.1:18000` published at `:8443` by `tailscale serve`, SSH works with `BatchMode=yes` as `claude`, node v22.23.0 is present, MacBook→hetzner `:8443/server_info` returns 200 (needs `--resolve`, MagicDNS lookup fails on the Mac), and hetzner→MacBook `100.92.43.128` returns 200 so the enrolment direction works; the mac mini (`mac.tailfd6f5e.ts.net`) is OFFLINE and unreachable on ping, `:22` and `:8443`; `op` is installed 2.32.0 but NOT signed in; `/etc/ssh/ssh_host_ed25519_key` on the Mac needs sudo. DEVICE ROLES, probed live: Stevens-MacBook-Pro-5 is the master, the browser host and the home of local node 2; claude-hetzner is node 1, the real remote agent server, and is pre-seeded so it lands `active`; MB1412 (`100.98.203.32`) is online with `:22` open but SSH publickey auth is denied, so it is unusable unattended; the mac mini and every phone/tablet (iPhone 15, iPad153, Pixel 10 Pro, Pixel 3a) and claude-contabo/claude-container are offline. Only two machines are reachable unattended, which is why the fleet's second member is a local throwaway agent server with its own generated keypair rather than a third box, and why "a device that has never seen the fleet" is proven with a fresh Playwright browser context rather than a physical second device.
· Working dir: /Users/stevengonsalvez/.agents-in-a-box/worktrees/by-name/OpenHands--f-registry-phase1--7ecb84fb
· Constraints: NEVER restart, reconfigure or stop the live agent server on `127.0.0.1:8000`; NEVER read or write `~/.openhands` (use `$TMPDIR/fleet-rig-<ts>/.openhands`); NEVER reinstall or reconfigure claude-hetzner, `agent-canvas enrol` may only read its host key; this repository only, `fleet-lambda` (`infra/openhands-backend/*`) is out of scope and not checked out; no new host is provisioned and the mac mini is excluded; random ports in 39000-39999 recorded to a state file; long-running processes in tmux, never foreground, never bare `&`; kill by recorded PID only, `pkill`/`killall`/`tmux kill-server` are forbidden; the `file` secret provider is master-local so hetzner enrols with `--cred-ref` only and the run places the key into the master's provider out of band; 3h hard wall-clock ceiling; if hetzner drops, rebuild the rig locally, finish every remaining assertion and mark cross-host claims UNPROVEN rather than stalling; if no LLM credential is available on hetzner, degrade the conversation assertion to an authenticated API round-trip through the proxy and mark it PARTIAL; on PASS tear down (kill throwaway servers by PID, remove the secrets dir, revoke the test entry, clear `fleet_backends`), on FAIL leave the rig standing and write repro commands; MERGE GATE, all must hold or do not merge and report why: three criteria proven live with evidence, `npm test` + `typecheck` + `lint` + `build` green, `helm lint` + `helm template` green, a code-reviewer pass with zero unresolved high or medium findings, and signed single-concern commits; the rig must contain exactly two fleet entries: hetzner (fingerprint pre-seeded via `--registry-preseed`, expected `active`) and a second local throwaway agent server on its own random port enrolled with a generated key via `--generate-key` (NOT pre-seeded, expected `pending`); their fingerprints must differ and the proxy must resolve each entry's own credential, never the other's.
· Audience: Internal. Stevie and fleet operators running the Agent Canvas across several machines; there is no external end user for this run.

— SUCCESS CRITERIA (ALL MUST BE TRUE) —
1. Both nodes enrol into one fleet: claude-hetzner is pre-seeded and lands `active`, the local second node is not pre-seeded and lands `pending` and non-selectable in the canvas until approved; after approval a real conversation runs through `/backend/<id>`; re-running `enrol` on either node updates its entry in place so the fleet stays at exactly two entries.
2. No `localStorage` or `sessionStorage` value in the browser contains a substring equal to either node's real session key, no browser request toward `/backend/<id>/*` carries an `X-Session-API-Key` header, the master's outbound request to the node demonstrably does carry it (proving injection rather than absent auth), and a fresh browser context with empty storage renders the full fleet with nothing pasted (FR-010).
3. Revoking one node returns `403` on its `/backend/<id>/*` path and removes it from the canvas switcher, while the other node stays `active`, stays selectable, and its own credential still resolves correctly.
4. Final deliverable runs without errors
5. You can show proof (screenshot · test output · URL)

— OPERATING RULES — NON-NEGOTIABLE —
1. PLAN FIRST. Output a numbered task list before writing any code.
2. WORK AUTONOMOUSLY. Don't ask clarifying Qs unless genuinely blocked.
3. SELF-VERIFY. After every step: run tests, inspect output, confirm it worked.
4. DEBUG YOURSELF. If it fails, diagnose + fix. Don't hand it back.
5. USE EVERY TOOL. MCPs · terminal · web · code exec · pull real data.
6. NO PLACEHOLDERS. No TODOs · no stubs · real components + real states.
7. PROGRESS LOG. Track completed · in-flight · decisions · blockers.
8. STAY ON GOAL. Discoveries off-spec? Note + keep moving.
9. IF BLOCKED. Log the wall · continue everything parallelizable.
10. CHECK SUCCESS BEFORE STOPPING. Re-read criteria · confirm each is met.

— QUALITY BAR —
· Code: clean, typed, follows project conventions
· Design: looks like a well-funded startup shipped it
· Output: survives a senior code review
· Docs: every new pattern / env var / decision logged

— FINAL DELIVERABLE —
✅ Confirmation each criterion is satisfied
📂 Every file created / modified
🚀 How to run / test / deploy
📊 Proof (screenshot · test output · URL)
📝 Decisions made + anything to know
⚠️ Known limitations + follow-ups

Begin by outputting your plan. Then execute end-to-end without checking
in until done or genuinely blocked.
