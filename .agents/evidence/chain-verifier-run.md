# `scripts/verify-fleet-chain.mjs`, run against a real cross-machine commit

The commit below was made **on `claude-hetzner`**, signed there with a key generated there whose
private half never left the machine, bundled, and carried to this Mac. The proxy log, tunnel map
and event export are in the shape the live rig and the milestone exports produce.

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

## Falsifier A: the same commit, attributed to a different machine

Only `--fingerprint` changes.

```
FAIL  ce12000d4284  chore: signing smoke
        ok   signature Good "git" signature for * with ED25519 key SHA256:H5ez7DvuU+IhNEzHK8eELNf5520yO+ZWGn/TR8gEQmE
        ok   trailers  conversation 6eb32a33-2591-4ac0-9414-0c2691eb1418
        FAIL proxy     6eb32a33-2591-4ac0-9414-0c2691eb1418 was proxied, but never to SHA256:some-other-machine
        ok   events    event e1 names it

CHAIN BROKEN
EXIT=1
```

## Falsifier B: a commit this Mac made itself, handed every piece of the node's evidence

The forged commit carries the node's real conversation id, the real run nonce, and is checked
against the node's real proxy log and real tunnel map. It still fails, on the two links the
dispatching machine cannot manufacture: it cannot produce the node's signature, and it cannot put
its own commit subject into the node's event stream after the fact.

```
FAIL  d3028de52471  chore: master forgery
        FAIL signature no signature
        ok   trailers  conversation 6eb32a33-2591-4ac0-9414-0c2691eb1418
        ok   proxy     1 proxy line(s) before the commit
        FAIL events    no event names "chore: master forgery"

CHAIN BROKEN
EXIT=1
```

This is the test the whole harness rests on: the machine running the verifier cannot make it pass
for work that machine did itself.
