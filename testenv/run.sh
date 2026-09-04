#!/usr/bin/env bash
# One-shot headless run against the isolated test home.
#
#   ./run.sh "verify the modelspoke route works"
#
# Boots the headless profile with DSH_HOME pointed at testenv/dsh-home,
# so settings, sessions, and plugin state are fully isolated from the
# live ~/.dsh. Extra arguments pass through to the headless app.
#
# ONE RUN = ONE FRESH SESSION: the headless app has no resume/continue
# flag (it creates session-<uuid> per invocation). Multi-turn /
# durable-history behavior must be driven within a single task — the
# agent loop re-requests with the growing durable history on every tool
# round trip.
set -euo pipefail

TESTENV_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$TESTENV_DIR/env.sh"

if [ ! -d "$DSH_HOME/profiles/headless" ]; then
	"$TESTENV_DIR/setup.sh"
fi

exec dsh --profile headless "$@"
