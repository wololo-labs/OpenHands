# Phase 0 pre-flight: claude-hetzner

Recorded 2026-09-07 by the master, before any Phase 1 or Phase 2 work.

| Check | Value | Verdict |
|---|---|---|
| host | `claude-hetzner` (`100.125.222.64`), SSH `claude@` BatchMode | reachable |
| disk | `/` 150G, 18G free | pass (>= 10G) |
| node | v22.23.0 | pass |
| `gh auth status` | `stevengonsalvez`, scopes `admin:org, gist, project, repo, workflow` | pass (`repo`, `workflow`) |
| workspace | `/home/claude/workspace/project` created | pass |
| agent-server unit | **`openhands-backend.service`**, a `systemctl --user` unit | recorded |
| agent server | `127.0.0.1:18000`, published `:8443` | pass |
| SSH host key fingerprint | `SHA256:zCJmiJ7wModXHdGhaB0xktp+IBjT0NsgiNJaQtiIMHw` | recorded |
| node signing key | `SHA256:H5ez7DvuU+IhNEzHK8eELNf5520yO+ZWGn/TR8gEQmE`, generated on the node, private half never left it | `node-signing-key.pub` |

## ACP permanence (criterion 3)

Before: `permissions.defaultMode` was **`"auto"`** in `/home/claude/.claude/settings.json`, the exact value
that fails with `ACPInitError: [-32603] Invalid permissions.defaultMode: auto`. Backed up to
`~/.claude/settings.json.pre-fleet-acp.bak`, then set to `"bypassPermissions"`.

Agent settings PATCHed as `{"agent_settings_diff":{...}}` (a top-level `agent_settings` is rejected 400).
Previous settings backed up to `~/.openhands/settings.pre-fleet-acp.bak.json`.

`openhands-backend.service` was then **restarted**, and after the restart, with no reconfiguration:

```
{'agent_kind': 'acp', 'acp_server': 'claude-code', 'acp_model': 'opus[1m]',
 'acp_command': ['/home/claude/.local/bin/claude']}
```

A conversation launched with `agent_profile_id=41a04387-5149-4643-9bec-7a85a85bf82b` and
`workspace={"kind":"LocalWorkspace","working_dir":"/home/claude/workspace/project"}` produced,
in `6eb32a33-2591-4ac0-9414-0c2691eb1418`:

| Event | Source | Meaning |
|---|---|---|
| `SystemPromptEvent` | `agent` | ACP initialised, not merely configured |
| `ACPToolCallEvent` `ToolSearch` | `agent` | model selected a tool |
| `ACPToolCallEvent` `hostname && whoami && pwd` (`completed`) | `agent` | real command run on the node |
| `ActionEvent` `FinishAction` `ACP-PERMANENCE-OK` | `agent` | turn completed |

`persistence_dir` is `/home/claude/.openhands/agent-canvas/dev_conversations/6eb32a3325914ac094140c2691eb1418`,
model `opus[1m]`, 64080 cache-read and 202 completion tokens: a real model turn, no API key. **M0 met.**

## Corrections to the goal's recorded assumptions

1. `workspace.kind` must be **`"LocalWorkspace"`**, not `"local"`; `"local"` is rejected 422 with
   `assertion_error` on `body.workspace`.
2. The conversation's resolved agent uses `acp_command: ["claude-agent-acp"]`, taken from the **agent
   profile**, which overrides the settings-level `acp_command` this run persisted. It resolves to
   `/home/claude/.npm-global/bin/claude-agent-acp`.
3. That resolution is restart-proof for a reason the goal did not have: `openhands-backend.service`
   pins `Environment=PATH=...:/home/claude/.npm-global/bin:/home/claude/.local/bin:...` in the unit
   itself, so it does not depend on an interactive shell's PATH. `claude-agent-acp` is in fact NOT on
   the login PATH (`bash -lc 'command -v claude-agent-acp'` fails), and the run still works across a
   restart.
4. `LLMBadRequestError: LLM Provider NOT provided ... model=opus[1m]` appeared as a
   `ConversationErrorEvent` in this **successful** run, confirming the goal's warning: it is the
   title-generation call and is not a failure.

## Known gap

`gh api user/ssh_signing_keys` needs the `admin:ssh_signing_key` scope, which neither the master's nor
the node's token holds. The node's signing key is therefore not registered on the GitHub account, so
`gh api repos/.../commits/<sha> --jq .commit.verification.verified` will report `false` for the node's
commits. This does not weaken link 1: `scripts/verify-fleet-chain.mjs` verifies the signature directly
against `node-signing-key.pub` in a throwaway allowed-signers file, which is the stronger check (it
proves the key, where GitHub's flag only proves the key is registered to the account). Registering it
needs one interactive command from the operator:

```
gh auth refresh -h github.com -s admin:ssh_signing_key
gh ssh-key add .agents/evidence/node-signing-key.pub --type signing --title "claude-hetzner fleet node"
```
