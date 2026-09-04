/**
 * modelspoke — dsh plugin entry (Cordis bundle plugin).
 *
 * Loads the `modelspoke:` settings namespace, owns the dynamic provider
 * routes (user-chosen keys) and the model-discovery registration, and
 * registers the raw {@link ModelspokeAdapter} for whatever routes exist.
 *
 * Registration lifecycle (docs/dsh-plugin-guidance.md §1): the
 * WHOLE route set is re-registered on every committed settings change
 * (`handle.replace(...)` on the adapter AND the directory handles — one
 * replace per change, exactly the reference's
 * `ensureRegistrationFacts`/`ensureDirectory` pattern), because
 * `registerAdapter` is all-or-nothing and refuses a provider already owned.
 * An EMPTY initial registration is illegal, so registration is skipped until
 * the first route exists (an empty `replace` once registered is legal and
 * drops the routes back to dormant). `registerModelDiscovery` runs ONCE per
 * namespace — a second registration throws `DUPLICATE_DISCOVERY` — and the
 * discovery function reads the CURRENT settings on every call.
 *
 * No config row is shipped in dsh.cordis.yml: the composition entry is
 * absent and the schema defaults ({routes: [], overrides: {}}) apply — the
 * bundle boots dormant, exactly like `llm-pi-ai` with zero routes, and the
 * user's `modelspoke:` settings section (or the Tier-3 migration) brings the
 * routes to life.
 */

import type { Context } from "@deepseek-ai/cordis";
import { LlmError } from "@deepseek-ai/dsh-llm";
import type {
  AdapterRegistrationHandle,
  DirectoryRegistrationHandle,
  LlmConfigurableProvider,
} from "@deepseek-ai/dsh-llm";
import { deepEqualJson, installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";
import { extractFromEntry, fetchModels } from "../discovery/index.js";
import { normalizeRouteBaseUrl } from "../discovery/url.js";
import { ModelspokeAdapter } from "./adapter.js";
import { firstBootHint } from "./boot-hint.js";
import { installModelspokeChannel } from "./channel.js";
import { assertServiceable, ModelspokeConfigSchema, routesOf } from "./settings.js";

const name = "modelspoke";
const Config = ModelspokeConfigSchema;
const inject = ["llm"];

function apply(ctx: Context, config: unknown): void {
  const NS = settingsNamespace("modelspoke");
  const logger = ctx.logger("modelspoke");

  // The resolved settings-scope source while a settings service is attached;
  // the composition entry (schema defaults when absent) until then.
  let source: () => unknown = () => config ?? {};
  // One stable thunk for BOTH the registration glue and the adapter: the adapter
  // captured the thunk by value at construction, so reassigning the outer
  // variable would not reach it — this wrapper always reads `source`.
  const section = (): unknown => source();
  const adapter = new ModelspokeAdapter({
    settings: section,
    log: (line) => logger.info(line),
    // The durable attachment store (host-provided `ctx.attachments`), read
    // per dispatch — NOT an `inject` dependency: modelspoke boots and
    // streams fine without it, and image blocks then project to
    // deterministic placeholder text instead of sending.
    resolveAttachments: () => ctx.get("attachments"),
  });

  let registration: AdapterRegistrationHandle | undefined;
  let registeredFacts: unknown = undefined;
  const ensureRegistration = (): void => {
    const routes = routesOf(section()).map((route) => route.name);
    const facts = { routes };
    if (deepEqualJson(facts, registeredFacts)) return;
    if (registration === undefined) {
      if (routes.length === 0) {
        // An empty INITIAL registration is illegal — stay dormant.
        registeredFacts = facts;
        return;
      }
      registration = ctx.llm.registerAdapter(routes, adapter);
    } else {
      registration.replace(routes); // an empty replace once registered is legal
    }
    registeredFacts = facts;
  };

  // One LlmConfigurableProvider per route (declared: the adapter knows the
  // route only because config named it), keyed to the route's array slot.
  let directory: DirectoryRegistrationHandle | undefined;
  let directoryFacts: unknown = undefined;
  const ensureDirectory = (): void => {
    const entries: LlmConfigurableProvider[] = routesOf(section()).map((route, index) => ({
      provider: route.name,
      displayName: route.name,
      settingsNs: NS,
      settingsPath: ["routes", String(index)],
      declared: true,
    }));
    if (deepEqualJson(entries, directoryFacts)) return;
    if (entries.length === 0 && directory === undefined) {
      directoryFacts = entries;
      return;
    }
    if (directory === undefined) {
      directory = ctx.llm.registerConfigurableProviders(entries);
    } else {
      directory.replace(entries);
    }
    directoryFacts = entries;
  };

  // ONE registration per namespace (DUPLICATE_DISCOVERY on a second): the
  // function reads the CURRENT settings on every call, so route edits are
  // picked up without re-registering.
  ctx.llm.registerModelDiscovery(NS, async (request) => {
    const routes = routesOf(section());
    const route =
      (request.provider !== undefined
        ? routes.find((r) => r.name === request.provider)
        : undefined) ??
      (request.baseURL !== undefined
        ? {
            name: request.provider ?? "modelspoke-discovery",
            baseURL: request.baseURL,
            apiKeyEnv: undefined,
          }
        : undefined);
    if (route === undefined) {
      throw new LlmError(
        "modelspoke: no route to interrogate for model discovery (the `modelspoke:` section has no matching route)",
        "INVALID_DISCOVERY",
      );
    }
    const apiKey =
      request.apiKey ??
      (route.apiKeyEnv !== undefined ? process.env[route.apiKeyEnv] || undefined : undefined);
    const entries = await fetchModels(
      normalizeRouteBaseUrl(route.baseURL),
      apiKey,
      request.signal,
    );
    return entries.map((entry) => {
      const info = extractFromEntry(entry);
      const canonical = info.discoveredCanonical;
      return {
        id: info.id,
        ...info.name === undefined ? {} : { name: info.name },
        ...canonical?.contextWindow === undefined ? {} : { contextWindow: canonical.contextWindow },
        ...canonical?.maxTokens === undefined ? {} : { maxTokens: canonical.maxTokens },
      };
    });
  });

  // A dormant boot (zero routes) is otherwise silent — no routes, no rows,
  // no UI. Exactly ONE info line per boot; settling on the first onChange
  // is the first moment the initial section is known (it is not readable
  // at apply time — see src/dsh/boot-hint.ts).
  let hintSettled = false;
  const settleHint = (): void => {
    if (hintSettled) return;
    hintSettled = true;
    const hint = firstBootHint(section());
    if (hint !== null) logger.info(hint);
  };

  installSettingsSection(ctx, NS, ModelspokeConfigSchema, (config ?? {}) as never, {
    validate: (value) => assertServiceable(value),
    setSource: (s) => {
      source = s;
    },
    onChange: () => {
      settleHint(); // once per boot, from the initial (now-live) section
      try {
        ensureRegistration();
      } catch (error) {
        logger.error(
          `modelspoke: adapter route registration failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      try {
        ensureDirectory();
      } catch (error) {
        logger.error(
          `modelspoke: provider directory registration failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  });

  // Initial registration from the composition entry (dormant when empty).
  // Contained exactly like the onChange path: a route name colliding with a
  // hand-declared provider another adapter family owns (the first-use
  // import creates exactly this state until the source block is deleted)
  // must not take the whole plugin down — the colliding route stays
  // unregistered and the rest of the plugin keeps serving.
  try {
    ensureRegistration();
  } catch (error) {
    logger.error(
      `modelspoke: adapter route registration failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    ensureDirectory();
  } catch (error) {
    logger.error(
      `modelspoke: provider directory registration failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // The loopback RPC channel (onboarding readiness + first-use import) —
  // a silent no-op in profiles without a Connection service (tui/headless).
  installModelspokeChannel(ctx, { section, log: (line) => logger.info(line) });
}

export { apply, Config, inject, name };
