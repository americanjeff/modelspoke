# Isolated dsh home for modelspoke development.
#
# Source this file to point any dsh invocation at the test home:
#
#   source testenv/env.sh
#   dsh --profile headless "test task"
#
# Everything dsh reads and writes (settings.yaml, profiles, sessions,
# storages, credentials) resolves under testenv/dsh-home — the live
# ~/.dsh that the running web session uses is never touched.

TESTENV_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export DSH_HOME="$TESTENV_DIR/dsh-home"
