/**
 * The provenance manifest and its committed template fixtures are
 * pinned data — this test keeps them consistent OFFLINE.
 *
 * Hub copies pin a commit because the checker never fetches branch head
 * for them; the fixtures (test/fixtures/chat-template-*.jinja) are the
 * exact pinned template texts, committed so the invariant tests run
 * offline.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { presetCatalog } from "../src/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(
  readFileSync(path.join(HERE, "..", "src", "presets", "provenance.json"), "utf8"),
) as {
  version: number;
  entries: {
    presetId: string;
    family: "qwen" | "gpt-oss";
    contracts: Array<{
      kind: "hub" | "gguf";
      repo: string;
      file: string;
      sha256: string;
      commit?: string;
    }>;
  }[];
};

const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");
const fix = (name: string): string =>
  sha256(readFileSync(path.join(HERE, "fixtures", name), "utf8"));

describe("provenance manifest shape", () => {
  it("covers exactly the four catalog presets (1:1)", () => {
    expect(manifest.entries.map((e) => e.presetId).sort()).toEqual(
      presetCatalog.map((p) => p.id).sort(),
    );
  });

  it("every copy is well-formed; hub copies pin a commit", () => {
    for (const entry of manifest.entries) {
      expect(entry.family).toMatch(/^(qwen|gpt-oss)$/);
      expect(entry.contracts.length).toBeGreaterThanOrEqual(2);
      for (const c of entry.contracts) {
        expect(c.repo).toMatch(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
        expect(c.sha256).toMatch(/^[0-9a-f]{64}$/);
        if (c.kind === "hub") {
          expect(c.commit, `${entry.presetId}: hub copy of ${c.repo} must pin a commit`).toMatch(
            /^[0-9a-f]{40}$/,
          );
        }
      }
    }
  });
});

describe("committed fixtures hash to the pinned sha256s", () => {
  // (fixture file) -> (presetId, kind, repo) — the copy the fixture documents.
  const pinned: [string, string, string, string][] = [
    ["chat-template-qwen3.8-hub.jinja", "qwen3.8-chat-template", "hub", "Qwen/Qwen3.8-27B"],
    ["chat-template-qwen3.8-hub.jinja", "qwen3.8-chat-template", "hub", "Qwen/Qwen3.8-27B-FP8"],
    ["chat-template-qwen3.8-gguf.jinja", "qwen3.8-chat-template", "gguf", "unsloth/Qwen3.8-27B-GGUF"],
    ["chat-template-qwen3.6-hub.jinja", "qwen3.6-chat-template", "hub", "Qwen/Qwen3.6-27B-FP8"],
    ["chat-template-qwen3.6-hub.jinja", "qwen3.6-chat-template", "hub", "Qwen/Qwen3.6-35B-A3B-FP8"],
    ["chat-template-qwen3.6-gguf.jinja", "qwen3.6-chat-template", "gguf", "unsloth/Qwen3.6-27B-MTP-GGUF"],
    ["chat-template-qwen3.6-gguf.jinja", "qwen3.6-chat-template", "gguf", "unsloth/Qwen3.6-35B-A3B-MTP-GGUF"],
    ["chat-template-qwen3.5-gguf.jinja", "qwen3.5-chat-template", "gguf", "unsloth/Qwen3.5-4B-GGUF"],
    ["chat-template-qwen3.5-hub.jinja", "qwen3.5-chat-template", "hub", "Qwen/Qwen3.5-4B"],
    ["chat-template-gpt-oss.jinja", "gpt-oss-120b-chat-template", "hub", "openai/gpt-oss-120b"],
    ["chat-template-gpt-oss.jinja", "gpt-oss-120b-chat-template", "gguf", "ggml-org/gpt-oss-120b-GGUF"],
  ];

  for (const [file, presetId, kind, repo] of pinned) {
    it(`${presetId} ${kind} ${repo} (${file})`, () => {
      const entry = manifest.entries.find((e) => e.presetId === presetId)!;
      const copy = entry.contracts.find((c) => c.kind === kind && c.repo === repo);
      expect(copy, `manifest pin for ${presetId} ${kind} ${repo}`).toBeDefined();
      expect(fix(file)).toBe(copy!.sha256);
    });
  }
});
