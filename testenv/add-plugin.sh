#!/usr/bin/env bash
# Attach the modelspoke package (this repo) to the test headless profile.
#
#   ./add-plugin.sh
#
# Idempotent. After the first modelspoke build exists (package.json at the
# repo root declaring the dsh.bundle.patch manifest, dist/ built), this:
#
#   1. links the repo into the profile's node_modules via a pnpm `link:`
#      dependency (a symlink — rebuilds in the repo are picked up on the
#      next boot, no reinstall), and
#   2. adds the package to the profile's dsh.profile.bundles list, which is
#      how dsh loads its dsh.bundle.patch layer.
#
# This is the same activation path as the live tui profile's
# @openma/deepseek-harness-tui bundle.
set -euo pipefail

TESTENV_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$TESTENV_DIR/.." && pwd)"
PROFILE_DIR="$TESTENV_DIR/dsh-home/profiles/headless"

if [ ! -f "$REPO_ROOT/package.json" ]; then
	echo "error: $REPO_ROOT/package.json not found — build the modelspoke package first." >&2
	exit 1
fi
if [ ! -f "$PROFILE_DIR/package.json" ]; then
	echo "error: headless profile missing — run ./setup.sh first." >&2
	exit 1
fi

PKG_NAME=$(node -p "require('$REPO_ROOT/package.json').name")
if [ -z "$PKG_NAME" ]; then
	echo "error: no package name in $REPO_ROOT/package.json." >&2
	exit 1
fi

node -e "
const fs = require('fs');
const p = '$PROFILE_DIR/package.json';
const pkg = JSON.parse(fs.readFileSync(p, 'utf8'));
pkg.dependencies ??= {};
pkg.dependencies['$PKG_NAME'] = 'link:$REPO_ROOT';
pkg.dsh ??= {};
pkg.dsh.profile ??= {};
pkg.dsh.profile.bundles ??= ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'];
const bundles = pkg.dsh.profile.bundles;
if (!bundles.includes('$PKG_NAME')) bundles.push('$PKG_NAME');
fs.writeFileSync(p, JSON.stringify(pkg, null, 2) + '\n');
console.log('profile manifest updated:', JSON.stringify({ dependencies: pkg.dependencies, bundles }));
"

# --store-dir: this sandbox's pnpm default store is read-only (ERR_SQLITE_ERROR);
# the shared writable store lives under /tmp.
(cd "$PROFILE_DIR" && pnpm --store-dir /tmp/pnpm-store install)

echo
echo "$PKG_NAME attached to the headless profile."
echo "Verify with:  $TESTENV_DIR/run.sh --dump-config | grep -A3 modelspoke"
echo "(or: DSH_HOME=$TESTENV_DIR/dsh-home dsh --profile headless --dump-config)"
