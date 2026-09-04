#!/usr/bin/env bash
# Provision the isolated dsh test home.
#
#   ./setup.sh            ensure the home exists, sync baseline settings
#   ./setup.sh --fresh    wipe the home (sessions, storages) and rebuild
#
# The baseline settings (testenv/baseline/settings.yaml) are the migration
# sandbox: a copy of the live ~/.dsh/settings.yaml with the hand-written
# llama-swap provider block and agent-default-model. E2E migration tests
# (design's Tier 3) run here: remove the hand-written block, add the
# modelspoke route, re-point agent-default-model — the live config is
# never edited.
set -euo pipefail

TESTENV_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$TESTENV_DIR/env.sh"

FRESH=0
[ "${1:-}" = "--fresh" ] && FRESH=1

if [ "$FRESH" -eq 1 ]; then
	rm -rf "$DSH_HOME"
fi

# Auto-initialize the headless profile from the dsh shipped template
# (creates profiles/headless with package.json, cordis files, workspace).
dsh --profile headless --dump-config >/dev/null

# Sync baseline settings (source of truth for the migration sandbox).
if [ ! -f "$DSH_HOME/settings.yaml" ] || [ "$FRESH" -eq 1 ]; then
	cp "$TESTENV_DIR/baseline/settings.yaml" "$DSH_HOME/settings.yaml"
fi

echo "test home ready: $DSH_HOME"
ls "$DSH_HOME"
