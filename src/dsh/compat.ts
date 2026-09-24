/**
 * Access to the dsh-llm install-seam symbols, host floor dsh 0.1.7.
 *
 * Why the namespace indirection on `callId`: the main dsh-llm type entry
 * (`lib/types/index.d.ts`) does not declare the `ToolCallId` brand — the
 * type lives in the package's `types` module, and the runtime brand
 * constructor is not declared in the main entry's d.ts either. A named
 * import would fail `tsc` (or, at module link time, "does not provide an
 * export"); a namespace import has no per-name check — it yields whatever
 * the loaded copy actually exports — so we import the whole module and
 * resolve the brand at runtime (type-erased `Record<string, unknown>`).
 */

import * as dshLlm from "@deepseek-ai/dsh-llm";

const llm = dshLlm as Record<string, unknown>;

/**
 * The loaded dsh-llm's tool-call-id brand constructor (`ToolCallId`). The
 * returned value carries the loaded copy's brand; the brand is a nominal
 * type the main entry does not name, so call sites cast the result (`as
 * never` — never is assignable to the branded parameter, and the runtime
 * value is already correctly branded).
 */
export const callId: (id: string) => unknown = (() => {
  const brand = llm.ToolCallId;
  if (typeof brand !== "function") {
    throw new Error(
      "modelspoke: the loaded dsh-llm does not export the `ToolCallId` brand (host is below the 0.1.7 floor)",
    );
  }
  return brand as (id: string) => unknown;
})();

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
