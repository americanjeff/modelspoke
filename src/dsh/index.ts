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
import { deepEqualJson } from "./compat.js";
import { ModelspokeConfigSchema, routesOf } from "./settings.js";
import { extractFromEntry, fetchModels } from "../discovery/index.js";
import { normalizeRouteBaseUrl } from "../discovery/url.js";
import { ModelspokeAdapter } from "./adapter.js";
import { firstBootHint } from "./boot-hint.js";
import { installModelspokeChannel } from "./channel.js";

const name = "modelspoke";
const Config = ModelspokeConfigSchema;
const inject = ["llm"];

function apply(ctx: Context, config: unknown): void {
  // Plain string: dsh-llm's directory/discovery seams take the profile entry
  // id as a string (0.1.7 — the settings brand seam is gone).
  const NS = "modelspoke";
  const logger = ctx.logger("modelspoke");

  // The composed entry config (0.1.7): bundle patch → profile patch → schema
  // defaults, resolved through the exported `Config` — `routes` is volatile,
  // so it arrives as a live ref that commits in place on every card save
  // (no re-apply). `section()` unwraps the ref; the adapter and the
  // registration glue both read through this one stable thunk.
  const raw = (config ?? {}) as { routes?: unknown; overrides?: Record<string, unknown> };
  const section = (): unknown => ({
    routes:
      raw.routes !== null && typeof raw.routes === "object" && typeof (raw.routes as { get?: unknown }).get === "function"
        ? (raw.routes as { get: () => unknown }).get()
        : raw.routes ?? [],
    ...(raw.overrides === undefined ? {} : { overrides: raw.overrides }),
  });
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
  ctx.llm.registerModelDiscovery(NS, async (request, signal) => {
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
      signal,
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
  // no UI. Exactly ONE info line per boot; 0.1.7: the composed config is
  // readable at apply time, so the hint settles here (no onChange latch).
  const hint = firstBootHint(section());
  if (hint !== null) logger.info(hint);

  // Volatile commits (the card's route edits) re-run the registration glue:
  // a save commits `routes` into the running refs and emits this loader
  // event — no re-apply, no re-registration of discovery (once per
  // namespace). Not in cordis's Context Events map (loader-side event), so
  // the subscribe takes a generic cast at this boundary.
  (ctx as unknown as { on: (event: string, cb: (paths: readonly string[]) => void) => () => void }).on(
    "loader/volatile-update",
    () => {
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
  );

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

  // The loopback metadata endpoint (the discovered-catalog metadata) — a
  // silent no-op in profiles without a Connection service (tui/headless).
  installModelspokeChannel(ctx, { section, log: (line) => logger.info(line) });
}

export { apply, Config, inject, name };
