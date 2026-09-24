/**
 * Request-path context conversion: dsh `GenerateOptions` → pi-ai `Context`.
 *
 * - `options.system` → the single `systemPrompt` slot.
 * - user messages: text blocks → `TextContent`. Image blocks are RESOLVED
 *   against the durable attachment store (when mounted) and converted to
 *   `ImageContent` (base64 + media type); pi-ai's openai-completions
 *   serializer sends them as `image_url` content parts.
 * - assistant messages: when the message carries THIS adapter's stored
 *   ReplayEnvelope (`source.replayState`), the native pi-ai message is
 *   reconstructed from it (preserving thinking signatures for
 *   `preserve_thinking` multi-turn replay). Otherwise a NEUTRAL conversion
 *   rebuilds the message from durable dsh content: text/reasoning/tool-call
 *   blocks, zero usage, `stop` (pi-ai history conversion ignores usage and
 *   stopReason; content is what the wire carries).
 * - tool results: the 0.1.7 first-class tool-role message (`role: 'tool'`,
 *   `toolCallId`, `content`, `isError`) → pi-ai `ToolResultMessage`; the
 *   `toolName` pi-ai requires is
 *   recovered from the preceding assistant tool call with the matching id
 *   (the reference adapter's recovery rule). Image blocks inside the result
 *   resolve to `ImageContent` — pi-ai's openai-completions serializer lifts
 *   them into a synthesized `user` message when the model declares image
 *   input (verified in the dsh-bundled pi-ai 0.82.1 and the 0.84.2 dev
 *   dependency).
 * - system: `options.system` wins; otherwise a LEADING `system` history
 *   message supplies the prompt (the loop-built request shape) and the rest
 *   converts (the reference adapter's split rule). `developer` messages and
 *   tool-change blocks are rejected like the reference adapter.
 *
 * GUARD INVARIANT: `toPiContext` never hard-fails a turn on DURABLE history
 *   content. An image that cannot be delivered — store unmounted, per-image
 *   read failure, or an assistant-side image (pi-ai's `AssistantMessage`
 *   content union has no image member, so such blocks are unrepresentable in
 *   this request format) — becomes DETERMINISTIC placeholder text. A throw
 *   on persisted content kills the thread; a placeholder costs one model
 *   glance and the turn proceeds.
 *
 * - `options.tools` → pi-ai `Tool[]` (the JSON-Schema object passes
 *   structurally as typebox's `TSchema`).
 */

import type {
  AssistantMessage as PiAssistantMessage,
  Context as PiContext,
  ImageContent,
  Message as PiMessage,
  TextContent,
  Tool as PiTool,
  Usage as PiUsage,
} from "@earendil-works/pi-ai";
import {
  LlmError,
  type ContentBlock,
  type GenerateOptions,
  type ImageBlock,
  type Message,
  type RequestMessage,
  type ToolSchema,
} from "@deepseek-ai/dsh-llm";
import { fromReplayEnvelope } from "./replay.js";

/** The durable attachment shape one `ImageBlock` references (dsh-attachment). */
export type ImageRef = ImageBlock["attachment"];

/**
 * Structural view of the dsh durable attachment store — the target field
 * subset only (the version-skew policy: never depend on the full store
 * surface). The concrete store arrives from the host's `ctx.get("attachments")`;
 * this package holds no runtime dependency on `@deepseek-ai/dsh-attachment`.
 */
export interface AttachmentReader {
  readImage(ref: ImageRef, signal?: AbortSignal): Promise<{
    ref: ImageRef;
    data: Uint8Array;
  }>;
}

/** Per-dispatch conversion inputs (all optional — text-only history needs none). */
export interface ToPiContextDeps {
  /** The durable attachment store for this dispatch (undefined when unmounted). */
  attachments?: AttachmentReader | undefined;
  /** Abort signal for store reads (the dispatch's upstream signal). */
  signal?: AbortSignal | undefined;
  /** Sink for per-image resolution-failure log lines (default: silent). */
  log?: (line: string) => void;
}

/** Deterministic placeholder: image present, no attachment store mounted. */
export const NO_STORE_IMAGE_TEXT =
  "[image omitted: no durable attachment store is available on this route, so the image cannot be delivered to the model]";

/** Deterministic placeholder: assistant-side image (unrepresentable in pi-ai). */
export const ASSISTANT_IMAGE_TEXT =
  "[image omitted: an image stored in an earlier assistant message cannot be represented in this conversation's format]";

/** Deterministic per-attachment placeholder: read failed for ONE specific ref. */
export function unreadableImageText(ref: ImageRef): string {
  return `[image omitted: attachment ${String(ref.attachmentId)} could not be read from the store; if a file path for the image is known, re-read the file]`;
}

/** pi-ai history messages need a usage object; history usage is never sent. */
function zeroUsage(): PiUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function blockHasImage(block: ContentBlock): boolean {
  return block.type === "image";
}

/**
 * Resolve one durable image block to a sendable `ImageContent`, or a
 * deterministic placeholder `TextContent` when it cannot be delivered
 * (guard invariant — never throws).
 */
async function resolveImage(
  block: ImageBlock,
  deps: ToPiContextDeps | undefined,
): Promise<ImageContent | TextContent> {
  const store = deps?.attachments;
  if (store === undefined) return { type: "text", text: NO_STORE_IMAGE_TEXT };
  try {
    const stored = await store.readImage(block.attachment, deps?.signal);
    return {
      type: "image",
      data: Buffer.from(stored.data).toString("base64"),
      mimeType: stored.ref.mediaType,
    };
  } catch (error) {
    // A live cancellation (the dispatch's signal) is not a history defect —
    // propagate it; the request dies as aborted, not as a placeholder turn.
    if (deps?.signal?.aborted) throw error;
    deps?.log?.(
      `modelspoke: image resolution failed for attachment ${String(block.attachment.attachmentId)}: ${
        error instanceof Error ? error.message : String(error)
      } — projecting to placeholder text`,
    );
    return { type: "text", text: unreadableImageText(block.attachment) };
  }
}

/**
 * One message's image-bearing blocks → pi-ai content parts, in block order
 * (text → TextContent, image → resolved ImageContent or placeholder).
 * Block types outside text/image are ignored (as before).
 */
async function imageAwareBlocks(
  content: readonly ContentBlock[],
  deps: ToPiContextDeps | undefined,
): Promise<Array<ImageContent | TextContent>> {
  const out: Array<ImageContent | TextContent> = [];
  for (const block of content) {
    if (block.type === "text") out.push({ type: "text", text: block.text });
    else if (block.type === "image") out.push(await resolveImage(block, deps));
  }
  return out;
}

/** Neutral assistant reconstruction from durable dsh content. */
function neutralAssistant(message: Message, options: GenerateOptions): PiAssistantMessage {
  const content: PiAssistantMessage["content"] = [];
  for (const block of message.content) {
    switch (block.type) {
      case "text":
        content.push({ type: "text", text: block.text });
        break;
      case "reasoning":
        content.push({ type: "thinking", thinking: block.text });
        break;
      case "tool-call":
        // dsh ToolCallBlock.arguments is a RAW JSON string; pi-ai's ToolCall
        // takes a parsed object. A malformed stored argument degrades to {}
        // rather than failing the request (the call itself is what the model
        // already emitted — its result is already in the history).
        let argumentsObject: Record<string, unknown> = {};
        try {
          const parsed: unknown = JSON.parse(block.arguments);
          if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
            argumentsObject = parsed as Record<string, unknown>;
          }
        } catch {
          // keep {}
        }
        content.push({ type: "toolCall", id: String(block.id), name: block.name, arguments: argumentsObject });
        break;
      case "image":
        // pi-ai AssistantMessage has no image content member — the block is
        // unrepresentable in this request format. Project, never throw
        // (guard invariant).
        content.push({ type: "text", text: ASSISTANT_IMAGE_TEXT });
        break;
      case "file":
        // File blocks are projected to deterministic handle text by request
        // assembly before the adapter sees them; a raw one is a durability
        // defect — project, never throw (guard invariant).
        content.push({ type: "text", text: "[file reference omitted: projected by request assembly before adapter dispatch]" });
        break;
      case "tool-addition":
      case "tool-removal":
        // Reserved for developer-role messages (Session V4 tool changes);
        // the reference adapter rejects them in user/assistant content.
        throw new LlmError(
          "modelspoke: tool-change blocks require the developer role (pi-ai has no projection for them)",
          "UNSUPPORTED_CONTENT",
        );
    }
  }
  const source = message.source;
  const provider = source.kind === "model" ? source.provider : options.provider;
  const model = source.kind === "model" ? source.model : options.model;
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider,
    model,
    usage: zeroUsage(),
    stopReason: "stop",
    timestamp: 0,
  };
}

/** One tool-role message (0.1.7) → pi-ai toolResult. */
async function convertTool(
  message: Extract<Message, { role: "tool" }>,
  options: GenerateOptions,
  deps: ToPiContextDeps | undefined,
): Promise<PiMessage> {
  const toolCallId = String(message.toolCallId);
  // Recover the tool name from the preceding assistant tool call (the
  // reference adapter's rule): scan backward FROM THE TOOL RESULT'S OWN
  // POSITION (not from the end of the array — the result is normally the
  // last or second-to-last message, so an end-anchored scan breaks on the
  // first iteration and never sees history).
  let toolName = "tool";
  const at = options.messages.indexOf(message as RequestMessage);
  for (let i = at - 1; i >= 0; i--) {
    const prior = options.messages[i];
    if (prior?.role !== "assistant") continue;
    const match = prior.content.find((b) => b.type === "tool-call" && String(b.id) === toolCallId);
    if (match && match.type === "tool-call") {
      toolName = match.name;
      break;
    }
  }
  const content = await imageAwareBlocks(message.content, deps);
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content,
    isError: message.isError === true,
    timestamp: 0,
  };
}

/** One user-role message (or identity-free one-shot input) → pi-ai. */
function convertUser(message: RequestMessage, deps: ToPiContextDeps | undefined): Promise<PiMessage> {
  // Text-only user messages keep the historical single-joined-string shape
  // (byte-identical wire output for image-free history).
  if (!message.content.some(blockHasImage)) {
    const text = message.content
      .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    return Promise.resolve({ role: "user", content: text, timestamp: 0 });
  }
  const content = imageAwareBlocks(message.content, deps);
  return content.then((blocks) => ({ role: "user", content: blocks, timestamp: 0 }));
}

/**
 * Convert one dsh `GenerateOptions` into the pi-ai request context.
 *
 * Never rejects on durable history content (guard invariant): undeliverable
 * images project to deterministic placeholder text. Store reads may reject
 * on ABORT (the dispatch's signal) — that is a live cancellation, not a
 * history defect, and propagates.
 */
export async function toPiContext(options: GenerateOptions, deps?: ToPiContextDeps): Promise<PiContext> {
  // The reference adapter's split rule: `options.system` wins when defined;
  // otherwise a LEADING `system` history message supplies the prompt and the
  // rest converts (pi-ai carries no system role in its message union).
  const [first, ...rest] = options.messages;
  const systemPrompt =
    options.system !== undefined
      ? options.system
      : first?.role === "system"
        ? (() => {
            const text = first.content
              .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
              .map((b) => b.text)
              .join("");
            return text.length > 0 ? text : undefined;
          })()
        : undefined;
  const history = first?.role === "system" && options.system === undefined ? rest : options.messages;
  const messages: PiMessage[] = [];
  for (const message of history) {
    if (message.role === "assistant") {
      const source = message.source;
      const replay = source.kind === "model" ? fromReplayEnvelope(source.replayState) : undefined;
      messages.push(replay !== undefined ? replay : neutralAssistant(message, options));
    } else if (message.role === "tool") {
      messages.push(await convertTool(message, options, deps));
    } else if (message.role === "developer") {
      // Session V4 tool-change events (tool-addition/-removal) — no pi-ai
      // projection exists yet (the reference adapter rejects them too).
      throw new LlmError("modelspoke: developer messages are not supported yet", "UNSUPPORTED_CONTENT");
    } else {
      messages.push(await convertUser(message, deps));
    }
  }
  return {
    ...systemPrompt === undefined ? {} : { systemPrompt },
    messages,
    ...options.tools === undefined
      ? {}
      : { tools: options.tools.map(toPiTool) },
  };
}

function toPiTool(tool: ToolSchema): PiTool {
  return {
    name: tool.name,
    description: tool.description,
    // dsh ToolSchema.parameters is a plain JSON-Schema object; it passes
    // structurally as typebox's TSchema (both are JSON-Schema-shaped).
    parameters: tool.parameters as PiTool["parameters"],
  };
}
