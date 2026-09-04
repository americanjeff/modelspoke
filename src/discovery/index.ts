/**
 * Discovery: OpenAI-compatible `GET /v1/models` client (ported spine) +
 * `meta.llamaswap` extractors (tier 2 of the resolver).
 *
 * Dependency-free (global fetch/URL only). The default discovery path
 * (`discoverModels`) does NO `/running` fetch and NO `cmd` parsing; the
 * opt-in context probes (`probeLlamaSwapRunning`/`probeLlamaServerProps`)
 * are exported for later wiring only (unauthenticated `/running` leaks
 * the live HF token in `cmd`).
 *
 * The Ollama native `/api/*` tier-2 backend (`./ollama.js` +
 * `./ollama-families.js`): detection probe, per-model `/api/show` fetch, and
 * the pure mappers/seam the dsh channel's `discoverMetadata` branch builds
 * its rows through.
 */

import type { DiscoveryModelInfo, ModelspokeRoute } from "../types.js";
import { fetchModels } from "./client.js";
import { extractFromEntry } from "./metadata.js";
import { normalizeRouteBaseUrl } from "./url.js";

export { ModelspokeClientError, fetchModels } from "./client.js";
export { normalizeBasePath, normalizeRouteBaseUrl } from "./url.js";
export {
  extractCompat,
  extractContextWindow,
  extractFromEntry,
  extractInput,
  extractMaxTokens,
  extractName,
  extractReasoning,
  extractThinkingLevelMap,
  extractToolCalling,
  toPositiveInt,
} from "./metadata.js";
export { probeLlamaServerProps, probeLlamaSwapRunning } from "./probe.js";
export {
  isVersionGated,
  ollamaMetadataRows,
  ollamaModelfileParser,
  ollamaOrigin,
  ollamaShow,
  ollamaShowBatch,
  ollamaShowToCanonical,
  OLLAMA_SHOW_CONCURRENCY,
  probeOllamaVersion,
} from "./ollama.js";
export type {
  OllamaCanonicalMapping,
  OllamaFetchOptions,
  OllamaMetadataRow,
  OllamaRowsResult,
  OllamaShowMappingOptions,
  OllamaShowResponse,
  OllamaVersionProbe,
} from "./ollama.js";
export {
  ollamaThinkingLevelMapFor,
  OLLAMA_CLOUD_DEEPSEEK_MAP,
  OLLAMA_CLOUD_GLM_MAP,
  OLLAMA_DEEPSEEK3_MAP,
  OLLAMA_GEMMA4_MAP,
  OLLAMA_GPT_OSS_MAP,
  OLLAMA_QWEN35_MAP,
} from "./ollama-families.js";
export type { OllamaFamilyKey } from "./ollama-families.js";
export type {
  LlamaSwapMeta,
  ModelArchitecture,
  ModelCapabilities,
  ModelCompat,
  ModelMeta,
  ModelStatus,
  OpenAIModelEntry,
  OpenAIModelsListResponse,
} from "./types.js";

/**
 * Discovers models for one modelspoke route: GET `{baseURL}/v1/models` and
 * extract the per-model discovery contract.
 *
 * The route's `baseURL` is normalized to end in `/v1`; the Bearer key is read
 * from `process.env[apiKeyEnv]` and sent only when set (local servers usually
 * ignore it).
 *
 * @throws {ModelspokeClientError} On network or non-2xx responses / bad JSON.
 */
export async function discoverModels(
  route: Pick<ModelspokeRoute, "baseURL"> & { apiKeyEnv?: string },
  signal?: AbortSignal,
): Promise<DiscoveryModelInfo[]> {
  const baseUrl = normalizeRouteBaseUrl(route.baseURL);
  const apiKey = route.apiKeyEnv
    ? process.env[route.apiKeyEnv] || undefined
    : undefined;
  const entries = await fetchModels(baseUrl, apiKey, signal);
  return entries.map(extractFromEntry);
}
