/**
 * Version-tolerant access to the dsh-llm / dsh-settings symbols that moved
 * between dsh 0.1.1 and 0.1.2, so one modelspoke build loads on both.
 *
 * Why the indirection: ESM named imports are validated at module link time —
 * `import { CallId } from "@deepseek-ai/dsh-llm"` throws
 * "does not provide an export named 'CallId'" before any code runs when the
 * loaded dsh-llm is 0.1.2, which renamed it `ToolCallId`. A namespace import
 * has no per-name check; it yields whatever the loaded copy actually exports,
 * so we import the whole module and resolve the moved names at runtime.
 *
 * Build note: the version-divergent lookups are type-erased
 * (`Record<string, unknown>`) so this file compiles against either version's
 * `.d.ts`; only the runtime value varies, and the `??` chain picks the one that
 * is present. Symbols that did not move (LlmError, the machine codes,
 * attributionHeaders, …) are still imported normally by their own modules —
 * only the moved ones route through here.
 */

import * as dshLlm from "@deepseek-ai/dsh-llm";
import * as dshSettings from "@deepseek-ai/dsh-settings";
import type { SettingsNamespace } from "@deepseek-ai/dsh-settings";

const llm = dshLlm as Record<string, unknown>;
const settings = dshSettings as Record<string, unknown>;

/**
 * dsh-llm tool-call-id brand constructor. 0.1.1 exports `CallId`; 0.1.2 renamed
 * it `ToolCallId`. The returned value carries the correct brand for whichever
 * dsh-llm is loaded; the 0.1.1/0.1.2 brands are unrelated nominal types, so
 * call sites cast the result to their build-time brand (`as never` — never is
 * assignable to either, and the runtime value is already correctly branded).
 */
export const callId: (id: string) => unknown = (() => {
  const brand = llm.CallId ?? llm.ToolCallId;
  if (typeof brand !== "function") {
    throw new Error(
      "modelspoke: dsh-llm exposes neither `CallId` (0.1.1) nor `ToolCallId` (0.1.2)",
    );
  }
  return brand as (id: string) => unknown;
})();

/**
 * dsh-settings namespace handle. 0.1.1: `settingsNamespace(name)` (a branded
 * value). 0.1.2: the namespace methods take a plain lowercase-hyphenated string
 * and brand it internally; no `settingsNamespace` export remains. At runtime
 * the branded value IS the string, so the identity fallback is equivalent.
 */
export const settingsNamespace: (name: string) => SettingsNamespace =
  typeof settings.settingsNamespace === "function"
    ? (settings.settingsNamespace as (name: string) => SettingsNamespace)
    : (name: string) => name as unknown as SettingsNamespace;

/**
 * "Install the optional-settings consumer wiring" for the `modelspoke:` section.
 *   0.1.1: free function `installSettingsSection(ctx, ns, schema, entry, hooks)`.
 *   0.1.2: method      `ctx.settings.installSection(owner, ns, schema, entry, hooks)`.
 * The hooks shape ({ setSource, onChange, validate? }) is identical in both.
 */
export function installSettingsSection(
  ctx: unknown,
  ns: SettingsNamespace,
  schema: unknown,
  entry: unknown,
  // Structural (not the dsh-settings type) so the call site's params get a
  // contextual type without importing a version-specific symbol; the loaded
  // 0.1.1/0.1.2 hook shape is structurally this.
  hooks: {
    setSource: (current: () => unknown) => void;
    onChange: () => void;
    validate?: (value: unknown) => void;
  },
): void {
  const free = settings.installSettingsSection;
  if (typeof free === "function") {
    // dsh 0.1.1: free function (modelspoke's inject stays ["llm"]).
    (free as (...args: unknown[]) => void)(ctx, ns, schema, entry, hooks);
    return;
  }
  // dsh 0.1.2: the seam is a method on the settings service, reached through the
  // scoped `ctx.inject(["settings"], …)` the 0.1.2 core requires — a bare
  // `ctx.settings` read is refused "without inject". Mirrors dsh-llm-pi-ai.
  const inject = (ctx as { inject?: (ids: readonly string[], cb: (settingsCtx: unknown) => void) => void } | null)?.inject;
  if (typeof inject === "function") {
    inject(["settings"], (settingsCtx: unknown) => {
      const provider = (settingsCtx as { settings?: { installSection?: unknown } } | null)?.settings;
      if (provider && typeof provider.installSection === "function") {
        (provider.installSection as (...args: unknown[]) => void)(ctx, ns, schema, entry, hooks);
      }
    });
    return;
  }
  throw new Error(
    "modelspoke: no dsh-settings install seam (neither 0.1.1 installSettingsSection nor a 0.1.2 ctx.inject(['settings']) provider)",
  );
}

/**
 * Deep equality for the plain-JSON "facts" modelspoke memoizes (route-name
 * arrays, LlmConfigurableProvider entries). Kept local rather than imported
 * from dsh-settings because `deepEqualJson` moved (main entry in 0.1.1,
 * `./invariant` subpath in 0.1.2) and a synchronous import cannot straddle
 * both. The compared values are always plain JSON, so a recursive structural
 * compare is sufficient.
 */
export function deepEqualJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    const bArr = b as unknown[];
    if (a.length !== bArr.length) return false;
    return a.every((v, i) => deepEqualJson(v, bArr[i]));
  }
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  const bo = b as Record<string, unknown>;
  return ka.every(
    (k) => Object.prototype.hasOwnProperty.call(bo, k) && deepEqualJson((a as Record<string, unknown>)[k], bo[k]),
  );
}
