/**
 * Image conversion + guard invariant for `toPiContext` (v0.1.1 fix):
 *
 * - an UNDELIVERABLE image never fails the turn (guard invariant — a throw
 *   on durable history content kills the thread): no store, per-image read
 *   failure, and assistant-side images (unrepresentable in pi-ai's
 *   `AssistantMessage` content union) all project to DETERMINISTIC
 *   placeholder text;
 * - a live ABORT during a store read propagates (cancellation, not a
 *   history defect).
 */

import { describe, expect, it } from "vitest";
import { CallId, createMessage, createUserMessage } from "@deepseek-ai/dsh-llm";
import type { GenerateOptions, ImageBlock, Message } from "@deepseek-ai/dsh-llm";
import {
  ASSISTANT_IMAGE_TEXT,
  NO_STORE_IMAGE_TEXT,
  toPiContext,
  unreadableImageText,
} from "../src/dsh/context.js";
import type { AttachmentReader, ImageRef } from "../src/dsh/context.js";

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_B64 = Buffer.from(PNG_BYTES).toString("base64");

function imageRef(id: string): ImageRef {
  return {
    attachmentId: id,
    mediaType: "image/png",
    bytes: PNG_BYTES.length,
    width: 1,
    height: 1,
  } as unknown as ImageBlock["attachment"];
}

const REF = imageRef("sha256:abcd1234ef567890");

class FakeStore implements AttachmentReader {
  readonly calls: string[] = [];
  /** refs (by attachmentId) whose read should fail. */
  readonly failFor: ReadonlySet<string>;

  constructor(failFor: Iterable<string> = []) {
    this.failFor = new Set(failFor);
  }

  async readImage(ref: ImageRef): Promise<{ ref: ImageRef; data: Uint8Array }> {
    this.calls.push(String(ref.attachmentId));
    if (this.failFor.has(String(ref.attachmentId))) throw new Error("storage gone");
    return { ref, data: PNG_BYTES };
  }
}

function opts(messages: Message[]): GenerateOptions {
  return { provider: "unit", model: "unit-model", messages };
}

function imageBlock(ref: ImageRef = REF): Extract<Message["content"][number], { type: "image" }> {
  return { type: "image", attachment: ref } as Extract<Message["content"][number], { type: "image" }>;
}

describe("toPiContext — image resolution", () => {
  it("user image resolves to base64 ImageContent, order preserved with text", async () => {
    const store = new FakeStore();
    const msg = createUserMessage({
      content: [{ type: "text", text: "What is this?" }, imageBlock()],
      source: { kind: "user" },
    });
    const ctx = await toPiContext(opts([msg]), { attachments: store });
    expect(ctx.messages).toHaveLength(1);
    const user = ctx.messages[0]!;
    expect(user.role).toBe("user");
    if (user.role !== "user") throw new Error("unreachable");
    expect(user.content).toEqual([
      { type: "text", text: "What is this?" },
      { type: "image", data: PNG_B64, mimeType: "image/png" },
    ]);
    expect(store.calls).toEqual(["sha256:abcd1234ef567890"]);
  });

  it("text-only user history keeps the joined-string shape and never touches the store", async () => {
    const store = new FakeStore();
    const msg = createUserMessage({
      content: [{ type: "text", text: "Hello?" }],
      source: { kind: "user" },
    });
    const ctx = await toPiContext(opts([msg]), { attachments: store });
    const user = ctx.messages[0]!;
    expect(user).toEqual({ role: "user", content: "Hello?", timestamp: 0 });
    expect(store.calls).toEqual([]);
  });

  it("tool-result image resolves alongside the result's text (toolName recovery intact)", async () => {
    const store = new FakeStore();
    const callId = CallId("call-img-1");
    const assistantCall = createMessage({
      role: "assistant",
      content: [{ type: "tool-call", id: callId, name: "read_image", arguments: '{"file_path":"/x.png"}' }],
      source: { kind: "model", provider: "unit", model: "unit-model" },
    });
    const toolResult = createMessage({
      role: "user",
      content: [
        {
          type: "tool-result",
          toolCallId: callId,
          content: [{ type: "text", text: "path: /x.png" }, imageBlock()],
        },
      ],
      source: { kind: "tool", callId },
    });
    const ctx = await toPiContext(opts([assistantCall, toolResult]), { attachments: store });
    expect(ctx.messages).toHaveLength(2);
    const result = ctx.messages[1]!;
    expect(result.role).toBe("toolResult");
    if (result.role !== "toolResult") throw new Error("unreachable");
    expect(result.toolCallId).toBe("call-img-1");
    expect(result.toolName).toBe("read_image");
    expect(result.content).toEqual([
      { type: "text", text: "path: /x.png" },
      { type: "image", data: PNG_B64, mimeType: "image/png" },
    ]);
  });

  it("toolName recovers when the tool result is second-to-last (the real request shape: new user message after it)", async () => {
    const callId = CallId("call-img-3");
    const assistantCall = createMessage({
      role: "assistant",
      content: [{ type: "tool-call", id: callId, name: "read_image", arguments: "{}" }],
      source: { kind: "model", provider: "unit", model: "unit-model" },
    });
    const toolResult = createMessage({
      role: "user",
      content: [{ type: "tool-result", toolCallId: callId, content: [{ type: "text", text: "42" }] }],
      source: { kind: "tool", callId },
    });
    const nextUser = createUserMessage({ content: [{ type: "text", text: "and now?" }], source: { kind: "user" } });
    const ctx = await toPiContext(opts([assistantCall, toolResult, nextUser]));
    const result = ctx.messages[1]!;
    if (result.role !== "toolResult") throw new Error("unreachable");
    expect(result.toolName).toBe("read_image");
    expect(result.toolCallId).toBe("call-img-3");
  });
});

describe("toPiContext — guard invariant (never fail a turn on durable history)", () => {
  it("user image WITHOUT a store → deterministic placeholder, no throw", async () => {
    const msg = createUserMessage({
      content: [{ type: "text", text: "see this" }, imageBlock()],
      source: { kind: "user" },
    });
    const ctx = await toPiContext(opts([msg]));
    const user = ctx.messages[0]!;
    if (user.role !== "user") throw new Error("unreachable");
    expect(user.content).toEqual([
      { type: "text", text: "see this" },
      { type: "text", text: NO_STORE_IMAGE_TEXT },
    ]);
  });

  it("user image with a FAILING store → per-attachment placeholder (deterministic, id-bearing), no throw", async () => {
    const store = new FakeStore(["sha256:abcd1234ef567890"]);
    const lines: string[] = [];
    const msg = createUserMessage({ content: [imageBlock()], source: { kind: "user" } });
    const ctx = await toPiContext(opts([msg]), { attachments: store, log: (l) => lines.push(l) });
    const user = ctx.messages[0]!;
    if (user.role !== "user") throw new Error("unreachable");
    expect(user.content).toEqual([{ type: "text", text: unreadableImageText(REF) }]);
    const ctx2 = await toPiContext(opts([msg]), { attachments: store });
    expect(ctx2.messages[0]).toEqual(user);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("sha256:abcd1234ef567890");
    expect(lines[0]).toContain("image resolution failed");
  });

  it("tool-result image without a store → placeholder INSIDE the tool result, no throw", async () => {
    const callId = CallId("call-img-2");
    const toolResult = createMessage({
      role: "user",
      content: [
        {
          type: "tool-result",
          toolCallId: callId,
          content: [{ type: "text", text: "path: /y.png" }, imageBlock()],
        },
      ],
      source: { kind: "tool", callId },
    });
    const ctx = await toPiContext(opts([toolResult]));
    const result = ctx.messages[0]!;
    if (result.role !== "toolResult") throw new Error("unreachable");
    expect(result.content).toEqual([
      { type: "text", text: "path: /y.png" },
      { type: "text", text: NO_STORE_IMAGE_TEXT },
    ]);
  });

  it("assistant-side image → deterministic placeholder (pi-ai cannot represent it), no throw, store untouched", async () => {
    const store = new FakeStore();
    const assistantMsg = createMessage({
      role: "assistant",
      content: [{ type: "text", text: "look:" }, imageBlock()],
      source: { kind: "model", provider: "unit", model: "unit-model" },
    });
    const ctx = await toPiContext(opts([assistantMsg]), { attachments: store });
    const assistant = ctx.messages[0]!;
    if (assistant.role !== "assistant") throw new Error("unreachable");
    expect(assistant.content).toEqual([
      { type: "text", text: "look:" },
      { type: "text", text: ASSISTANT_IMAGE_TEXT },
    ]);
    expect(store.calls).toEqual([]);
  });

  it("aborted store read propagates (live cancellation, not a placeholder turn)", async () => {
    const signal = new AbortController();
    signal.abort();
    const store: AttachmentReader = {
      async readImage(_ref, sig) {
        if (sig?.aborted) throw new DOMException("aborted", "AbortError");
        throw new Error("unreachable");
      },
    };
    const msg = createUserMessage({ content: [imageBlock()], source: { kind: "user" } });
    await expect(toPiContext(opts([msg]), { attachments: store, signal: signal.signal })).rejects.toThrow(
      "aborted",
    );
  });
});
