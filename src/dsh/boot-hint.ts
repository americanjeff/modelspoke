/**
 * modelspoke — dsh node half: the one-line first-boot hint.
 *
 * A fresh install boots DORMANT — zero providers (the composition entry is
 * absent and the schema defaults apply) — and a dormant boot is otherwise
 * silent: no routes, no directory rows, no models, and in a web profile
 * only the empty-section page. To make the dormant state discoverable, the
 * dsh node half (src/dsh/index.ts) logs EXACTLY ONE info line per boot
 * when the INITIAL section carries no routes: the plugin is active, it has
 * no routes yet, and where to fix it (the `modelspoke:` section of
 * settings.yaml, or the Modelspoke settings card in the web UI's Plugins
 * page).
 *
 * The decision is a pure function of the initial section ({@link
 * firstBootHint}). It is settled ONCE per boot, on the first settings
 * `onChange` — the first moment the initial section is actually known
 * (the composition entry is always empty: dsh.cordis.yml ships no config
 * row, and the user's section becomes the live source only when the
 * settings service attaches, which may land after `apply` returns) — and
 * never re-evaluated on later onChange events, so a session that later
 * adds (or drops) routes stays quiet.
 */

import { routesOf } from "./settings.js";

/**
 * The first-boot hint, or `null` when no hint is due.
 *
 * @param section - The INITIAL resolved `modelspoke:` section (the
 *   settings-scope source while a settings service is attached; the
 *   composition entry — schema defaults when absent — otherwise).
 * @returns The single-line info log when the section carries zero routes
 *   (the dormant state a fresh install boots into); `null` when at least
 *   one route exists. Lenient like every other reader: an absent or
 *   malformed section simply has zero serviceable routes, so the hint
 *   applies.
 */
export function firstBootHint(section: unknown): string | null {
  if (routesOf(section).length > 0) return null;
  return (
    "modelspoke: active with 0 providers — add one under the `modelspoke:` section of " +
    "settings.yaml (a provider is one entry under `routes:`), or in the Modelspoke " +
    "card of the dsh web UI's Plugins settings (Settings → Plugins → modelspoke card)"
  );
}
