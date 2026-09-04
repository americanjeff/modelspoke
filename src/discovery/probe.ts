/**
 * Opt-in llama-swap / bare-llama-server context probes (ported
 * from pi-llama-swap `context.ts` `loadContextFromRunning` +
 * `fetchUpstreamContext`).
 *
 * WHY THESE ARE OPT-IN (kept off the default discovery path):
 * llama-swap's root `GET /running` is UNAUTHENTICATED and its per-process
 * `cmd` string leaks the live Hugging Face token (`-e HF_TOKEN=hf_…` —
 * observed live). Nothing in `client.ts` /
 * `extractFromEntry` calls these; they are exported for later opt-in
 * wiring only, and modelspoke must not print/store `/running` payloads.
 *
 * WHY THE `cmd`-PARSE FALLBACK WAS DROPPED (no `parseContextFromCmd`
 * port): `/running` `cmd` values can silently
 * disagree with `/v1/models` (e.g. `--ctx-size` in cmd vs.
 * `capabilities.context`), and the pi parser only recognizes
 * `--ctx-size`/`-c`, missing sglang's `--context-length` entirely.
 * Entries without a `proxy` therefore contribute nothing here.
 *
 * Never throws: any network error, non-2xx response, or JSON parse
 * failure resolves to `undefined` (or an empty result), so probes can be
 * tried unconditionally. All fetches go through an injectable
 * `fetchImpl` (defaults to `globalThis.fetch`) so tests never touch the
 * network.
 *
 * NOTE (adaptation from the port): pi's `loadContextFromRunning`
 * returned an EMPTY MAP on error; per the modelspoke probe contract
 * these return `undefined` on error and a (possibly empty) Map on a
 * successful 2xx parse, so callers can distinguish "probe failed" from
 * "probe ran, found nothing".
 */

import { toPositiveInt } from "./metadata.js";

/** llama-server `/props` response (subset). */
interface LlamaServerProps {
  default_generation_settings?: {
    n_ctx?: number;
  };
}

/** Running process entry from llama-swap `GET /running`. */
interface RunningProcess {
  model: string;
  /**
   * Launch command. Intentionally UNREAD by modelspoke — it can contain
   * the live HF token, and disagrees with
   * `/v1/models`. Declared only so the wire shape is
   * complete; no code path consumes it.
   */
  cmd?: string;
  /** Upstream base URL to probe for `/props`. */
  proxy?: string;
  state?: string;
}

/**
 * Probes a bare llama-server's `GET {baseURL}/props` endpoint and reads
 * `default_generation_settings.n_ctx` through the shared positive-integer
 * coercion (`toPositiveInt` — exported from `./metadata.js` and reused
 * here rather than duplicated).
 *
 * A bare (non-router) llama-server exposes context length only here, not
 * in `/v1/models` — this is the natural bare-server context source.
 *
 * @param baseURL - Server base URL (e.g. `http://localhost:5802`).
 * @param fetchImpl - Injectable fetch (defaults to `globalThis.fetch`).
 * @returns Context window in tokens, or undefined on any failure.
 */
export async function probeLlamaServerProps(
  baseURL: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<number | undefined> {
  const url = `${baseURL.replace(/\/$/, "")}/props`;
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      return undefined;
    }
    const props = (await response.json()) as LlamaServerProps;
    return toPositiveInt(props.default_generation_settings?.n_ctx);
  } catch {
    return undefined;
  }
}

/**
 * Probes llama-swap's root `GET {origin}/running` (NO `/v1` prefix) and
 * sub-probes each running process's `{proxy}/props` for `n_ctx`.
 *
 * Returns a map of model id → context tokens; entries without a `proxy`
 * or without a usable context are skipped (the pi `cmd`-parse fallback is
 * deliberately not ported — see file header).
 *
 * @param origin - llama-swap root URL (e.g. `http://127.0.0.1:8080`, no
 *   `/v1`).
 * @param fetchImpl - Injectable fetch (defaults to `globalThis.fetch`);
 *   used for both the `/running` fetch and the `/props` sub-probes.
 * @returns Model → context map on success (possibly empty), or undefined
 *   on any network/non-2xx/parse failure.
 */
export async function probeLlamaSwapRunning(
  origin: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<Map<string, number> | undefined> {
  const url = `${origin.replace(/\/$/, "")}/running`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
  } catch {
    return undefined;
  }
  if (!response.ok) {
    return undefined;
  }
  let payload: { running?: RunningProcess[] };
  try {
    payload = (await response.json()) as { running?: RunningProcess[] };
  } catch {
    return undefined;
  }

  const result = new Map<string, number>();
  const processes = payload.running ?? [];
  await Promise.all(
    processes.map(async (proc) => {
      if (!proc.model || !proc.proxy) {
        return;
      }
      const ctx = await probeLlamaServerProps(proc.proxy, fetchImpl);
      if (ctx !== undefined) {
        result.set(proc.model, ctx);
      }
    }),
  );
  return result;
}
