# The Phase 2 prompt, ready to paste into the canvas

One artefact, written while Phase 0 was under review, so Phase 2 starts by pasting rather than by
composing. Every value below is resolved; there is nothing to substitute.

Send it to `claude-hetzner` through the backend switcher, in a conversation launched from the
canvas. Do not SSH to the node to do any of this, and do not touch the repository from the Mac
while the node is working: the whole claim of the run is that the node did it.

## Before pasting

1. `node tests/e2e/live/fleet-registry/rig.mjs up`, and note the rig dir it prints.
2. Confirm the switcher shows `claude-hetzner` as `active`.
3. Start the Playwright video before the first prompt, not after.
4. Read the conversation id out of the URL once the conversation exists. The prompt needs it,
   because the node has to put it in every commit.

## The prompt

Replace `<CONVERSATION_ID>` with the id of the conversation you are typing into. That is the only
substitution, and it cannot be pre-filled because the id does not exist until the conversation does.

---

You are working on `wololo-labs/OpenHands` on this machine, `claude-hetzner`. Do all of it here.
Nobody is going to fix anything for you on another machine.

**The ticket:** https://github.com/wololo-labs/OpenHands/issues/6 — surface `stale` fleet entries in
the backend switcher and in Manage Backends. Read the issue first. Its Acceptance Criteria are the
definition of done; do not substitute your own.

**Setup**

```
mkdir -p ~/workspace/project && cd ~/workspace/project
gh repo clone wololo-labs/OpenHands . 2>/dev/null || git fetch origin
git checkout -b f/stale-entries-in-ui origin/main
npm ci
```

**Every commit must carry both of these trailers, exactly:**

```
Fleet-Conversation: <CONVERSATION_ID>
Fleet-Run: 2adee20d08c4d4c5bf830a6b4c739f9b
```

A commit without them is not attributable to this run and fails the harness even if the code is
perfect. Commits are signed automatically; git on this machine is already configured for it. Do not
pass `--no-gpg-sign`, and do not change the signing configuration.

**What you may touch**

`src/components/features/backends/**`, `src/api/backend-registry/**`, `src/i18n/translation.json`,
`__tests__/**`, and `docs/registry.md`. Nothing else. In particular **do not edit
`specs/fleet-registry.md`** — FR-023 there is the acceptance criterion for this work and editing it
redefines "done" retroactively. Do not touch `scripts/**`, `.github/**`, `AGENTS.md`, `.agents/**`,
`package.json`, or any config file.

**How to work**

- `git add` by named path. Never `git add -A` and never `git add .`.
- Run `npm run typecheck` and the relevant tests before each commit, and fix what you break. A red
  suite that you diagnose and fix is the expected shape of this work, not a failure.
- Drive the `stale` state through `registry-source`/`storage` from a registry payload containing
  `state: "stale"`. A test that passes a component a `stale` prop proves nothing about whether a
  real registry response reaches the UI.
- Look at how `pending` is handled first. FR-012 already establishes the shape: listed, but refuses
  selection. `stale` needs the equivalent, plus a label naming the reason.
- Before every push, `git diff origin/main...HEAD | grep -nE 'gho_|ghp_|sk-'` and stop if it hits.
- `git push --force-with-lease` only if you must, and at most twice.

**Finishing**

Open exactly one PR against `main`, titled in Conventional Commits form, with `- [x] Feature` ticked
under `## Type` and `Fixes #6` under `## Issue Number`. Fill in `## Why`, `## Summary` and
`## How to Test` properly — a reviewer has to be able to run it. Put a terminal capture of the test
run under `## Video/Screenshots`.

Then stop and say the PR number. Review findings will come back to you in this conversation; fix
them here, on this machine, and push to the same branch.

---

## After the node opens the PR

Fenced-path check, which must come back empty:

```
git diff --name-only origin/main...<pr head> | grep -E \
  '^(scripts/|\.github/|AGENTS\.md|\.agents/|package\.json|vitest\.config|eslint\.config|playwright.*\.config|specs/fleet-registry\.md)'
```

Secret grep across the whole diff, which must also come back empty:

```
git diff origin/main...<pr head> | grep -nE 'gho_|ghp_|sk-'
```

Then the chain, with the anchor from issue #6:

```
node scripts/verify-fleet-chain.mjs \
  --range origin/main..<pr head> \
  --signing-key .agents/evidence/node-signing-key.pub \
  --signing-key-fingerprint SHA256:H5ez7DvuU+IhNEzHK8eELNf5520yO+ZWGn/TR8gEQmE \
  --fingerprint SHA256:zCJmiJ7wModXHdGhaB0xktp+IBjT0NsgiNJaQtiIMHw \
  --run-nonce 2adee20d08c4d4c5bf830a6b4c739f9b \
  --proxy-log <rig.dir>/evidence/proxy-access.jsonl \
  --tunnel-map <rig.dir>/evidence/tunnel-map.json \
  --events-dir <rig.dir>/evidence/events
```

Merge with `--merge` or `--rebase`. Never `--squash`: a squash commit is unsigned and untrailered,
so merging that way destroys the chain the run exists to produce.
