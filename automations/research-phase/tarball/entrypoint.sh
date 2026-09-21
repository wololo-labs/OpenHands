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
# Receipts are gapless per run id, so a fallback id must not collide.
RUN_ID=${AUTOMATION_RUN_ID:-manual-$(date +%s)-$RANDOM}
NODE="$MASTER_URL/backend/$NODE_ID"
# Credentials go to curl through a config file descriptor, never argv, so they
# do not show up in the process list.
master() { curl -K <(printf 'header = "X-Session-API-Key: %s"\n' "$SESSION_API_KEY") "$@"; }

# The automation service leaves a run RUNNING until the entrypoint reports its
# own outcome, so report it on every exit path. Best effort: a failed callback
# must not mask the real exit code.
CONVERSATION_ID=
report_outcome() {
  local status=$? key=${AUTOMATION_CALLBACK_API_KEY:-$SESSION_API_KEY} body code
  [ -n "${AUTOMATION_CALLBACK_URL:-}" ] || return 0
  # The key only ever goes to this machine or to the master's own host.
  local host=${AUTOMATION_CALLBACK_URL#*://} master_host=${MASTER_URL#*://}
  host=${host%%[:/]*} master_host=${master_host%%[:/]*}
  case "$host" in
    127.0.0.1 | localhost | "$master_host") ;;
    *) echo "not reporting the outcome: callback host $host is neither local nor the master" >&2; return 0 ;;
  esac
  body=$(jq -cn --arg run "$RUN_ID" --arg conversation "$CONVERSATION_ID" --argjson code "$status" \
    '{status: (if $code == 0 then "COMPLETED" else "FAILED" end), run_id: $run}
     + (if $conversation == "" then {} else {conversation_id: $conversation} end)
     + (if $code == 0 then {} else {error: "entrypoint exited \($code)"} end)')
  code=$(curl -s -m 10 -o /dev/null -w '%{http_code}' \
    -K <(printf 'header = "Authorization: Bearer %s"\nheader = "X-Session-API-Key: %s"\n' "$key" "$key") \
    -H 'content-type: application/json' -d "$body" "$AUTOMATION_CALLBACK_URL" || true)
  case "$code" in 2*) ;; *) echo "outcome callback answered ${code:-nothing}: the run may sit RUNNING until it times out" >&2 ;; esac
  return 0
}
trap report_outcome EXIT

# A node whose agent-server has died keeps answering through its ingress, with
# a 502. Fail here, before anything is written anywhere.
code=$(master -s -m 15 -o /dev/null -w '%{http_code}' "$NODE/server_info" || true)
if [ "$code" != 200 ]; then
  echo "node $NODE_ID is not serving (server_info answered $code). Restart its agent-server, then dispatch again." >&2
  exit 1
fi

# The node's own active agent profile decides which agent runs. The profile is
# resolved on the node, so its credentials never cross the wire.
profile=$(master -fsS -m 15 "$NODE/api/settings" | jq -r '.active_agent_profile_id // empty')
[ -n "$profile" ] || { echo "node $NODE_ID has no active agent profile" >&2; exit 1; }

# Non-secret run context reaches the hook through its command line: hook
# processes inherit neither the conversation's secrets nor this environment.
# The script is addressed under the node user's home, never relative to the
# conversation's working directory, which the agent can write to.
hook=$(jq -rn --arg repo "$REPO" --arg issue "$ISSUE" --arg run "$RUN_ID" --arg mc "$MC_SITE_URL" --arg phase "$PHASE" \
  --arg from "${LABEL_FROM:-phase:$PHASE}" --arg to "${LABEL_TO:-phase:$PHASE-done}" \
  --arg path "${HOOK_PATH:-.local/libexec/oh-pipeline/phase.sh}" \
  '"REPO=\($repo|@sh) ISSUE=\($issue|@sh) RUN_ID=\($run|@sh) MC_SITE_URL=\($mc|@sh) PHASE=\($phase|@sh) LABEL_FROM=\($from|@sh) LABEL_TO=\($to|@sh) bash \"$HOME\"/\($path|@sh)"')

request=$(jq -cn --arg profile "$profile" --arg dir "$WORKSPACE_DIR" --arg hook "$hook" --arg repo "$REPO" \
  --arg issue "$ISSUE" --arg run "$RUN_ID" --arg phase "$PHASE" --rawfile prompt "./$PHASE.md" '
  def on($timeout): [{matcher: "*", hooks: [{type: "command", command: $hook, timeout: $timeout}]}];
  {
    agent_profile_id: $profile,
    workspace: {working_dir: $dir},
    worktree: true,
    # Tag keys must be lowercase alphanumeric or the agent-server answers 422.
    tags: {pipelinephase: $phase, pipelinerun: $run, pipelineissue: "\($repo)#\($issue)"},
    hook_config: {session_start: on(180), stop: on(180)},
    initial_message: {
      role: "user", run: true,
      content: [{type: "text", text: ($prompt | gsub("\\{\\{ISSUE\\}\\}"; $issue) | gsub("\\{\\{REPO\\}\\}"; $repo))}]
    }
  }')

# Keep the body on a refusal: the agent-server's 422 names the offending field,
# and curl -f would throw that away.
response=$(master -sS -m 120 -w '\n%{http_code}' -H 'content-type: application/json' -d "$request" "$NODE/api/conversations")
status=${response##*$'\n'}
response=${response%$'\n'*}
case "$status" in
  2*) ;;
  *) echo "node $NODE_ID refused the conversation ($status): ${response:0:1000}" >&2; exit 1 ;;
esac
CONVERSATION_ID=$(jq -r '.id // empty' <<<"$response" 2>/dev/null || true)
[ -n "$CONVERSATION_ID" ] || echo "the node accepted the conversation but its answer had no id: ${response:0:300}" >&2
echo "run $RUN_ID started conversation $CONVERSATION_ID on node $NODE_ID"
