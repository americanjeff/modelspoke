/**
 * pi-ai `AssistantMessageEvent` → dsh `StreamChunk` translation.
 *
 * Event table (docs/dsh-plugin-guidance.md §1.3, the reference
 * PiAiAdapter's table verbatim in intent):
 *
 * | pi-ai event       | harness chunk                                            |
 * |-------------------|----------------------------------------------------------|
 * | start             | (skipped)                                                |
 * | text_start        | block-start (text)                                       |
 * | text_delta        | text-delta                                               |
 * | text_end          | block-end (text)                                         |
 * | thinking_start    | block-start (reasoning)                                  |
 * | thinking_delta    | reasoning-delta                                          |
 * | thinking_end      | block-end (reasoning)                                    |
 * | toolcall_start    | block-start (tool-call)                                  |
 * | toolcall_delta    | tool-call-delta (raw JSON string argumentsDelta)         |
 * | toolcall_end      | block-end (tool-call; arguments JSON.stringify'd — RAW)  |
 * | done              | usage THEN finish (+ replayState); return                |
 * | error             | usage THEN finish; return (no replayState)               |
 *
 * Contract points:
 * - usage is emitted BEFORE the terminal finish, and NOTHING after it
 *   (both `done` and `error` terminate immediately after their usage).
 * - Tool arguments remain RAW JSON STRINGS at every boundary
 *   (`argumentsDelta`, the assembled `ToolCallBlock.arguments`).
 * - A source stream that ends with neither `done` nor `error` throws
 *   `STREAM_CLOSED` (the runtime turns adapter throws into terminal
 *   error/aborted chunks).
 * - reasoning is folded into `outputTokens` by pi-ai; cache fields are
 *   emitted only when non-zero (TokenUsage fields are optional).
 */

import type {
  AssistantMessage,
  AssistantMessageEvent,
} from "@earendil-works/pi-ai";
import { isContextOverflow } from "@earendil-works/pi-ai";
import {
  CallId,
  EMPTY_RESPONSE_CODE,
  CONTEXT_WINDOW_EXCEEDED_CODE,
  QUOTA_EXCEEDED_CODE,
  isContextWindowExceededError,
  isQuotaExceededError,
  LlmError,
} from "@deepseek-ai/dsh-llm";
import type { FinishReason, StreamChunk, TokenUsage } from "@deepseek-ai/dsh-llm";

/** Fold pi-ai usage into dsh TokenUsage (reasoning already inside output). */
export function mapUsage(usage: AssistantMessage["usage"]): TokenUsage {
  return {
    inputTokens: usage.input,
    outputTokens: usage.output,
    ...(usage.cacheRead > 0 ? { cacheReadTokens: usage.cacheRead } : {}),
    ...(usage.cacheWrite > 0 ? { cacheWriteTokens: usage.cacheWrite } : {}),
  };
}

/** Classify a pi-ai error message into a provider-neutral machine code. */
function classifyPiAiError(text: string): string {
  if (isQuotaExceededError(text)) return QUOTA_EXCEEDED_CODE;
  const t = text.toLowerCase();
  if (/\b(401|403)\b/.test(t) || /unauthoriz|forbidden|invalid api key|authentication|credential/i.test(t)) {
    return "AUTH";
  }
  if (/\b429\b/.test(t) || /rate.?limit/i.test(t)) return "RATE_LIMIT";
  if (/\b(400|413)\b/.test(t) || /bad request|payload too large|invalid (request|parameter)/i.test(t)) {
    return "INVALID_REQUEST";
  }
  if (/\b5\d{2}\b/.test(t) || /internal server error|bad gateway|service unavailable|server error/i.test(t)) {
    return "SERVER";
  }
  if (/timed? ?out|timeout|etimedout|deadline exceeded/i.test(t)) return "TIMEOUT";
  if (/fetch failed|socket|econnreset|econnrefused|eai_again|premature|network|undici|epipe/i.test(t)) {
    return "TRANSPORT";
  }
  return "PI_AI_ERROR";
}

/** Extract an HTTP status the error text mentions, when it does. */
function statusFromError(text: string): number | undefined {
  const match = /\b([1-5]\d{2})\b/.exec(text);
  return match ? Number(match[1]) : undefined;
}

/**
 * Map a pi-ai terminal message to the dsh finish reason. Overflow is
 * detected FIRST (a stop/length terminal can still be an overflow); a `stop`
 * with zero content blocks is the degenerate EMPTY_RESPONSE error, not a
 * clean stop.
 */
export function mapStopReason(message: AssistantMessage, contextWindow: number): FinishReason {
  const detail = message.errorMessage ?? "";
  const overflow =
    isContextOverflow(message, contextWindow) || isContextWindowExceededError(detail);
  if (overflow) {
    return {
      kind: "error",
      failure: { code: CONTEXT_WINDOW_EXCEEDED_CODE, message: detail || "context window exceeded" },
    };
  }
  switch (message.stopReason) {
    case "stop":
      if (message.content.length === 0) {
        return {
          kind: "error",
          failure: { code: EMPTY_RESPONSE_CODE, message: "model returned no content blocks" },
        };
      }
      return { kind: "stop" };
    case "length":
      return { kind: "max-tokens" };
    case "toolUse":
      return { kind: "tool-calls" };
    case "aborted":
      return { kind: "aborted", failure: { code: "ABORTED", message: detail || "aborted" } };
    case "error": {
      const code = classifyPiAiError(detail || "provider error");
      const status = statusFromError(detail);
      return {
        kind: "error",
        failure: { code, message: detail || "provider error", ...(status !== undefined ? { status } : {}) },
      };
    }
    default:
      // "pending" / "deferred" are not terminal; reaching one is a pi-ai
      // protocol violation — surface it as an error, never a clean stop.
      return {
        kind: "error",
        failure: { code: "PI_AI_ERROR", message: `unexpected terminal stop reason "${message.stopReason}"` },
      };
  }
}

/**
 * Translate one pi-ai event stream into dsh StreamChunks. Yields the terminal
 * usage → finish pair and returns (nothing is yielded after the finish).
 *
 * @throws {LlmError} `STREAM_CLOSED` when the source ends without done/error.
 */
export async function* toStreamChunks(
  events: AsyncIterable<AssistantMessageEvent>,
  contextWindow: number,
  replayOf: (message: AssistantMessage) => { response: unknown } | undefined,
): AsyncGenerator<StreamChunk> {
  // toolcall_start carries only the contentIndex; the call id/name live on
  // the partial's content block. Capture per index for the delta/end chunks.
  const toolCalls = new Map<number, { id: string; name: string }>();
  let terminal = false;

  for await (const event of events) {
    switch (event.type) {
      case "start":
        break;
      case "text_start":
        yield { type: "block-start", index: event.contentIndex, blockType: "text" };
        break;
      case "text_delta":
        yield { type: "text-delta", index: event.contentIndex, text: event.delta };
        break;
      case "text_end":
        yield { type: "block-end", index: event.contentIndex, block: { type: "text", text: event.content } };
        break;
      case "thinking_start":
        yield { type: "block-start", index: event.contentIndex, blockType: "reasoning" };
        break;
      case "thinking_delta":
        yield { type: "reasoning-delta", index: event.contentIndex, text: event.delta };
        break;
      case "thinking_end":
        yield { type: "block-end", index: event.contentIndex, block: { type: "reasoning", text: event.content } };
        break;
      case "toolcall_start": {
        const block = event.partial.content[event.contentIndex];
        if (block && block.type === "toolCall") {
          toolCalls.set(event.contentIndex, { id: block.id, name: block.name });
        }
        yield { type: "block-start", index: event.contentIndex, blockType: "tool-call" };
        break;
      }
      case "toolcall_delta": {
        const captured = toolCalls.get(event.contentIndex);
        const block = event.partial.content[event.contentIndex];
        yield {
          type: "tool-call-delta",
          index: event.contentIndex,
          id: CallId(captured?.id ?? (block && block.type === "toolCall" ? block.id : "")),
          name: captured?.name ?? (block && block.type === "toolCall" ? block.name : undefined),
          argumentsDelta: event.delta,
        };
        break;
      }
      case "toolcall_end": {
        const toolCall = event.toolCall;
        toolCalls.delete(event.contentIndex);
        yield {
          type: "block-end",
          index: event.contentIndex,
          block: {
            type: "tool-call",
            id: CallId(toolCall.id),
            name: toolCall.name,
            // pi-ai delivers a PARSED object; the harness wants the RAW JSON
            // string the model produced — re-serialize at this boundary.
            arguments: JSON.stringify(toolCall.arguments),
          },
        };
        break;
      }
      case "done": {
        yield { type: "usage", usage: mapUsage(event.message.usage) };
        const replay = replayOf(event.message);
        yield {
          type: "finish",
          reason: mapStopReason(event.message, contextWindow),
          ...replay === undefined ? {} : { replayState: replay },
        };
        terminal = true;
        return;
      }
      case "error": {
        // Terminal: usage (zero on early failure) then finish, no replay.
        yield { type: "usage", usage: mapUsage(event.error.usage) };
        yield { type: "finish", reason: mapStopReason(event.error, contextWindow) };
        terminal = true;
        return;
      }
    }
  }

  if (!terminal) {
    throw new LlmError("modelspoke: pi-ai event stream ended without done/error", "STREAM_CLOSED");
  }
}
