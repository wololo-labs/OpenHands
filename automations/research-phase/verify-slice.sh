#!/usr/bin/env bash
# Acceptance check for one pipeline-phase run. Reads the three systems the run
# touched and prints PASS or FAIL per claim. Exits non-zero on any FAIL.
#
#   MASTER_URL=... MASTER_KEY_FILE=~/.openhands/canvas-api-key NODE_ID=... \
#   MC_DIR=/path/to/mission-control REPO=owner/name ISSUE=9 \
#   bash verify-slice.sh <conversation-id> <run-id>
#
# MC_DIR is a mission-control checkout whose environment points at the
# deployment under test; rows are read with `npx convex data`.
set -euo pipefail
CONVERSATION=${1:?conversation id} RUN_ID=${2:?run id}
: "${MASTER_URL:?}" "${MASTER_KEY_FILE:?}" "${NODE_ID:?}" "${MC_DIR:?}" "${REPO:?}" "${ISSUE:?}"
PHASE=${PHASE:-research}
LABEL_FROM=${LABEL_FROM:-phase:$PHASE}
LABEL_TO=${LABEL_TO:-phase:$PHASE-done}
SPAN_ID="$PHASE-${CONVERSATION//-/}"

FAILED=0
claim() { # claim <text> <expected> <actual>
  if [ "$2" = "$3" ]; then echo "PASS $1"; else FAILED=1; echo "FAIL $1 (expected '$2', got '$3')"; fi
}
node_get() { curl -fsS -m 30 -H "X-Session-API-Key: $(cat "$MASTER_KEY_FILE")" "$MASTER_URL/backend/$NODE_ID$1"; }
table() { (cd "$MC_DIR" && npx convex data "$1" --limit 500 --format jsonl 2>/dev/null); }

conversation=$(node_get "/api/conversations/$CONVERSATION")
claim "conversation reached a terminal state" finished "$(jq -r .execution_status <<<"$conversation")"
result=$(node_get "/api/conversations/$CONVERSATION/workspace/.agents/phase-result.json" || echo '{}')
claim "agent wrote a done result file" "done" "$(jq -r '.status // "missing"' <<<"$result" 2>/dev/null || echo unparseable)"

# The hook keys its span on the session id the agent-server hands it, which may
# be the conversation id with or without dashes. Match either.
spans=$(table phaseSpans | jq -c --arg a "$PHASE-$CONVERSATION" --arg b "$SPAN_ID" 'select(.spanId == $a or .spanId == $b)')
claim "exactly one phase span for the conversation" 1 "$(grep -c . <<<"$spans" || true)"
claim "span is closed, done, observed, on the $PHASE step" "done observed true flow-default:$PHASE" \
  "$(jq -r '"\(.status) \(.fidelity) \(.endMs != null) \(.stepId)"' <<<"$spans")"

receipts=$(table agentRunReceipts | jq -c --arg run "$RUN_ID" 'select(.runId == $run)' | jq -sc 'sort_by(.sequence)')
claim "receipts 1 and 2, in order, no gap" "1:run.started 2:phase.completed" \
  "$(jq -r 'map("\(.sequence):\(.kind)") | join(" ")' <<<"$receipts")"

issue=$(gh issue view "$ISSUE" --repo "$REPO" --json labels,comments)
claim "issue carries $LABEL_TO and no longer $LABEL_FROM" "true false" \
  "$(jq -r --arg to "$LABEL_TO" --arg from "$LABEL_FROM" '[.labels[].name] | "\(index($to) != null) \(index($from) != null)"' <<<"$issue")"
claim "issue has a comment naming this run" true \
  "$(jq -r --arg run "$RUN_ID" '[.comments[].body | contains($run)] | any' <<<"$issue")"

exit "$FAILED"
