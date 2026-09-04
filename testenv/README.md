# testenv — isolated dsh test environment

A separate dsh home for developing and testing the modelspoke plugin,
disjoint from the live `~/.dsh` that the running web session (this
checkout's `dsh web` instance) uses.

## Isolation mechanism

dsh resolves its home via `resolveDshHome()`
(`@deepseek-ai/dsh-home-paths`): an explicit config > **`$DSH_HOME`** >
`~/.dsh`, read per call. Pointing `DSH_HOME` at `testenv/dsh-home`
redirects *everything* dsh reads and writes: `settings.yaml`,
`profiles/`, `sessions/`, `storages/`, `.credentials.yaml`.

Verified: a full headless boot + one-shot run under the test home produces
**zero writes to `~/.dsh`** (md5 diff of every file before/after), and the
test home does *not* inherit the live settings — it sees an empty home
until the baseline settings are copied in.

What is *not* isolated (shared by design):

- the dsh installation itself (read-only; both homes run the same binary),
- the local model servers (llama-swap on `127.0.0.1:8080`, ollama on
  `127.0.0.1:11434`) — they are stateless w.r.t. dsh config, and the whole
  point is to test against the same servers the live setup uses,
- credentials: the test home has **no** `.credentials.yaml` (it is never
  copied in). The baseline llama-swap route declares
  `apiKeyEnv: LLAMA_SWAP_API_KEY`, so test runs must set it — a dummy value
  is fine, the local server does not validate it:
  `LLAMA_SWAP_API_KEY=dummy ./testenv/run.sh "…"`. For deepseek-official,
  `export DEEPSEEK_API_KEY=...` in the launching shell instead.

## Layout

```
testenv/
  env.sh              source to export DSH_HOME=testenv/dsh-home
  setup.sh            provision/rebuild the home (--fresh to wipe)
  run.sh              one-shot headless task against the test home
  add-plugin.sh       attach this repo's modelspoke build to the headless profile
  baseline/
    settings.yaml     copy of the live settings (migration sandbox, see below)
  dsh-home/           the isolated home (generated; gitignored)
    profiles/headless/
    settings.yaml     <- baseline copy
    sessions/  storages/
```

## Usage

```sh
cd modelspoke
./testenv/setup.sh                                        # first time / re-sync baseline
LLAMA_SWAP_API_KEY=dummy ./testenv/run.sh "test task"     # one-shot headless turn
source ./testenv/env.sh                                   # or drive dsh manually:
DSH_HOME="$PWD/testenv/dsh-home" dsh --profile headless --dump-config  # composed tree
```

**Each run is a FRESH session.** The headless runner
(`@deepseek-ai/dsh-headless`) creates `session-<uuid>` on every invocation
and has **no resume/continue flag** (verified in its `run()` — the
`--resume <session>` form formerly documented here was never supported; it
errors with `unknown option`). Multi-turn and durable-history behavior
must be exercised WITHIN ONE task: the agent loop issues a new LLM request
per tool round trip, each carrying the growing durable history (this is
how the v0.1.1 image fix was live-verified — a `read_image` round trip
inside one task). True next-turn continuation is a GUI-tier test (the
live `~/.dsh` web session).

Verified working (2026-08-23): fresh provision → one-shot turn through the
baseline llama-swap route against the live local server returned the
expected reply, with zero writes to `~/.dsh` (md5 diff of every file in the
live home before/after).

### Sub-agents and other workspaces

- **Works from any workspace.** The scripts resolve paths from their own
  location, so they run correctly from any cwd. Test-home sessions are
  keyed by the workspace path (`sessions/--<workspace>--/`), so concurrent
  or repeated runs from different workspaces get separate session
  directories — no collisions. (Verified: a run from `/tmp` created
  `--tmp--` beside the modelspoke-workspace sessions, live home untouched.)
- **Sub-agents do NOT inherit the test home.** A sub-agent spawned from a
  live session inherits that process's environment —
  `DSH_HOME=~/.dsh` — and its own session state is written to the
  live home (normal child-session behavior). Therefore: **any `dsh` test
  command from a sub-agent must go through `testenv/run.sh` or
  `source testenv/env.sh`**. A bare `dsh --profile headless "…"` from a
  sub-agent boots against the *live* home. When delegating test work, state
  the rule in the sub-agent prompt.
- **Concurrency.** Parallel one-shot turns under the test home are fine
  (distinct session dirs; settings/profiles are read-only during a boot).
  The one hazard: don't run `add-plugin.sh` (its `pnpm install` rewrites
  the profile's `node_modules`) while a test-home boot is in flight.

### Attaching the modelspoke build (after the first build exists)

```sh
pnpm build          # in the repo root (once package.json/dist exist)
./testenv/add-plugin.sh
./testenv/run.sh "…"   # now boots with the modelspoke bundle active
```

`add-plugin.sh` links the repo into the profile's `node_modules` via a
pnpm `link:` dependency (a symlink: rebuild → next boot, no reinstall) and
adds the package to the profile's `dsh.profile.bundles` — the same
activation path as the live tui profile's bundle. The plugin must declare
its `dsh.bundle.patch` manifest in `package.json` (per design.md),
otherwise dsh fails loud at boot.

## The migration sandbox

`baseline/settings.yaml` is a copy of the live `~/.dsh/settings.yaml`
taken 2026-08-23, containing the hand-written `llama-swap` provider block
and `agent-default-model` — the exact state design.md's **Tier 3 E2E**
starts from. Run the migration here, repeat as often as needed:

```sh
# edit dsh-home/settings.yaml: delete the hand-written llama-swap block,
# add the modelspoke: route, re-point agent-default-model
./testenv/run.sh "run a multi-turn coding task"
# then verify the metadataSource log line + description suffix
./testenv/setup.sh --fresh   # wipe, restore baseline, test again
```

Refresh the baseline if the live settings change:
`cp ~/.dsh/settings.yaml testenv/baseline/settings.yaml`.

## Profile choice

`headless` — one-shot `dsh --profile headless "<task>"` runs, auto-
initialized from the dsh shipped template. No second web server is
started; the live `dsh web` instance keeps owning its own home.
