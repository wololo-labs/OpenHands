# `scripts/verify-fleet-chain.mjs`, run against a real cross-machine commit

The commit below was made **on `claude-hetzner`**, signed there with a key generated there whose
private half never left the machine, bundled, and carried to this Mac. The proxy log, tunnel map
and event export are in the shape the live rig and the milestone exports produce.

The trust anchor is `--signing-key-fingerprint`, published in issue #6 alongside the run nonce
before any work on that ticket existed. Without it the verifier would be checking a key the
machine running it had chosen, which proves only that four files that machine holds agree with
each other.

## Pass

```
PASS  ce12000d4284  chore: signing smoke
        ok   signature Good "git" signature for * with ED25519 key SHA256:H5ez7DvuU+IhNEzHK8eELNf5520yO+ZWGn/TR8gEQmE
        ok   trailers  conversation 6eb32a33-2591-4ac0-9414-0c2691eb1418
        ok   proxy     1 proxy line(s) before the commit
        ok   events    event e1 names it

CHAIN VERIFIED
EXIT=0
```

## Falsifier A: a key the master chose, rather than the published one

Only `--signing-key-fingerprint` changes. The verifier refuses to run at all, and exits 2 rather
than 1, so a wrapper can tell "could not check" from "chain is broken".

```
cannot verify: .agents/evidence/node-signing-key.pub is SHA256:H5ez7DvuU+IhNEzHK8eELNf5520yO+ZWGn/TR8gEQmE, not the published SHA256:aKeyTheMasterHolds
EXIT=2
```

## Falsifier B: a commit this Mac made itself, handed every piece of the node's evidence

The forged commit carries the node's real conversation id, the real run nonce, and is checked
against the node's real proxy log and real tunnel map. It still fails, on the two links a
dispatching machine cannot manufacture: it cannot produce the node's signature, and it cannot put
its own commit subject into the node's agent event stream after the fact.

```
FAIL  d3028de52471  chore: master forgery
        FAIL signature not signed by SHA256:H5ez7DvuU+IhNEzHK8eELNf5520yO+ZWGn/TR8gEQmE
        ok   trailers  conversation 6eb32a33-2591-4ac0-9414-0c2691eb1418
        ok   proxy     1 proxy line(s) before the commit
        FAIL events    no agent event names "chore: master forgery"

CHAIN BROKEN
EXIT=1
```

## Falsifier C: the same forgery, committed as `allhands-bot`

An earlier draft exempted commits whose author or committer name contained `allhands-bot`, on the
grounds that CI pushes them. Author and committer are attacker-chosen strings, so that exemption
was one environment variable away from exempting anything, in a script whose own header argues
that GitHub cannot distinguish two machines *because* identity is forgeable. Exemptions are now
named by sha on the command line, and an `--exempt` matching no commit fails the run rather than
being ignored.

```
FAIL  941ad71e5e62  chore: bot-named forgery
        FAIL signature not signed by SHA256:H5ez7DvuU+IhNEzHK8eELNf5520yO+ZWGn/TR8gEQmE
        ok   trailers  conversation 6eb32a33-2591-4ac0-9414-0c2691eb1418
        ok   proxy     1 proxy line(s) before the commit
        FAIL events    no agent event names "chore: bot-named forgery"

CHAIN BROKEN
EXIT=1
```

This is the test the whole harness rests on: the machine running the verifier cannot make it pass
for work that machine did itself, and cannot exempt that work either.

## Falsifier D, found by accident: the node signing with the shared key

Five days after Phase 0, re-running the pass case against a freshly signed commit on the node
produced this:

```
FAIL  f53bf02b7c79  chore: signing smoke
        FAIL signature not signed by SHA256:H5ez7DvuU+IhNEzHK8eELNf5520yO+ZWGn/TR8gEQmE (gpg: Signature made Sat 12 Sep 00:58:40 2026 BST)
        ok   trailers  conversation 6eb32a33-2591-4ac0-9414-0c2691eb1418
        ok   proxy     1 proxy line(s) before the commit
        ok   events    event e1 names it

CHAIN BROKEN
EXIT=1
```

The node's global git config had reverted to `gpg.format=openpgp` with
`user.signingkey=907EC78C72C6AFF6` — **the same OpenPGP key the master signs with**. The commit was
signed, and GitHub would have shown it verified, and it would have proved nothing at all: either
machine can produce that signature. This was not a planted test; something on the node rewrites
`~/.gitconfig`, and the cause has not been chased down.

Three links out of four still passed. The one that failed is the one that had to.

## Exit codes

A throw during verification, rather than during setup, used to exit 1 with a stack trace, which is
indistinguishable from "the chain is broken". An events export nested 9000 deep now reports:

```
cannot verify: Maximum call stack size exceeded
EXIT=2
```
