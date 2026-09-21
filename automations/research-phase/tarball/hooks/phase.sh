#!/usr/bin/env bash
# Conversation hook for one pipeline phase. Registered for SessionStart and Stop.
#
#   SessionStart  resolve the work unit for the issue, open the phase span,
#                 append receipt 1
#   Stop          close the span from .agents/phase-result.json, append
#                 receipt 2, then comment on the issue and swap the label
#
# Mission-control is written before GitHub and any failure there exits before
# GitHub is touched, so GitHub is never ahead of the system of record.
#
# Exit codes: the agent-server treats 2 as "block the agent". This script never
# exits 2, so a reporting failure cannot hold a conversation open.
#
# Hook processes do not receive conversation secrets, so the two tokens are
# read from owner-only files on the node.
#
# Install this script on the node OUTSIDE any conversation workspace and point
# the hook command at that absolute path. A hook resolved inside the worktree is
# a file the agent can edit with a single tool call.
#
# Known limit: the agent runs as the same unix user as this hook, so it can
# still read the token files and the state directory. Closing that needs the
# hook to run as another user, or the writes to move behind a broker.
set -euo pipefail

: "${REPO:?}" "${ISSUE:?}" "${RUN_ID:?}" "${MC_SITE_URL:?}"
: "${OPENHANDS_EVENT_TYPE:?}" "${OPENHANDS_SESSION_ID:?}"
PHASE=${PHASE:-research}
STEP_ID=${STEP_ID:-flow-default:$PHASE}
LABEL_FROM=${LABEL_FROM:-phase:$PHASE}
LABEL_TO=${LABEL_TO:-phase:$PHASE-done}
CONFIG_DIR=${OH_PIPELINE_CONFIG_DIR:-$HOME/.config/oh-pipeline}
STATE_DIR=${OH_PIPELINE_STATE_DIR:-$HOME/.cache/oh-pipeline}
GITHUB_API=${GITHUB_API_URL:-https://api.github.com}
PROJECT_DIR=${OPENHANDS_PROJECT_DIR:-$PWD}
STATE="$STATE_DIR/$OPENHANDS_SESSION_ID.json"
SPAN_ID="$PHASE-$OPENHANDS_SESSION_ID"
SUMMARY_MAX=4000
TITLE_MAX=200 # mission-control refuses a longer work-unit title

die() { echo "phase.sh: $*" >&2; exit 1; }

read_token() {
  local file="$CONFIG_DIR/$1"
  [ -f "$file" ] || die "missing token file $file"
  # ls is the one permission read that behaves the same on GNU and BSD.
  # shellcheck disable=SC2012
  [ "$(ls -l "$file" | cut -c5-10)" = "------" ] || die "$file must be readable by its owner only"
  cat "$file"
}

# Tokens go to curl through a config file descriptor, never argv, so they do
# not show up in the process list the agent can read.
mc_post() {
  curl -fsS -m 15 -X POST -K <(printf 'header = "X-WC-Token: %s"\n' "$MC_TOKEN") -H 'content-type: application/json' \
    -d "$2" "$MC_SITE_URL$1" || die "mission-control rejected POST $1"
}

gh_api() {
  local method=$1 path=$2
  shift 2
  curl -fsS -m 15 -X "$method" -K <(printf 'header = "Authorization: Bearer %s"\n' "$GH_TOKEN") \
    -H 'Accept: application/vnd.github+json' "$@" "$GITHUB_API/repos/$REPO$path"
}

receipt() {
  local body
  body=$(jq -cn --arg run "$RUN_ID" --argjson seq "$1" --arg kind "$2" \
    --arg repo "$REPO" --arg wu "$WORK_UNIT_ID" --argjson payload "$3" \
    '{schemaVersion: 1, runId: $run, sequence: $seq, kind: $kind, repo: $repo, workUnitId: $wu, payload: $payload}')
  mc_post "/api/runs/$RUN_ID/receipts" "$body" >/dev/null
}

phase_event() {
  local body
  body=$(jq -cn --arg span "$SPAN_ID" --arg wu "$WORK_UNIT_ID" --arg step "$STEP_ID" \
    --arg session "$OPENHANDS_SESSION_ID" --arg run "$RUN_ID" --arg status "$1" \
    --argjson start "$START_MS" --argjson endms "${2:-null}" \
    '{schemaVersion: 1, spanId: $span, workUnitId: $wu, stepId: $step, kind: "flow", startMs: $start,
      status: $status, sessionId: $session, runId: $run, fidelity: "observed"}
     + (if $endms == null then {} else {endMs: $endms} end)')
  mc_post /api/sync/phase-event "$body" >/dev/null
}

now_ms() { echo "$(($(date +%s) * 1000))"; }

MC_TOKEN=$(read_token mc-token)
GH_TOKEN=$(read_token gh-token)

case "$OPENHANDS_EVENT_TYPE" in
  SessionStart)
    # The agent-server can fire SessionStart again when it rebuilds its hook
    # processor. Reopening a span that Stop already closed would be a lie.
    [ -f "$STATE" ] && exit 0
    title=$(gh_api GET "/issues/$ISSUE" | jq -er .title) || die "cannot read issue $REPO#$ISSUE"
    WORK_UNIT_ID=$(mc_post /api/sync/work-unit "$(jq -cn --arg repo "$REPO" --argjson issue "$ISSUE" --arg title "${title:0:$TITLE_MAX}" \
      '{repo: $repo, issueNumber: $issue, title: $title}')" | jq -er .workUnitId) || die "no workUnitId in response"
    START_MS=$(now_ms)
    phase_event in-progress
    receipt 1 run.started "$(jq -cn --arg c "$OPENHANDS_SESSION_ID" --arg p "$PHASE" --argjson i "$ISSUE" \
      '{conversationId: $c, phase: $p, issueNumber: $i}')"
    mkdir -p "$STATE_DIR"
    jq -cn --arg wu "$WORK_UNIT_ID" --argjson start "$START_MS" '{workUnitId: $wu, startMs: $start}' >"$STATE"
    ;;

  Stop)
    [ -f "$STATE" ] || die "no state for session $OPENHANDS_SESSION_ID: SessionStart never completed"
    WORK_UNIT_ID=$(jq -er .workUnitId "$STATE")
    START_MS=$(jq -er .startMs "$STATE")

    # The outcome is decided once, on the first Stop, and kept in the state
    # file. A later Stop replays it byte for byte: mission-control answers 200
    # to an identical receipt and 409 to a changed one, and by then the
    # worktree may be gone.
    if [ "$(jq -r '.status // empty' "$STATE")" = "" ]; then
      result="$PROJECT_DIR/.agents/phase-result.json"
      # No result file, or one that is not the agreed shape, is reported as
      # blocked. A finished run that forgot the file is a false negative, which
      # is the safe direction: nothing is recorded as done on say-so alone.
      if status=$(jq -er 'select(.status == "done" or .status == "blocked") | .status' "$result" 2>/dev/null); then
        summary=$(jq -r '.summary // "" | tostring' "$result")
      else
        status=blocked
        summary="The agent stopped without writing a valid .agents/phase-result.json."
      fi
      # The summary is written by an agent that read an untrusted issue and can
      # read this node's token files, and it is about to be posted in public.
      # Anything credential-shaped withholds the whole summary.
      if grep -qF -e "$MC_TOKEN" -e "$GH_TOKEN" <<<"$summary" ||
        grep -qE '(gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}' <<<"$summary"; then
        status=blocked
        summary="Summary withheld: it contained a credential."
      fi
      # Mentions are defused so a summary cannot ping people or teams.
      summary=$(jq -rn --arg s "${summary:0:$SUMMARY_MAX}" '$s | gsub("@"; "@\u200b")')
      jq -c --arg status "$status" --arg summary "$summary" --argjson endms "$(now_ms)" \
        '. + {status: $status, summary: $summary, endMs: $endms}' "$STATE" >"$STATE.tmp" && mv "$STATE.tmp" "$STATE"
    fi
    status=$(jq -er .status "$STATE")
    summary=$(jq -r .summary "$STATE")
    phase_event "$status" "$(jq -er .endMs "$STATE")"
    receipt 2 phase.completed "$(jq -cn --arg c "$OPENHANDS_SESSION_ID" --arg p "$PHASE" --arg s "$status" \
      --arg sum "$summary" '{conversationId: $c, phase: $p, status: $s, summary: $sum}')"

    # Mission-control has the record. Only now is GitHub written. Each step is
    # marked as it lands, so a replay after a partial failure repeats nothing.
    mark() { jq -c --arg k "$1" '. + {($k): true}' "$STATE" >"$STATE.tmp" && mv "$STATE.tmp" "$STATE"; }
    if [ "$(jq -r '.commented // false' "$STATE")" != true ]; then
      # shellcheck disable=SC2016
      body=$(printf '### Pipeline phase `%s`: %s\n\n%s\n\n<sub>run `%s` · conversation `%s`</sub>' \
        "$PHASE" "$status" "$summary" "$RUN_ID" "$OPENHANDS_SESSION_ID")
      gh_api POST "/issues/$ISSUE/comments" -d "$(jq -cn --arg b "$body" '{body: $b}')" >/dev/null \
        || die "cannot comment on $REPO#$ISSUE"
      mark commented
    fi
    if [ "$status" = "done" ] && [ "$(jq -r '.labelled // false' "$STATE")" != true ]; then
      gh_api POST "/issues/$ISSUE/labels" -d "$(jq -cn --arg l "$LABEL_TO" '{labels: [$l]}')" >/dev/null \
        || die "cannot add label $LABEL_TO"
      # A label that is already gone is the state we want.
      gh_api DELETE "/issues/$ISSUE/labels/$(jq -rn --arg l "$LABEL_FROM" '$l | @uri')" >/dev/null 2>&1 || true
      mark labelled
    fi
    ;;

  *) exit 0 ;;
esac
