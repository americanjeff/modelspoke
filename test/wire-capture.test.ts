/**
 * In-process wire capture; the adapter is driven directly (prepareCall → prepared.stream) —
 * the exact dispatch path the LlmRuntime uses. The `ctx.llm` registration proof happens at the testenv step.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { CallId, createMessage, createUserMessage, ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import type { GenerateOptions, ImageBlock, Message, StreamChunk } from "@deepseek-ai/dsh-llm";
import { attributionHeaders } from "@deepseek-ai/dsh-llm";
import { ModelspokeAdapter } from "../src/dsh/adapter.js";
import { requestHeaders } from "../src/dsh/headers.js";
import {
  ASSISTANT_IMAGE_TEXT,
  NO_STORE_IMAGE_TEXT,
} from "../src/dsh/context.js";
import type { AttachmentReader, ImageRef } from "../src/dsh/context.js";

const FLAGSHIP = "qwen3.8-27b-6000pro";

interface CapturedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Record<string, unknown>;
}

const captured: CapturedRequest[] = [];
let server: http.Server;
let baseUrl = "";

function sseEvents(): string[] {
  const base = {
    id: "cmpl-capture",
    object: "chat.completion.chunk",
    created: 1,
    model: FLAGSHIP,
  };
  const choice = (delta: Record<string, unknown>, finishReason: string | null) =>
    JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finishReason }] });
  return [
    choice({ role: "assistant", content: "Hel" }, null),
    choice({ content: "lo." }, null),
    choice({}, "stop"),
    JSON.stringify({
      ...base,
      choices: [],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }),
    "[DONE]",
  ];
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      captured.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: raw.length > 0 ? (JSON.parse(raw) as Record<string, unknown>) : {},
      });
      if (req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: [] }));
        return;
      }
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      for (const event of sseEvents()) {
        res.write(`data: ${event}\n\n`);
      }
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

const KEY_ENV = "MODEL_SPOKE_WIRE_TEST_KEY";

interface RouteSpec {
  name: string;
  apiKeyEnv?: string;
}

function makeAdapter(route: RouteSpec, store?: AttachmentReader): ModelspokeAdapter {
  return new ModelspokeAdapter({
    settings: () => ({
      routes: [
        {
          name: route.name,
          baseURL: baseUrl,
          ...route.apiKeyEnv === undefined ? {} : { apiKeyEnv: route.apiKeyEnv },
        },
      ],
      overrides: {},
    }),
    ...store === undefined ? {} : { resolveAttachments: () => store },
  });
}

function optionsFor(route: RouteSpec, effort?: string, extra?: Partial<GenerateOptions>): GenerateOptions {
  return {
    provider: route.name,
    model: FLAGSHIP,
    messages: [createUserMessage({ content: [{ type: "text", text: "Hello?" }], source: { kind: "user" } })],
    ...(effort === undefined ? {} : { reasoningEffort: ReasoningEffortId(effort) }),
    ...extra,
  };
}

async function runRoute(
  route: RouteSpec,
  effort?: string,
  extra?: Partial<GenerateOptions>,
  store?: AttachmentReader,
): Promise<CapturedRequest> {
  const adapter = makeAdapter(route, store);
  const prepared = await adapter.prepareCall(route.name, FLAGSHIP);
  for await (const _chunk of prepared.stream(optionsFor(route, effort, extra))) {
    // drain
  }
  const requests = chatRequests();
  const last = requests[requests.length - 1];
  if (!last) throw new Error("no chat request captured");
  return last;
}

function chatRequests(): CapturedRequest[] {
  return captured.filter((r) => r.url.endsWith("/chat/completions"));
}

function chunkAt(chunks: StreamChunk[], index: number): StreamChunk {
  const chunk = chunks[index];
  if (!chunk) throw new Error(`missing chunk at ${index}`);
  return chunk;
}

describe("wire capture — attribution + auth + chat_template_kwargs", () => {
  it("every request carries the attribution user-agent (SPIKE 2 hard contract)", async () => {
    process.env[KEY_ENV] = "dummy";
    try {
      const req = await runRoute({ name: "wire-keyed", apiKeyEnv: KEY_ENV }, "medium");
      const expected = attributionHeaders()["user-agent"];
      expect(expected).toBeTruthy();
      expect(req.headers["user-agent"]).toBe(expected);
    } finally {
      delete process.env[KEY_ENV];
    }
  });

  it("route headers can never override attribution (requestHeaders precedence)", () => {
    const merged = requestHeaders({
      "User-Agent": "attacker-overwrite",
      "user-agent": "lowercase-overwrite",
      "x-route": "kept",
    });
    expect(merged["user-agent"]).toBe(attributionHeaders()["user-agent"]);
    expect(merged["x-route"]).toBe("kept");
    for (const key of Object.keys(merged)) {
      if (key.toLowerCase() === "user-agent") continue;
      expect(merged[key]).not.toBe("attacker-overwrite");
      expect(merged[key]).not.toBe("lowercase-overwrite");
    }
  });

  it("Bearer is sent only when the route's apiKeyEnv resolves non-empty", async () => {
    process.env[KEY_ENV] = "dummy-secret";
    try {
      const keyed = await runRoute({ name: "wire-keyed", apiKeyEnv: KEY_ENV }, "medium");
      expect(keyed.headers.authorization).toBe("Bearer dummy-secret");

      const keyless = await runRoute({ name: "wire-keyless" }, "medium");
      expect(keyless.headers.authorization).toBeUndefined();

      const emptyEnv = "MODEL_SPOKE_WIRE_TEST_KEY_EMPTY";
      process.env[emptyEnv] = "";
      const empty = await runRoute({ name: "wire-empty", apiKeyEnv: emptyEnv }, "medium");
      delete process.env[emptyEnv];
      expect(empty.headers.authorization).toBeUndefined();

      const expected = attributionHeaders()["user-agent"];
      for (const req of [keyed, keyless, empty]) {
        expect(req.headers["user-agent"]).toBe(expected);
      }
    } finally {
      delete process.env[KEY_ENV];
    }
  });

  it("sends the exact flagship chat_template_kwargs payload ($var resolved, preserve_thinking)", async () => {
    process.env[KEY_ENV] = "dummy";
    try {
      const req = await runRoute({ name: "wire-kwargs", apiKeyEnv: KEY_ENV }, "medium");
      expect(req.body.model).toBe(FLAGSHIP);
      expect(req.body.chat_template_kwargs).toEqual({
        enable_thinking: true,
        reasoning_effort: "medium",
        preserve_thinking: true,
      });
      // pi-ai always asks for streaming usage; the output cap is always
      // clamped in — under `max_completion_tokens` unless the model's compat
      // spells `maxTokensField: "max_tokens"` (the flagship preset does not).
      expect(req.body.stream_options).toEqual({ include_usage: true });
      expect(typeof req.body.max_completion_tokens).toBe("number");
      expect((req.body.max_completion_tokens as number) > 0).toBe(true);
      expect(req.body.max_tokens).toBeUndefined();
      const messages = req.body.messages as Array<{ role: string; content?: string }>;
      expect(Array.isArray(messages)).toBe(true);
      expect(messages.some((m) => m.role === "user" && m.content === "Hello?")).toBe(true);
    } finally {
      delete process.env[KEY_ENV];
    }
  });

  it("xhigh dispatches the wire spelling for that level", async () => {
    process.env[KEY_ENV] = "dummy";
    try {
      const req = await runRoute({ name: "wire-xhigh", apiKeyEnv: KEY_ENV }, "xhigh");
      expect(req.body.chat_template_kwargs).toEqual({
        enable_thinking: true,
        reasoning_effort: "xhigh",
        preserve_thinking: true,
      });
    } finally {
      delete process.env[KEY_ENV];
    }
  });

  it("pi parity: NO explicit effort → the built-in fallback (medium) rides the wire", async () => {
    process.env[KEY_ENV] = "dummy";
    try {
      const req = await runRoute({ name: "wire-fallback", apiKeyEnv: KEY_ENV });
      expect(req.body.chat_template_kwargs).toEqual({
        enable_thinking: true,
        reasoning_effort: "medium",
        preserve_thinking: true,
      });
    } finally {
      delete process.env[KEY_ENV];
    }
  });

  it("off: enable_thinking:false with NO reasoning_effort key", async () => {
    process.env[KEY_ENV] = "dummy";
    try {
      const req = await runRoute({ name: "wire-off", apiKeyEnv: KEY_ENV }, "off");
      const kwargs = req.body.chat_template_kwargs as Record<string, unknown>;
      expect(kwargs).toEqual({
        enable_thinking: false,
        preserve_thinking: true,
      });
      expect("reasoning_effort" in kwargs).toBe(false);
      expect(kwargs.enable_thinking).toBe(false);
    } finally {
      delete process.env[KEY_ENV];
    }
  });

  it("nothink (BUG-001): the sentinel entry sends enable_thinking:false on the wire with NO declared dimension", async () => {
    process.env[KEY_ENV] = "dummy";
    try {
      const route: RouteSpec = { name: "wire-nothink", apiKeyEnv: KEY_ENV };
      // A nothink entry (the stored `"none"` sentinel — "this endpoint's
      // copy has no selectable reasoning dimension") in the legacy top-level
      // map = tier 1 for this FULL_CATALOG route. The flagship's PRESET
      // supplies the chat-template compat + kwarg block (the entry's own
      // compat would be the same shape — the live titler entry).
      const adapter = new ModelspokeAdapter({
        settings: () => ({
          routes: [{ name: route.name, baseURL: baseUrl, apiKeyEnv: route.apiKeyEnv }],
          overrides: { [FLAGSHIP]: { thinkingLevelMap: "none" } },
        }),
      });
      const prepared = await adapter.prepareCall(route.name, FLAGSHIP);
      // The DECLARED dimension stays off: the runtime's model carries no
      // reasoning field (no efforts, no default) — the nothink contract.
      expect(prepared.model.reasoning).toBeUndefined();
      for await (const _chunk of prepared.stream(optionsFor(route))) {
        // drain
      }
      const requests = captured.filter((r) => r.url.endsWith("/chat/completions"));
      const last = requests[requests.length - 1];
      if (!last) throw new Error("no chat request captured");
      // But the WIRE carries the explicit off — the exact payload the live
      // "off" dispatch sends (BUG-001: the server honors it; the defect was
      // that the nothink path never sent it, so the template's thinking-ON
      // default applied).
      const kwargs = last.body.chat_template_kwargs as Record<string, unknown>;
      expect(kwargs).toEqual({ enable_thinking: false, preserve_thinking: true });
      expect("reasoning_effort" in kwargs).toBe(false);
      // No effort was ever sent (the shim's level map offers only `off`,
      // which pi-ai dispatches as no effort) — so nothing top-level either.
      expect(last.body.reasoning_effort).toBeUndefined();
    } finally {
      delete process.env[KEY_ENV];
    }
  });

  it("emits usage before the terminal finish and nothing after; tool args stay raw JSON", async () => {
    process.env[KEY_ENV] = "dummy";
    try {
      const callId = CallId("call-1");
      const toolResult = createMessage({
        role: "user",
        content: [{ type: "tool-result", toolCallId: callId, content: [{ type: "text", text: "42" }] }],
        source: { kind: "tool", callId },
      });
      const assistantToolCall = createMessage({
        role: "assistant",
        content: [{ type: "tool-call", id: callId, name: "get_answer", arguments: '{"x":1}' }],
        source: { kind: "model", provider: "wire-protocol", model: FLAGSHIP },
      });
      const route: RouteSpec = { name: "wire-protocol", apiKeyEnv: KEY_ENV };
      const adapter = makeAdapter(route);
      const prepared = await adapter.prepareCall(route.name, FLAGSHIP);
      const chunks: StreamChunk[] = [];
      for await (const chunk of prepared.stream(
        optionsFor(route, "medium", {
          messages: [
            createUserMessage({ content: [{ type: "text", text: "go" }], source: { kind: "user" } }),
            assistantToolCall,
            toolResult,
          ],
        }),
      )) {
        chunks.push(chunk);
      }

      const usageIndex = chunks.findIndex((c) => c.type === "usage");
      const finishIndex = chunks.findIndex((c) => c.type === "finish");
      expect(usageIndex).toBeGreaterThan(-1);
      expect(finishIndex).toBeGreaterThan(usageIndex);
      expect(finishIndex).toBe(chunks.length - 1);
      expect(chunkAt(chunks, finishIndex).type).toBe("finish");
      if (chunkAt(chunks, finishIndex).type !== "finish") throw new Error("unreachable");
      expect((chunkAt(chunks, finishIndex) as Extract<StreamChunk, { type: "finish" }>).reason.kind).toBe("stop");
      expect(chunkAt(chunks, usageIndex).type).toBe("usage");
      if (chunkAt(chunks, usageIndex).type !== "usage") throw new Error("unreachable");
      expect((chunkAt(chunks, usageIndex) as Extract<StreamChunk, { type: "usage" }>).usage.inputTokens).toBe(10);
      expect((chunkAt(chunks, usageIndex) as Extract<StreamChunk, { type: "usage" }>).usage.outputTokens).toBe(5);

      const req = await runRoute(route, "medium", {
        messages: [
          createUserMessage({ content: [{ type: "text", text: "go" }], source: { kind: "user" } }),
          assistantToolCall,
          toolResult,
        ],
      });
      const messages = req.body.messages as Array<{
        role: string;
        tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>;
        tool_call_id?: string;
      }>;
      const assistantCall = messages.find((m) => m.role === "assistant" && Array.isArray(m.tool_calls));
      expect(assistantCall).toBeDefined();
      const call = assistantCall!.tool_calls![0];
      expect(call?.function?.name).toBe("get_answer");
      expect(call?.function?.arguments).toBe('{"x":1}');
      const toolResultMsg = messages.find((m) => m.role === "tool");
      expect(toolResultMsg).toBeDefined();
      expect(toolResultMsg!.tool_call_id).toBe("call-1");
    } finally {
      delete process.env[KEY_ENV];
    }
  });
});

describe("wire capture — image input (attachment resolution + guard)", () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const pngB64 = Buffer.from(PNG).toString("base64");
  const REF: ImageRef = {
    attachmentId: "sha256:cafe1234567890ab",
    mediaType: "image/png",
    bytes: PNG.length,
    width: 8,
    height: 8,
  } as unknown as ImageRef;
  const ROUTE: RouteSpec = { name: "wire-image", apiKeyEnv: KEY_ENV };

  const wireStore: AttachmentReader = {
    async readImage(ref: ImageRef) {
      return { ref, data: PNG };
    },
  };

  function imageBlock(ref: ImageRef = REF): Extract<Message["content"][number], { type: "image" }> {
    return { type: "image", attachment: ref } as unknown as Extract<Message["content"][number], { type: "image" }>;
  }

  function imageBlocksInBody(req: CapturedRequest): Array<{ url?: string }> {
    const found: Array<{ url?: string }> = [];
    const walk = (content: unknown): void => {
      if (!Array.isArray(content)) return;
      for (const part of content) {
        if (part && typeof part === "object" && (part as { type?: string }).type === "image_url") {
          found.push(part as { url?: string });
        }
      }
    };
    for (const message of (req.body.messages as Array<Record<string, unknown>>) ?? []) {
      walk(message.content);
    }
    return found;
  }

  it("user image crosses the wire as an image_url data URL (attachment resolved)", async () => {
    process.env[KEY_ENV] = "dummy";
    try {
      const req = await runRoute(
        ROUTE,
        "medium",
        {
          messages: [
            createUserMessage({
              content: [{ type: "text", text: "what is this?" }, imageBlock()],
              source: { kind: "user" },
            }),
          ],
        },
        wireStore,
      );
      const messages = req.body.messages as Array<Record<string, unknown>>;
      const userMsg = messages.find((m) => m.role === "user");
      expect(Array.isArray(userMsg?.content)).toBe(true);
      const parts = userMsg!.content as Array<Record<string, unknown>>;
      expect(parts.some((p) => p.type === "text" && p.text === "what is this?")).toBe(true);
      const image = parts.find((p) => p.type === "image_url");
      expect(image?.image_url).toEqual({ url: `data:image/png;base64,${pngB64}` });
    } finally {
      delete process.env[KEY_ENV];
    }
  });

  it("read_image-style tool result: the result text stays in the tool slot, the image lifts into a user message", async () => {
    process.env[KEY_ENV] = "dummy";
    try {
      const callId = CallId("call-wire-img");
      const messages: Message[] = [
        createUserMessage({ content: [{ type: "text", text: "go" }], source: { kind: "user" } }),
        createMessage({
          role: "assistant",
          content: [{ type: "tool-call", id: callId, name: "read_image", arguments: '{"file_path":"/x.png"}' }],
          source: { kind: "model", provider: "wire-image", model: FLAGSHIP },
        }),
        createMessage({
          role: "user",
          content: [
            {
              type: "tool-result",
              toolCallId: callId,
              content: [{ type: "text", text: "path: /x.png" }, imageBlock()],
            },
          ],
          source: { kind: "tool", callId },
        }),
      ];
      const req = await runRoute(ROUTE, "medium", { messages }, wireStore);
      const wire = req.body.messages as Array<Record<string, unknown>>;
      const toolMsg = wire.find((m) => m.role === "tool");
      expect(toolMsg?.content).toBe("path: /x.png");
      expect(toolMsg?.tool_call_id).toBe("call-wire-img");
      // pi-ai lifts tool-result images into a synthesized user message.
      const lifted = wire.find(
        (m) =>
          m.role === "user" &&
          Array.isArray(m.content) &&
          (m.content as Array<Record<string, unknown>>).some(
            (p) => p.type === "text" && p.text === "Attached image(s) from tool result:",
          ),
      );
      expect(lifted).toBeDefined();
      const parts = lifted!.content as Array<Record<string, unknown>>;
      const image = parts.find((p) => p.type === "image_url");
      expect(image?.image_url).toEqual({ url: `data:image/png;base64,${pngB64}` });
    } finally {
      delete process.env[KEY_ENV];
    }
  });

  it("image-ONLY tool result: the tool slot carries the (see attached image) stand-in", async () => {
    process.env[KEY_ENV] = "dummy";
    try {
      const callId = CallId("call-wire-img-only");
      const messages: Message[] = [
        createMessage({
          role: "assistant",
          content: [{ type: "tool-call", id: callId, name: "read_image", arguments: "{}" }],
          source: { kind: "model", provider: "wire-image", model: FLAGSHIP },
        }),
        createMessage({
          role: "user",
          content: [{ type: "tool-result", toolCallId: callId, content: [imageBlock()] }],
          source: { kind: "tool", callId },
        }),
      ];
      const req = await runRoute(ROUTE, "medium", { messages }, wireStore);
      const wire = req.body.messages as Array<Record<string, unknown>>;
      const toolMsg = wire.find((m) => m.role === "tool");
      expect(toolMsg?.content).toBe("(see attached image)");
      expect(imageBlocksInBody(req).length).toBe(1);
    } finally {
      delete process.env[KEY_ENV];
    }
  });

  it("image WITHOUT a store: deterministic placeholder on the wire, turn completes", async () => {
    process.env[KEY_ENV] = "dummy";
    try {
      const req = await runRoute(ROUTE, "medium", {
        messages: [
          createUserMessage({ content: [imageBlock()], source: { kind: "user" } }),
        ],
      });
      const wire = req.body.messages as Array<Record<string, unknown>>;
      const userMsg = wire.find((m) => m.role === "user")!;
      const content = Array.isArray(userMsg.content) ? (userMsg.content as Array<Record<string, unknown>>) : [];
      expect(content.some((p) => p.type === "text" && p.text === NO_STORE_IMAGE_TEXT)).toBe(true);
      expect(imageBlocksInBody(req)).toEqual([]);
    } finally {
      delete process.env[KEY_ENV];
    }
  });

  it("assistant-side image in durable history: placeholder on the wire, turn completes", async () => {
    process.env[KEY_ENV] = "dummy";
    try {
      const messages: Message[] = [
        createMessage({
          role: "assistant",
          content: [{ type: "text", text: "look:" }, imageBlock()],
          source: { kind: "model", provider: "wire-image", model: FLAGSHIP },
        }),
        createUserMessage({ content: [{ type: "text", text: "go" }], source: { kind: "user" } }),
      ];
      const req = await runRoute(ROUTE, "medium", { messages }, wireStore);
      const wire = req.body.messages as Array<Record<string, unknown>>;
      const assistantMsg = wire.find((m) => m.role === "assistant")!;
      const serialized = JSON.stringify(assistantMsg.content);
      expect(serialized).toContain("look:");
      expect(serialized).toContain(ASSISTANT_IMAGE_TEXT);
      expect(imageBlocksInBody(req)).toEqual([]);
    } finally {
      delete process.env[KEY_ENV];
    }
  });
});
