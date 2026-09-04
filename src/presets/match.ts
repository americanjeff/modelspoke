/**
 * Preset matching: catalog-ordered FIRST match, case-insensitive.
 *
 * The `match` string is tested as an UNANCHORED, case-insensitive regular
 * expression against the model id. For literal patterns this is exactly a
 * case-insensitive substring test (so `unsloth/Qwen3.8-27B-GGUF` matches);
 * the regex form is what lets `qwen3[._-]?8` cover the Qwen3.8 family
 * spellings in one entry.
 */

import type { Preset } from "../types.js";
import { presetCatalog } from "./catalog.js";

export function matchPreset(
  modelId: string,
  catalog: readonly Preset[] = presetCatalog,
): Preset | undefined {
  const id = modelId.toLowerCase();
  for (const preset of catalog) {
    let re: RegExp;
    try {
      re = new RegExp(preset.match, "i");
    } catch {
      // A malformed pattern in a caller-supplied catalog never matches
      // (the bundled catalog's patterns are drift-checked to be valid).
      continue;
    }
    if (re.test(id)) {
      return preset;
    }
  }
  return undefined;
}
