# Resume brief: Phase 2 and Phase 3

Written at the end of the Phase 0 session so the next session continues rather than restarts.
Everything below was verified in-session unless a line says otherwise.

## Fixed facts this run depends on

| Thing | Value |
|---|---|
| Run nonce (published in issue #6) | `2adee20d08c4d4c5bf830a6b4c739f9b` |
| Phase 1 ticket | https://github.com/wololo-labs/OpenHands/issues/6 |
| Phase 0 PR | https://github.com/wololo-labs/OpenHands/pull/5 |
| Phase 0 issue | https://github.com/wololo-labs/OpenHands/issues/4 |
| Node | `claude-hetzner`, `claude@100.125.222.64`, SSH `BatchMode=yes` |
| Node SSH host-key fingerprint | `SHA256:zCJmiJ7wModXHdGhaB0xktp+IBjT0NsgiNJaQtiIMHw` |
| Node signing key fingerprint | `SHA256:H5ez7DvuU+IhNEzHK8eELNf5520yO+ZWGn/TR8gEQmE` |
| Node signing key (public) | `.agents/evidence/node-signing-key.pub` |
| Node agent-server unit | `openhands-backend.service` (a `systemctl --user` unit) |
| Node agent profile id | `41a04387-5149-4643-9bec-7a85a85bf82b` |
| Node workspace | `/home/claude/workspace/project` (created, empty) |
| Node session key | `~/.openhands/canvas-api-key` on the node |

Node git is already configured to sign: `gpg.format=ssh`,
`user.signingkey=/home/claude/.ssh/fleet-node-signing.pub`, `commit.gpgsign=true`,
identity `Steven Gonsalvez <steven.gonsalvez@gmail.com>`.

## Milestones

M0 is **met**: a real model turn ran on the node over ACP after a full unit restart, with no
per-run reconfiguration and no API key. Evidence in `phase0-preflight.md`, conversation
`6eb32a33-2591-4ac0-9414-0c2691eb1418`.

M1 through M8 are **not started**. M1 is "repo cloned on the node".

## How Phase 2 starts

1. Merge PR #5 first. The node's branch must fork from a `main` that contains the observer.
2. `node tests/e2e/live/fleet-registry/rig.mjs up`. It now writes `evidence/proxy-access.jsonl`
   and `evidence/tunnel-map.json` into its own rig dir and prints both paths in the summary.
   Note the rig dir; **do not** run `rig.mjs down` until every artefact is copied out and the
   chain verifier has passed, because teardown clears the secret store and `fleet_backends`.
3. Drive the canvas with Playwright, video on for the whole of Phase 2. Prompt only through the
   canvas. The master must not touch the repository during Phase 2.
4. The node's commits must carry both trailers:
   ```
   Fleet-Conversation: <conversation id>
   Fleet-Run: 2adee20d08c4d4c5bf830a6b4c739f9b
   ```
   Without them link 2 fails and the whole chain fails, so this has to be in the prompt.
5. Export events per milestone to `<evidence>/events/<conversation id>.json`, over HTTP through
   the proxy, because the WebSocket yields only one proxy line per session.

## How Phase 3 verifies

```
node scripts/verify-fleet-chain.mjs \
  --range origin/main..<pr head> \
  --signing-key .agents/evidence/node-signing-key.pub \
  --fingerprint SHA256:zCJmiJ7wModXHdGhaB0xktp+IBjT0NsgiNJaQtiIMHw \
  --run-nonce 2adee20d08c4d4c5bf830a6b4c739f9b \
  --proxy-log <rig.dir>/evidence/proxy-access.jsonl \
  --tunnel-map <rig.dir>/evidence/tunnel-map.json \
  --events-dir <evidence>/events
```

Merge with `--merge` or `--rebase`, never `--squash` (a squash commit is unsigned and
untrailered, and breaks the chain). No `--admin`, no bypass.

## Blocked, and why it is not a retry

**GitHub Actions has never run on this fork.** `GET /repos/wololo-labs/OpenHands/actions/runs`
reports `total_count: 0`; `gh pr checks 3`, on a PR that merged, reports "no checks reported".
All 20 workflows report `state: active` and `actions/permissions` reports `enabled: true`, so
nothing in the API explains it. Issues were also disabled (fork default) and were enabled during
this session.

Two success criteria depend on Actions and cannot be met until it is fixed:

- Criterion 1 requires the master to confirm that `issue-readiness-check.yml` applied
  `ready-for-dev` to the Phase 1 issue. It did not run. The label on #6 was applied **manually**
  and is recorded here as manual rather than presented as earned.
- Criterion 3's merge gate requires `gh pr checks <N>` with every check `pass` or `skipping`.
  With zero checks, `gh pr checks` reports none, which is neither.

This is a repository setting, not something a retry fixes. Enabling Actions for the fork is a UI
action on the operator's side.

## Second, smaller gap

The node's signing key is not registered on the GitHub account, so
`gh api repos/.../commits/<sha> --jq .commit.verification.verified` will report `false`.
Neither the master's nor the node's token holds `admin:ssh_signing_key`. This does not weaken
link 1, which verifies against the recorded public key directly, but it does mean the
cross-check named in criterion 2 cannot be run as written. One interactive command fixes it:

```
gh auth refresh -h github.com -s admin:ssh_signing_key
gh ssh-key add .agents/evidence/node-signing-key.pub --type signing --title "claude-hetzner fleet node"
```
