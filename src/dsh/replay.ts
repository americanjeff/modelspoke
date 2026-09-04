/**
 * ReplayEnvelope production + consumption.
 *
 * Per the design's `stream()` scope decision: **ReplayEnvelope = the pi-ai
 * `AssistantMessage` serialized, response-level.** The whole terminal message
 * (content blocks WITH their `textSignature`/`thinkingSignature`/
 * `thoughtSignature` fields, usage, stopReason, response ids) is carried in
 * `response` as lossless JSON, and `blocks` is OMITTED — the response-level
 * message already carries per-block metadata natively, so the envelope
 * passes through harness assembly unchanged.
 *
 * On the request path ({@link fromReplayEnvelope}) an assistant history
 * message produced by this adapter is reconstructed NATIVELY from its stored
 * envelope — preserving the thinking signatures that pi-ai's history
 * conversion needs to replay prior thinking (`preserve_thinking` multi-turn
 * continuity). A foreign or malformed envelope degrades to the neutral
 * conversion in context.ts.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";

const ENVELOPE_KIND = "modelspoke";
const ENVELOPE_VERSION = 1;

interface EnvelopeResponse {
  kind: typeof ENVELOPE_KIND;
  version: typeof ENVELOPE_VERSION;
  /** The pi-ai terminal AssistantMessage, serialized (lossless JSON). */
  message: AssistantMessage;
}

/**
 * Serialize one pi-ai terminal message into the response-level envelope.
 * The message is deep-copied (JSON round-trip) so the stored envelope is
 * plain JSON detached from the live stream objects.
 */
export function toReplayEnvelope(message: AssistantMessage): { response: unknown } {
  const response: EnvelopeResponse = {
    kind: ENVELOPE_KIND,
    version: ENVELOPE_VERSION,
    message: JSON.parse(JSON.stringify(message)) as AssistantMessage,
  };
  return { response };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Recover the pi-ai `AssistantMessage` from a stored envelope, or `undefined`
 * when the stored state is not this adapter's current-kind envelope
 * (different adapter, older version, malformed) — the caller then degrades
 * to the neutral conversion.
 */
export function fromReplayEnvelope(replayState: unknown): AssistantMessage | undefined {
  if (!isPlainObject(replayState)) return undefined;
  const response = replayState.response;
  if (!isPlainObject(response)) return undefined;
  if (response.kind !== ENVELOPE_KIND || response.version !== ENVELOPE_VERSION) return undefined;
  const message = response.message;
  if (!isPlainObject(message)) return undefined;
  if (message.role !== "assistant") return undefined;
  if (!Array.isArray(message.content)) return undefined;
  if (typeof message.api !== "string" || typeof message.model !== "string") return undefined;
  if (!isPlainObject(message.usage)) return undefined;
  return message as unknown as AssistantMessage;
}
