#!/usr/bin/env bash
# Automation entrypoint: start one pipeline-phase conversation on a fleet node.
#
# Runs as bash inside the agent-server that sits beside the fleet master, which
# injects SESSION_API_KEY. That key authenticates to the master; the master
# swaps in the node's own key when it proxies /backend/<node>/*, so this script
# never holds a node credential.
#
# Everything site-specific arrives through config.env, which make-tarball.sh
# writes at build time. Nothing here names a host, a tenant or a token.
set -euo pipefail
cd "$(dirname "$0")"
# shellcheck disable=SC1091
. ./config.env

: "${NODE_ID:?}" "${REPO:?}" "${ISSUE:?}" "${WORKSPACE_DIR:?}" "${MC_SITE_URL:?}" "${SESSION_API_KEY:?}"
MASTER_URL=${MASTER_URL:-http://127.0.0.1:8010}
PHASE=${PHASE:-research}
RUN_ID=${AUTOMATION_RUN_ID:-manual-$(date +%s)}
NODE="$MASTER_URL/backend/$NODE_ID"
AUTH=(-H "X-Session-API-Key: $SESSION_API_KEY")

# A node whose agent-server has died keeps answering through its ingress, with
# a 502. Fail here, before anything is written anywhere.
code=$(curl -s -m 15 -o /dev/null -w '%{http_code}' "${AUTH[@]}" "$NODE/server_info" || true)
if [ "$code" != 200 ]; then
  echo "node $NODE_ID is not serving (server_info answered $code). Restart its agent-server, then dispatch again." >&2
  exit 1
fi

# The node's own active agent profile decides which agent runs. The profile is
# resolved on the node, so its credentials never cross the wire.
profile=$(curl -fsS -m 15 "${AUTH[@]}" "$NODE/api/settings" | jq -r '.active_agent_profile_id // empty')
[ -n "$profile" ] || { echo "node $NODE_ID has no active agent profile" >&2; exit 1; }

# Non-secret run context reaches the hook through its command line: hook
# processes inherit neither the conversation's secrets nor this environment.
hook=$(jq -rn --arg repo "$REPO" --arg issue "$ISSUE" --arg run "$RUN_ID" --arg mc "$MC_SITE_URL" --arg phase "$PHASE" \
  --arg from "${LABEL_FROM:-phase:$PHASE}" --arg to "${LABEL_TO:-phase:$PHASE-done}" \
  '"REPO=\($repo|@sh) ISSUE=\($issue|@sh) RUN_ID=\($run|@sh) MC_SITE_URL=\($mc|@sh) PHASE=\($phase|@sh) LABEL_FROM=\($from|@sh) LABEL_TO=\($to|@sh) bash automations/research-phase/tarball/hooks/phase.sh"')

request=$(jq -cn --arg profile "$profile" --arg dir "$WORKSPACE_DIR" --arg hook "$hook" --arg repo "$REPO" \
  --arg issue "$ISSUE" --arg run "$RUN_ID" --arg phase "$PHASE" --rawfile prompt "./$PHASE.md" '
  def on($timeout): [{matcher: "*", hooks: [{type: "command", command: $hook, timeout: $timeout}]}];
  {
    agent_profile_id: $profile,
    workspace: {working_dir: $dir},
    worktree: true,
    tags: {pipeline_phase: $phase, pipeline_run: $run, pipeline_issue: "\($repo)#\($issue)"},
    hook_config: {session_start: on(60), stop: on(120)},
    initial_message: {
      role: "user", run: true,
      content: [{type: "text", text: ($prompt | gsub("\\{\\{ISSUE\\}\\}"; $issue) | gsub("\\{\\{REPO\\}\\}"; $repo))}]
    }
  }')

response=$(curl -fsS -m 120 "${AUTH[@]}" -H 'content-type: application/json' -d "$request" "$NODE/api/conversations")
echo "run $RUN_ID started conversation $(jq -er .id <<<"$response") on node $NODE_ID"
