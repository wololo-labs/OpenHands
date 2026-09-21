#!/usr/bin/env bash
# Behavioural check for phase.sh against a recording HTTP stub that stands in
# for both mission-control and GitHub. Run: bash phase.test.sh
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
WORK=$(mktemp -d)
trap 'kill "$STUB_PID" 2>/dev/null || true; rm -rf "$WORK"' EXIT

# The stub logs "METHOD PATH BODY" per request. Any mission-control path answers
# 500 while $WORK/fail-mc exists.
# shellcheck disable=SC2016
node -e '
const http = require("http"), fs = require("fs"), [log, portFile, failFlag] = process.argv.slice(1);
http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c)).on("end", () => {
    fs.appendFileSync(log, `${req.method} ${req.url} ${body}\n`);
    const mc = req.url.startsWith("/api/");
    if (mc && fs.existsSync(failFlag)) { res.writeHead(500); return res.end("{}"); }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(mc ? { ok: true, workUnitId: "01HZX3V9K4TQ5RB2C6D7E8F9G0" } : { title: "three review findings" }));
  });
}).listen(0, "127.0.0.1", function () { fs.writeFileSync(portFile, String(this.address().port)); });
' "$WORK/requests.log" "$WORK/port" "$WORK/fail-mc" &
STUB_PID=$!
for _ in $(seq 50); do [ -s "$WORK/port" ] && break; sleep 0.1; done
URL="http://127.0.0.1:$(cat "$WORK/port")"

mkdir -p "$WORK/config"
(umask 077; echo mc-secret >"$WORK/config/mc-token"; echo gh-secret >"$WORK/config/gh-token")

# run_hook <session> <event>: a fresh project dir per session unless one exists.
run_hook() {
  mkdir -p "$WORK/project-$1/.agents"
  REPO=acme/widgets ISSUE=9 RUN_ID=run-1 MC_SITE_URL=$URL GITHUB_API_URL=$URL \
    OH_PIPELINE_CONFIG_DIR="$WORK/config" OH_PIPELINE_STATE_DIR="$WORK/state" \
    OPENHANDS_SESSION_ID=$1 OPENHANDS_EVENT_TYPE=$2 OPENHANDS_PROJECT_DIR="$WORK/project-$1" \
    bash "$HERE/phase.sh"
}
requests() { cut -d' ' -f1,2 "$WORK/requests.log" 2>/dev/null || true; }
reset() { : >"$WORK/requests.log"; }

FAILED=0
check() { # check <name> <expected> <actual>
  if [ "$2" = "$3" ]; then echo "ok   $1"; else
    FAILED=1; printf 'FAIL %s\n--- expected\n%s\n--- actual\n%s\n' "$1" "$2" "$3"; fi
}

reset; run_hook s1 SessionStart
check "start: reads the issue, resolves the work unit, opens the span, appends receipt 1" \
"GET /repos/acme/widgets/issues/9
POST /api/sync/work-unit
POST /api/sync/phase-event
POST /api/runs/run-1/receipts" "$(requests)"
check "start: the span is open and observed" "in-progress observed null" \
  "$(grep phase-event "$WORK/requests.log" | cut -d' ' -f3- | jq -r '"\(.status) \(.fidelity) \(.endMs)"')"

reset; run_hook s1 SessionStart
check "start fired twice does not reopen the span" "" "$(requests)"

reset; echo '{"status":"done","summary":"found all three"}' >"$WORK/project-s1/.agents/phase-result.json"
run_hook s1 Stop
check "stop with a done result: mission-control first, then comment, then label swap" \
"POST /api/sync/phase-event
POST /api/runs/run-1/receipts
POST /repos/acme/widgets/issues/9/comments
POST /repos/acme/widgets/issues/9/labels
DELETE /repos/acme/widgets/issues/9/labels/phase%3Aresearch" "$(requests)"
check "stop: receipt 2 carries the status and summary" "2 phase.completed done found all three" \
  "$(grep receipts "$WORK/requests.log" | cut -d' ' -f3- | jq -r '"\(.sequence) \(.kind) \(.payload.status) \(.payload.summary)"')"
FIRST_BODIES=$(grep '/api/' "$WORK/requests.log")

reset; run_hook s1 Stop
check "stop fired twice replays identical mission-control bodies and does not comment again" \
  "$FIRST_BODIES" "$(cat "$WORK/requests.log")"

reset; run_hook s2 SessionStart; reset; run_hook s2 Stop
check "stop without a result file reports blocked and leaves the labels alone" \
"POST /api/sync/phase-event blocked
POST /api/runs/run-1/receipts blocked
POST /repos/acme/widgets/issues/9/comments " \
  "$(while read -r m p b; do echo "$m $p $(jq -r '.status // .payload.status // empty' <<<"$b")"; done <"$WORK/requests.log")"

reset; run_hook s3 SessionStart; echo '{"status":"done","summary":"x"}' >"$WORK/project-s3/.agents/phase-result.json"
touch "$WORK/fail-mc"; reset
set +e; run_hook s3 Stop 2>/dev/null; code=$?; set -e; rm "$WORK/fail-mc"
check "mission-control failure: exits 1 (never 2, which would block the agent)" 1 "$code"
check "mission-control failure: GitHub is never written" "" "$(requests | grep /repos/ || true)"

chmod 644 "$WORK/config/mc-token"; reset
set +e; run_hook s4 SessionStart 2>/dev/null; code=$?; set -e
check "a token file others can read is refused before any request" "1 " "$code $(requests)"

[ "$FAILED" = 0 ] && echo "all checks passed"
exit "$FAILED"
