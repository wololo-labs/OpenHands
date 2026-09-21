#!/usr/bin/env bash
# Behavioural check for entrypoint.sh against a recording stub that stands in
# for the fleet master. Run: bash entrypoint.test.sh
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../../.." && pwd)
WORK=$(mktemp -d)
trap 'kill "$STUB_PID" 2>/dev/null || true; rm -rf "$WORK"' EXIT

# server_info answers 502 while $WORK/node-dead exists, as a node does when its
# agent-server has died behind a live ingress.
# shellcheck disable=SC2016
node -e '
const http = require("http"), fs = require("fs"), [log, portFile, deadFlag] = process.argv.slice(1);
http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c)).on("end", () => {
    fs.appendFileSync(log, `${req.method} ${req.url} ${req.headers["x-session-api-key"]} ${body}\n`);
    if (req.url.endsWith("/server_info") && fs.existsSync(deadFlag)) { res.writeHead(502); return res.end(); }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "conv-1", active_agent_profile_id: "11111111-1111-4111-8111-111111111111" }));
  });
}).listen(0, "127.0.0.1", function () { fs.writeFileSync(portFile, String(this.address().port)); });
' "$WORK/requests.log" "$WORK/port" "$WORK/node-dead" &
STUB_PID=$!
for _ in $(seq 50); do [ -s "$WORK/port" ] && break; sleep 0.1; done

mkdir "$WORK/run"
NODE_ID=node-1 REPO=acme/widgets ISSUE=9 WORKSPACE_DIR=/srv/widgets MC_SITE_URL=https://mc.example \
  MASTER_URL="http://127.0.0.1:$(cat "$WORK/port")" OUT="$WORK/t.tar.gz" bash "$ROOT/automations/research-phase/make-tarball.sh" >/dev/null
tar -xzf "$WORK/t.tar.gz" -C "$WORK/run"
dispatch() {
  SESSION_API_KEY=master-key AUTOMATION_RUN_ID=run-7 \
    AUTOMATION_CALLBACK_URL="http://127.0.0.1:$(cat "$WORK/port")/callback" bash "$WORK/run/entrypoint.sh"
}
callback() { grep 'POST /callback' "$WORK/requests.log" | cut -d' ' -f4-; }

FAILED=0
check() {
  if [ "$2" = "$3" ]; then echo "ok   $1"; else
    FAILED=1; printf 'FAIL %s\n--- expected\n%s\n--- actual\n%s\n' "$1" "$2" "$3"; fi
}

touch "$WORK/node-dead"
set +e; dispatch 2>"$WORK/err"; code=$?; set -e; rm "$WORK/node-dead"
check "dead node: fails before anything is started" \
  "1 GET /backend/node-1/server_info" "$code $(grep -v /callback "$WORK/requests.log" | cut -d' ' -f1,2)"
check "dead node: the run is reported FAILED, so it does not sit RUNNING" \
  '{"status":"FAILED","run_id":"run-7","error":"entrypoint exited 1"}' "$(callback)"
check "dead node: says which node and what it answered" "yes" \
  "$(grep -q 'node-1.*502' "$WORK/err" && echo yes || echo no)"

: >"$WORK/requests.log"
out=$(dispatch)
check "live node: reports the conversation it started" "run run-7 started conversation conv-1 on node node-1" "$out"
check "live node: the run is reported COMPLETED with its conversation" \
  '{"status":"COMPLETED","run_id":"run-7","conversation_id":"conv-1"}' "$(callback)"
check "live node: every call carries the master key" "master-key" "$(cut -d' ' -f3 "$WORK/requests.log" | sort -u)"
body=$(grep 'POST /backend/node-1/api/conversations' "$WORK/requests.log" | cut -d' ' -f4-)
check "request: node profile, dedicated worktree, and a message that runs" \
  "11111111-1111-4111-8111-111111111111 /srv/widgets true true" \
  "$(jq -r '"\(.agent_profile_id) \(.workspace.working_dir) \(.worktree) \(.initial_message.run)"' <<<"$body")"
# shellcheck disable=SC2016
check "request: the prompt is addressed to the issue" "yes" \
  "$(jq -r '.initial_message.content[0].text' <<<"$body" | grep -q 'issue #9 of `acme/widgets`' && echo yes || echo no)"
check "request: start and stop run the same hook, and it evaluates to the run context" \
  "acme/widgets 9 run-7 https://mc.example phase:research-done" \
  "$(cmd=$(jq -r '.hook_config | [.session_start, .stop] | map(.[0].hooks[0].command) | unique | .[]' <<<"$body")
     eval "${cmd% bash *}"; echo "$REPO $ISSUE $RUN_ID $MC_SITE_URL $LABEL_TO")"

[ "$FAILED" = 0 ] && echo "all checks passed"
exit "$FAILED"
