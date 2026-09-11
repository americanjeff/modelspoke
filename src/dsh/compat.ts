/**
 * Access to the dsh-llm / dsh-settings install-seam symbols, host floor
 * dsh 0.1.5 (peer ranges: `^0.1.5-rc.2`).
 *
 * Why the namespace indirection on `callId`: the main dsh-llm type entry
 * (`lib/types/index.d.ts`) does not declare the `ToolCallId` brand — the
 * type lives in the package's `types` module, and the runtime brand
 * constructor is not declared in the main entry's d.ts either. A named
 * import would fail `tsc` (or, at module link time, "does not provide an
 * export"); a namespace import has no per-name check — it yields whatever
 * the loaded copy actually exports — so we import the whole module and
 * resolve the brand at runtime (type-erased `Record<string, unknown>`).
 *
 * The settings seam is the 0.1.2+ shape exclusively: the namespace methods
 * take a plain lowercase-hyphenated string and brand it internally (no
 * `settingsNamespace` export), and the section install is a
 * `SettingsProvider.installSection` reached through the scoped
 * `ctx.inject(["settings"], …)` the host requires. The 0.1.1 free-function
 * shapes (`CallId`, `settingsNamespace(name)`, `installSettingsSection`)
 * are gone — the host floor retired the detection branches that covered
 * them.
 */

import * as dshLlm from "@deepseek-ai/dsh-llm";
import type { SettingsNamespace } from "@deepseek-ai/dsh-settings";

const llm = dshLlm as Record<string, unknown>;

/**
 * The loaded dsh-llm's tool-call-id brand constructor (`ToolCallId` — the
 * 0.1.2+ name). The returned value carries the loaded copy's brand; the
 * brand is a nominal type the main entry does not name, so call sites cast
 * the result (`as never` — never is assignable to the branded parameter,
 * and the runtime value is already correctly branded).
 */
export const callId: (id: string) => unknown = (() => {
  const brand = llm.ToolCallId;
  if (typeof brand !== "function") {
    throw new Error(
      "modelspoke: the loaded dsh-llm does not export the `ToolCallId` brand (host is below the 0.1.5 floor)",
    );
  }
  return brand as (id: string) => unknown;
})();

/**
 * dsh-settings namespace handle. The namespace methods take a plain
 * lowercase-hyphenated string and brand it internally; at runtime the
 * branded value IS the string, so the identity mapping is the handle.
 */
export const settingsNamespace: (name: string) => SettingsNamespace = (
  name: string,
): SettingsNamespace => name as unknown as SettingsNamespace;

/**
 * Install the optional-settings consumer wiring for the `modelspoke:`
 * section: the `SettingsProvider.installSection` method, reached through
 * the scoped `ctx.inject(["settings"], …)` the host requires (a bare
 * `ctx.settings` read is refused "without inject"). The hooks shape
 * ({ setSource, onChange, validate? }) is the host's.
 */
export function installSettingsSection(
  ctx: unknown,
  ns: SettingsNamespace,
  schema: unknown,
  entry: unknown,
  // Structural (not the dsh-settings type) so the call site's params get a
  // contextual type without importing a version-specific symbol.
  hooks: {
    setSource: (current: () => unknown) => void;
    onChange: () => void;
    validate?: (value: unknown) => void;
  },
): void {
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
    "modelspoke: no dsh-settings install seam (the loaded host does not provide ctx.inject(['settings']) — below the 0.1.5 floor)",
  );
}

/**
 * Deep equality for the plain-JSON "facts" modelspoke memoizes (route-name
 * arrays, LlmConfigurableProvider entries). Kept local rather than imported
 * from dsh-settings so this module carries no dsh-settings value import —
 * the compared values are always plain JSON, so a recursive structural
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
