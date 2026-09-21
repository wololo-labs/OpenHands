#!/usr/bin/env bash
# Build the automation tarball: the entrypoint, the phase prompt from its
# canonical home in .agents/dag/, and a config.env holding the site-specific
# values. Those values come from the caller's environment and are never
# committed; the output lands under the gitignored .tmp/.
#
#   NODE_ID=... REPO=owner/name ISSUE=9 WORKSPACE_DIR=/path/on/node \
#   MC_SITE_URL=https://... bash automations/research-phase/make-tarball.sh
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
PHASE=${PHASE:-research}
OUT=${OUT:-$ROOT/.tmp/$PHASE-phase.tar.gz}
: "${NODE_ID:?}" "${REPO:?}" "${ISSUE:?}" "${WORKSPACE_DIR:?}" "${MC_SITE_URL:?}"

stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
cp "$ROOT/automations/research-phase/tarball/entrypoint.sh" "$stage/"
cp "$ROOT/.agents/dag/$PHASE.md" "$stage/"
for name in NODE_ID REPO ISSUE WORKSPACE_DIR MC_SITE_URL PHASE MASTER_URL LABEL_FROM LABEL_TO; do
  [ -n "${!name:-}" ] && printf '%s=%q\n' "$name" "${!name}"
done >"$stage/config.env"

mkdir -p "$(dirname "$OUT")"
tar -czf "$OUT" -C "$stage" .
echo "$OUT"
