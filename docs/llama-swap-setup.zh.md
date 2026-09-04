# llama-swap 与 modelspoke — 设置与背景

[README](../README.md) · [README.zh](../README.zh.md) · [design.md](design.md) · [English](llama-swap-setup.md)

最小 llama-swap 设置，以及两个项目的模型定义如何配合 —
llama-swap 配置模式的其余部分由 llama-swap 自身文档记载。

## llama-swap 是什么

llama-swap（[github.com/mostlygeek/llama-swap](https://github.com/mostlygeek/llama-swap)）
是一个小型、无依赖的 Go 程序，位于本地模型服务器前面，
无论你实际运行多少个模型，都呈现**一个稳定的 OpenAI（和 Anthropic）
兼容端点** — 默认 `http://127.0.0.1:8080/v1`。
你在一个 `llama-swap.yaml` 里声明每个模型 —
启动其后端的命令、可选的空闲卸载 `ttl`、
以及描述模型能做什么的可选 `capabilities` / `metadata` 块；
当请求指名一个后端未服务的模型时，llama-swap
停止当前后端、启动正确的后端、然后转发请求（"swap"）。
项目的 [README](https://github.com/mostlygeek/llama-swap) 和
`config.example.yaml` 记载了完整的配置模式 —
`cmd`/`cmdStop` 后端、`ttl`、`routing` 并发规则、`macros`、`env`、
`aliases`、`filters`、`profiles`、`peers` —
所以本文只覆盖最小设置，以及 modelspoke 如何读取该端点。

两点让它成为 modelspoke 的一等路由器。因为端点永不改变，
每个 agent、CLI 工具和 UI 配置 llama-swap **一次** —
一个 base URL，模型用其配置的 id 寻址；
添加、移除或重新调校一个模型就是一个 `llama-swap.yaml` 编辑
加重启，任何 agent 配置中都没有东西改变。
而且 llama-swap 通过 OpenAI `/v1/models` 表面公布它的知识：
每个条目携带 `architecture`、`capabilities`、`supported_parameters`、
`status`（`loaded`/`unloaded`），
以及回显配置中每模型 `metadata:` 的 `meta.llamaswap` 块 —
所以客户端可以自省每个模型接受什么，而不是猜。

`cmd` / `cmdStop` / `env` 绝不被 `/v1/models` 暴露 —
只有 `capabilities` + `metadata`（渲染为 `meta.llamaswap`）—
所以通过 wire 提供服务不泄漏秘密。
把秘密留在服务环境中（`${env.YOUR_HF_TOKEN}` 这样的宏），
绝不放在 yaml 里。

## 简单设置

最小但形状真实的 `llama-swap.yaml` —
新手真正需要的字段（`cmd`），
加上 `capabilities` / `metadata` 让 modelspoke 这样的客户端
可以自省模型：

```yaml
models:
  # key 就是 agent 在 `model:` 中请求的模型 id。
  qwen3-coder:
    # ${PORT} 由 llama-swap 自动分配（默认从 5800 开始）。
    cmd: |
      llama-server --host 127.0.0.1 --port ${PORT}
      --hf-repo unsloth/Qwen3-Coder-Next-GGUF:UD-Q6_K_XL
      --jinja --cont-batching --flash-attn on
      --ctx-size 262144 --parallel 1
    ttl: 3600            # 空闲 1 小时后卸载（秒）；0 = 永不
    capabilities:
      in: [text]
      out: [text]
      tools: true
      context: 262144
    metadata:
      maxTokens: 131072

  gemma-mini:
    cmd: |
      llama-server --host 127.0.0.1 --port ${PORT}
      --hf-repo unsloth/gemma-4-E4B-it-GGUF:Q4_K_M
      --jinja --cont-batching --flash-attn on
    ttl: 1800
    capabilities:
      in: [text]
      out: [text]
```

llama-swap 配置中其它一切字段都是可选的，逐步添加
（`healthCheckTimeout`、`logToStdout`、`macros`、`env`、`cmdStop`、
`proxy`、`aliases`、`filters`、`routing`、`peers`、`profiles` —
见项目的 `config.example.yaml`）。
运行它（`llama-swap --config llama-swap.yaml --listen 127.0.0.1:8080`），
每个 agent 指向的那一行端点就是 `http://127.0.0.1:8080/v1`
（模型 id 在请求的 `model` 字段里）。
在 dsh 中：一个提供方，`baseURL: http://127.0.0.1:8080/v1` — 完成。

## 端点实际提供什么

一条活的 `GET /v1/models` 条目（思考 + 视觉模型 —
所有模型都是这种形状）：

```json
{
  "id": "qwen3.8-27b-6000pro",
  "owned_by": "llama-swap",
  "architecture": {
    "input_modalities": ["text", "image"],
    "modality": "text+image->text",
    "output_modalities": ["text"]
  },
  "capabilities": { "function_calling": true, "vision": true },
  "supported_parameters": ["tools", "tool_choice"],
  "context_length": 262144,
  "meta": {
    "llamaswap": {
      "type": "model",
      "reasoning": true,
      "maxTokens": 65536,
      "thinkingLevelMap": {
        "off": "low", "minimal": null, "low": "low",
        "medium": "medium", "high": null, "xhigh": "xhigh", "max": null
      },
      "compat": {
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false,
        "thinkingFormat": "chat-template",
        "chatTemplateKwargs": {
          "enable_thinking": { "$var": "thinking.enabled" },
          "reasoning_effort": { "$var": "thinking.effort", "omitWhenOff": true },
          "preserve_thinking": true
        }
      }
    },
    "n_ctx": 262144
  },
  "status": { "value": "loaded" }
}
```

yaml → wire 的映射：`capabilities.in` → `architecture.input_modalities`
（+ 推导出的 `modality` 字符串，以及 `capabilities.vision: true`）；
`capabilities.context` → 顶层 `context_length` **且**镜像为
`meta.n_ctx`；`capabilities.tools` → `capabilities.function_calling` +
`supported_parameters: [tools, tool_choice]`；
整个 `metadata:` 块 → `meta.llamaswap`（另加 `type: "model"`）。
`cmd` / `cmdStop` / `env` 绝不出现在 wire 上。

## modelspoke 从中读取什么

modelspoke 的发现级
（[解析链条](usage.zh.md#解析链条)的第二级）
把这些精确字段映射到每个 `/v1/models` 条目：

| 规范字段 | 读取自（优先级顺序） |
|---|---|
| `name` | `meta.llamaswap.name` → 顶层 `name`（否则模型 `id`） |
| `input` | `architecture.input_modalities`（text/image），`capabilities.vision: true` 时加 `image` |
| `reasoning` | **仅当** `meta.llamaswap.reasoning === true` 时为 `true`；缺失 → 预设级决定 |
| `thinkingLevelMap` | `meta.llamaswap.thinkingLevelMap`（`null` = "声明不支持"，丢弃） |
| `compat` | `meta.llamaswap.compat` **逐字**，包括 `chatTemplateKwargs` `$var` 绑定 |
| `maxTokens` | `output_length` → `max_tokens` → `meta.llamaswap.maxTokens` → 嵌套变体 |
| `contextWindow` | `context_length` → `max_context_length` → `context_window` → `max_model_len`（可选探测）→ `meta.llamaswap.*` 变体 → `meta.n_ctx` → 嵌套 `metadata` 变体 |

因为完整声明的模型的 wire 条目携带 `context_length`、`meta.n_ctx`、
`meta.llamaswap.maxTokens`、`reasoning: true`、
完整 `thinkingLevelMap` 和完整 `compat` 块，
**它的全部推理元数据仅凭活端点就在第二级解析** —
这就是"一个模型定义流入两层"的说法，
用一条 `curl -H "Authorization: Bearer $KEY" http://127.0.0.1:8080/v1/models`
即可验证。

对于发现看不到的模型（什么都不公布的裸服务器），
在 Modelspoke 区块中按上表的字段映射写一条每模型 override —
DISCOVERY 层是每模型元数据的唯一来源，发现看不到时由 override 补足。
（早期版本的首次使用导入曾直接从 `llama-swap.yaml` 播种这些条目；
该深度路径已退役 — 路由器把 yaml 元数据渲染进 wire，与发现层冗余。）

上面的 `thinkingFormat: "chat-template"` + `$var` 机制是共享的
`@earendil-works/pi-ai` 词汇 — modelspoke 逐字透传的同样字符串 —
所以思考模型的旋钮在 dsh 和 pi 中行为一致，
在 `llama-swap.yaml` 中配置一次即可。
