# 编写模型预设

[English](preset-authoring.md) · [README](../README.md) · [README.zh](../README.zh.md) · [design.md](design.md) · [使用](usage.zh.md)

预设是**模型*模板*的 jinja 聊天模板与请求之间的契约**："这个模板暴露
`enable_thinking` + `reasoning_effort` kwargs，恰好接受这些取值。" 服务器
只需把 `chat_template_kwargs` 透传给模板即可 — llama-server（`--jinja`）、
vLLM、sglang 都这样做 — 所以一份经过验证的模板就覆盖了所有提供它的
部署。

## 什么时候需要一个

当模型运行在没有自身能力发现的端点上时（llama-server、裸 vLLM/sglang
端口、没有扩展的 Ollama 模型），预设层会填上发现给不了的字段 — 思考级别
映射、`compat` 模板绑定、上下文窗口、最大输出 tokens。如果服务器本身
提供了该字段（llama-swap 的 `metadata`、Ollama 扩展），发现获胜，该字段
不需要预设。

## 规则

- **逐模板，绝不搞通用家族兜底。** 模型家族在经验上并不统一：仅 Qwen
  线内，一个模板会对未列出的 effort 值 `raise`，一个同门模板完全没有
  effort 词表，`preserve_thinking` 的默认值在两者之间还会**翻转**。一个
  家族级预设会在一个成员上 400，在另一个成员上静默无效。
- **保守。** 只断言模板已知能接受的级别。错误预设的三种失败模式：中途
  400（模板 raise）、静默空操作（模板忽略该 kwarg）、静默的多轮退化
  （`preserve_thinking` 默认值翻转）。
- **从模型工件里的模板编写** — HF 仓库的 `chat_template.jinja`，或 GGUF
  内嵌的 `tokenizer.chat_template` — **绝不来自文档或记忆。** README 的
  宣传文案不是模板；第一版凭记忆写的设计示例错了三处。
- **可覆盖。** 用户设置的值逐字段压过预设，永远如此。
- **可溯源。** 解析结果的来源映射报告 `preset:<id>`，预设提供的每个值
  都可审计。

## 工作流

两个开发工具干机械活；人干判断活。两者都是纯 Node 脚本（零运行时依赖，
Node 原生 TS，`Node >= 22.18`）：

```
npm run preset-draft   # node scripts/preset-draft.ts
npm run drift-check    # node scripts/preset-drift-check.ts
```

### 1. 在模型工件中定位模板

找到确切的 `chat_template.jinja`（HF hub 仓库）和/或部署实际提供的
GGUF 文件（其内嵌的 `tokenizer.chat_template` 就是 llama-server 渲染的
内容）。hub 副本和 GGUF 副本可能分叉 — 它们是不同工件，都是合法的契约
来源；provenance 条目必须钉住预设需要保持有效的所有副本。

### 2. 运行草稿工具

```
node scripts/preset-draft.ts <org/name | https://huggingface.co/org/name> \
  --match <pattern>            # 条目应匹配的 model-id 正则
```

选项：`--out <path>`（默认 cwd 下的 `preset-draft.<pattern>.md`）、
`--family qwen|gpt-oss`（强制不变量家族；默认从模板自动识别）、
`--template <local-file>` + `--context-window <n>`（离线模式：模板来自
本地文件，不抓 HF）、`--file <gguf-name>`（读哪个 GGUF）。

退出码：`0` = 草稿已写出；`1` = 抓取或推导失败（不产草稿 — 抓不到的
草稿不算通过）；`2` = 用法错误。

草稿文件包含：

- 一个**DRAFT 目录条目**，形状与 `src/presets/catalog.ts` 完全一致；
- **provenance 清单条目**，钉住模板仓库（hub 副本**按 commit** —
  永不取分支头 — GGUF 副本**按仓库文件**，因为重新量化会重传文件，而
  内嵌模板的 sha 才是契约）以及精确模板文本的 `sha256`；
- 一份 **JUDGMENT 清单**，附上相关模板摘录。

工具永远猜不出来的字段留在清单上：`input` **绝不**从模板推导（模板能
证明纯文本，但证明不了视觉），`maxTokens` 永远是**部署推导**（它是你如何
运行模型的属性，不是模板的属性）。

### 3. 审查判断项

对照摘录逐项过清单。常设项：

- **pi 级别对齐** — UI 提供的 harness 级别（`thinkingLevelMap` 的键）
  与线上实际发送的内容是否对齐？
- **退化形态** — 只有开/关的模板用退化映射 `{ "off": "low", low: "low" }`，
  且**完全不发** `reasoning_effort` 键（模板会忽略它 — 别发）；
  `enable_thinking` 极性反转（undefined = 无思考）是 `omitWhenOff` 的
  陷阱。
- **maxTokens 策略** — 选一个部署可支撑的上限；在 sglang 上
  `input + max_tokens > ctx` 会 400（不钳制），除非部署证明有富余，
  否则保持在 ctx/2 以下。
- **仅 README 有的词表** — 只出现在模型卡文案、模板里没有的 effort
  词表，**不算**模板验证过：保守的断言是文档记载的那套，并在 `notes`
  里注明模板不校验取值。
- **身份与位置** — `match` 模式（不锚定、大小写不敏感 —
  `unsloth/Qwen3.8-27B-GGUF` 也要匹配 `qwen3[._-]?8`）以及条目在目录中
  的位置（见下）。

### 4. 提交条目

把审查后的条目拷入 `src/presets/catalog.ts`，provenance 条目拷入
`src/presets/provenance.json`（填掉任何 `PENDING-PIN` commit）。
`notes` 字段承载可读的推理 — 证据摘要、判定理由 — 让后来的读者知道
*为什么*每个值是那个值。

### 5. 用漂移检查器保护它

```
npm run drift-check
```

对每个 provenance 条目：抓取每个钉住的副本（hub **按 commit**，GGUF
**按仓库文件**，本地 HF 缓存优先 — 缓存*就是*部署工件 — 否则对 GGUF
做有界读取 + 元数据解析），对精确模板文本做 sha256 并与钉子比对，重新
推导机械不变量（`enable_thinking` 极性、含别名改写的 raise-guard
effort 元组、`preserve_thinking` 析取项）并与目录条目比对。副本间差异
（hub jinja vs GGUF 内嵌）只作为**信息性分叉**报告，绝不当作漂移 —
目录必须对每个副本都有效，而不变量的逐副本重推导证明了这一点。

退出码：`0` = 全部抓取成功、sha 全匹配、无不变量发现；`1` = 漂移
**或**抓取未完成（抓不到的检查不算通过 — 与漂移分开报告）；
`2` = 用法/清单错误。`--manifest <path>` 对备用清单运行（scratch
副本 — 绝不为了测试检测而编辑仓库清单）。

工具**从不写或建议预设内容**。漂移出现时，由人对着新模板重跑本工作流。
机械上提不出来的不变量 — 级别→取值的跨词表映射、文档记载的词表、
maxTokens 策略 — 刻意不由工具断言；它们是第 3 步的人审项。

## 实例 — `gpt-oss-120b`

工件：MXFP4 GGUF（`gpt-oss.context_length: 131072`；内嵌模板 sha256
`a4c9919c…146`，16714 字符）。模板中的 token 计数：`reasoning_effort`
4 次，`enable_thinking` 0 次，`preserve_thinking` 0 次。

- **思考面只有 `reasoning_effort`。** 模板始终输出 analysis 通道；
  第 203–206 行把 `Reasoning: <effort>` 渲染进系统消息，kwarg 缺失时
  默认 `"medium"` — 缺失是有意义的状态，所以 off 态可以省略该 kwarg
  （`reasoning_effort: { "$var": "thinking.effort", omitWhenOff: true }`，
  映射里 `"off": "medium"` 让两种行为保持一致）。
- **词表 `{low, medium, high}` — 靠枚举验证，不靠记忆。** 模板不做取值
  校验（四个 `raise_exception` 都是消息格式守卫），所以保守断言是文档
  记载的三元组；未列出取值的最坏后果是进 `Reasoning:` 行 — 模型行为
  风险，绝不是 400。
- **`compat`：** `thinkingFormat: "chat-template"` + 单个
  `reasoning_effort` 绑定 — 与 qwen 预设同一方言。
- **容量：** `contextWindow: 131072` 来自 GGUF 键（与线上部署一致）；
  `maxTokens: 65536` = 经验证的部署值（ctx/2）；`input: ["text"]` —
  模板的消息循环只渲染字符串 content。

## 当判定是"不要预设"时

Qwen3-Coder-Next 的 GGUF 模板完全不引用 `enable_thinking`，也没有任何
effort kwarg — 默认层（无思考维度、无绑定）对它就是正确的。正确的产出
是**记录"不加"的决定**，附上证据（零出现计数、模板摘录），让后来的读者
不必重新争论。不是每个模型都值得一个条目。

## 端到端添加一个新模型家族

1. **工件中的模板** — hub 的 `chat_template.jinja` 和/或部署实际使用的
   GGUF 内嵌副本；记下你钉住的每个副本。
2. **`preset-draft`**，`match` 模式要（a）具体到不会吞掉相邻 id，
   （b）不锚定 + 大小写不敏感，让部署的 wire id（带 org 前缀的 GGUF
   名、`-nothink` 副本……）仍然匹配。
3. **审查判断项**（见上第 3 步）；定退化形态、maxTokens 策略、input
   声明。
4. **目录中的位置** — 目录顺序*就是*匹配契约：首个匹配获胜，最具体的
   条目在前，`match` 模式在所有 live id 上必须互斥（现有条目由单元测试
   钉住这一点）。
5. **provenance** — 钉住每个工件副本（hub 按 commit，GGUF 按仓库文件），
   附精确模板文本的 sha。
6. **`drift-check` 通过**，然后跑完整测试套件（目录单元测试和 oracle
   断言已发布家族的解析行为）。
7. **zh 描述** — 带 `notes` 的新预设 id 要在 `src/dsh/locales.ts` 的
   `PRESET_ZH` 里加对应 zh 条目（目录描述是有本地化的；zh 缺失时回退
   en，绝不空白）。
