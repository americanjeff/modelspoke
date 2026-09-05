[![npm version](https://img.shields.io/npm/v/modelspoke)](https://www.npmjs.com/package/modelspoke)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

# ![modelspoke icon](assets/logo/modelspoke-icon.png) modelspoke

English | [中文](README.zh.md)

A plugin for DeepSeek Harness for managing connections to local, OpenAI-compatible model servers.
It is an improved replacement for the stock dsh custom provider setup: it discovers your servers and
models instead of requiring hand-written provider blocks and per-model fields, and provides the
capabilities the stock setup lacks.

## Features

**First-class llama-swap and Ollama support**

The router llama-swap is highly recommended for local model hoarders since it can serve as a source of truth for model capabilities across harnesses. modelspoke understands the capability data that llama-swap adds to its extended OpenAI-compatible endpoint. Capability discovery also supports Ollama's API extensions.

**Presets for common models**

To help out with endpoints that don't have full capability discovery (e.g. llama-server, vLLM, sglang) modelspoke includes a table of capabilities for common base models to use in initial configuration.

**Full-featured setup UI**

Setup is easy to use and covers all the day-to-day fields (the deep template-contract fields — `compat` — stay hand-edited in the file). Allows for overriding presets and discovered capabilities and maintaining multiple setting profiles of the same underlying model.

**Reasoning effort levels**

dsh custom provider functionality doesn't afford any way to set reasoning effort. Modelspoke can discover the supported effort levels and allows customizing the map from the UI effort setting to the model supported setting.

**Image input**

Models with multimodal capabilities are great but if you add them via the dsh custom provider setup that functionality is not available. Modelspoke can discover image input capability or allow you to specify it. It also includes a fix for the lack of upstream support for inline images in session chat.

## Installation & setup

Prerequisite: a recent dsh with the `dsh plugin` command.

1. **Install:** dsh installs plugins with a tool called pnpm. If you don't
   have it yet, install it first:

   ```console
   npm install --global pnpm
   ```

   Then one command for each profile where you will use local models:

   ```console
   dsh plugin --profile web add modelspoke
   dsh plugin --profile headless add modelspoke
   ```

2. **Restart dsh if it is running**, so it picks up the plugin.

3. **Open the Modelspoke settings card.** In the dsh web UI, the gear at
   the bottom of the left rail opens Settings; select **Plugins** in the
   sidebar, expand the **Modelspoke** card in the Plugin configuration tab,
   then **+ Add provider**:

   ![Settings → Plugins → Modelspoke card — the provider row and the provider card](docs/screenshots/modelspoke-01-section.png)

4. **Point it at your server.** Set the provider's name, its base URL, the
   *environment variable name* holding the API key (omit for keyless local
   servers — no auth header is sent in that case), and an optional default
   effort (`minimal` … `max`) — then commit with the card's **Apply**
   button. The row's status dot goes green once the model fetch succeeds.

5. **Configure per model where you want to.** Expanding a provider fetches
   its model list; each model row has a chevron that opens an editable
   detail (context window, max output tokens, the thinking-level map,
   nothink, image input, reasoning effort):

   ![A model's editable detail inside the provider card](docs/screenshots/modelspoke-02-detail.png)

   The model list is the curation — a model is addressable by the agent
   only while it is in the list; clearing a detail field releases that
   field back down the resolution chain.

## Appendix

- [docs/usage.md](docs/usage.md) — using modelspoke after install: the
  resolution chain, the per-model detail, nothink models, images, and the
  `settings.yaml` shape
- [docs/preset-authoring.md](docs/preset-authoring.md) — authoring a model
  preset from the template in the artifact (the `preset-draft` /
  `drift-check` workflow)
- [docs/llama-swap-setup.md](docs/llama-swap-setup.md) — the minimal
  llama-swap setup, and how modelspoke reads llama-swap's extended endpoint
- [docs/design.md](docs/design.md) — architecture and decisions
- [docs/provider-details.md](docs/provider-details.md) — the provider
  reference: why the five backends, where each capability value comes from,
  per-provider quirks
- [docs/dsh-plugin-guidance.md](docs/dsh-plugin-guidance.md) — integrating
  with dsh: the adapter registration contract, the web-UI half, settings
  writes, and the read_image tool-view workaround
