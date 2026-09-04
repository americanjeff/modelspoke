/**
 * The read_image tool-view pure helpers (src/dsh/toolview.js).
 *
 * The helpers live in a framework-neutral module (no react, no
 * `@deepseek-ai/*` imports) precisely so this file can import them:
 * client.tsx itself cannot be imported here (its top-level react import is
 * answered by the web shell's module table at bundle runtime, not by this
 * repo's node_modules). The view's DOM behavior (bounded <img> render, byte
 * load via the sessions service, fallback line on failure) is covered by the
 * testenv CDP E2E gates (cdp-b10.mjs: rendered + deregistered screenshots).
 */

import { describe, expect, it } from "vitest";
import {
  imageAttachmentRefs,
  imageCaption,
  shouldRegisterReadImageView,
  textBlocksOf,
} from "../src/dsh/toolview.js";

// The real settled shape: read_image logs `[text envelope, image block]`
// (packages/fs/tool-fs/src/read-image.ts:153-158) — the image block is a
// content-addressed REFERENCE, never base64.
const ENVELOPE =
  "<path>/home/u/fixtures/b10-test.png</path>\n" +
  "<type>image</type>\n" +
  "<content>\nimage/png image, 120x80 px, 321 bytes\n</content>";
const IMAGE_BLOCK = {
  type: "image",
  attachment: {
    attachmentId: "sha256:abc123",
    mediaType: "image/png",
    bytes: 321,
    width: 120,
    height: 80,
    name: "b10-test.png",
  },
};
const SETTLED_CONTENT = [
  { type: "text", text: ENVELOPE },
  IMAGE_BLOCK,
];

describe("imageAttachmentRefs", () => {
  it("extracts the image ref(s) from a settled read_image result, in order", () => {
    expect(imageAttachmentRefs(SETTLED_CONTENT)).toEqual([
      IMAGE_BLOCK.attachment,
    ]);
  });

  it("extracts several image blocks, preserving content order", () => {
    const second = {
      type: "image",
      attachment: { attachmentId: "sha256:def456", mediaType: "image/jpeg", width: 10, height: 10 },
    };
    const refs = imageAttachmentRefs([
      { type: "text", text: "a" },
      IMAGE_BLOCK,
      second,
      { type: "text", text: "b" },
    ]);
    expect(refs.map((r) => r.attachmentId)).toEqual(["sha256:abc123", "sha256:def456"]);
  });

  it("yields none for a running call (no content) or a text-only result", () => {
    expect(imageAttachmentRefs([])).toEqual([]);
    expect(imageAttachmentRefs([{ type: "text", text: "just text" }])).toEqual([]);
  });

  it("is lenient: never throws on non-array content or malformed blocks", () => {
    expect(imageAttachmentRefs(undefined as unknown as readonly unknown[])).toEqual([]);
    expect(imageAttachmentRefs("nope" as unknown as readonly unknown[])).toEqual([]);
    expect(
      imageAttachmentRefs([null, 42, "x", { type: "image" }, { type: "image", attachment: null }]),
    ).toEqual([]);
  });

  it("skips image blocks whose ref lacks a non-empty string attachmentId", () => {
    expect(
      imageAttachmentRefs([
        { type: "image", attachment: {} },
        { type: "image", attachment: { attachmentId: 42 } },
        { type: "image", attachment: { attachmentId: "" } },
        { type: "image", attachment: "not-an-object" },
      ]),
    ).toEqual([]);
  });

  it("passes the ref through verbatim (extra fields survive — the view reads only its subset)", () => {
    const ref = {
      type: "image",
      attachment: { attachmentId: "sha256:x", width: 1, height: 1, originalDimensions: { width: 2, height: 2 } },
    };
    expect(imageAttachmentRefs([ref])).toEqual([ref.attachment]);
  });
});

describe("textBlocksOf", () => {
  it("returns the read_image envelope (the single text block) verbatim", () => {
    expect(textBlocksOf(SETTLED_CONTENT)).toBe(ENVELOPE);
  });

  it("joins several text blocks with newlines, skipping non-text blocks", () => {
    expect(textBlocksOf([{ type: "text", text: "a" }, IMAGE_BLOCK, { type: "text", text: "b" }])).toBe(
      "a\nb",
    );
  });

  it("is lenient: empty string for non-array content and malformed blocks", () => {
    expect(textBlocksOf(undefined as unknown as readonly unknown[])).toBe("");
    expect(textBlocksOf([{ type: "text" }, { text: "no-type" }, null])).toBe("");
  });
});

describe("imageCaption", () => {
  it("renders the display name plus intrinsic dimensions when both are present", () => {
    expect(imageCaption(IMAGE_BLOCK.attachment)).toBe("b10-test.png · 120×80");
  });

  it("falls back to `image` when the name is absent or blank", () => {
    expect(imageCaption({ attachmentId: "sha256:x", width: 10, height: 5 })).toBe("image · 10×5");
    expect(imageCaption({ attachmentId: "sha256:x", name: "", width: 10, height: 5 })).toBe(
      "image · 10×5",
    );
  });

  it("omits the dimension suffix when either axis is missing", () => {
    expect(imageCaption({ attachmentId: "sha256:x", name: "a.png", width: 10 })).toBe("a.png");
    expect(imageCaption({ attachmentId: "sha256:x" })).toBe("image");
  });
});

describe("shouldRegisterReadImageView (the registration gating decision)", () => {
  it("defaults ON for an absent section (pre-first-acceptance / older client)", () => {
    expect(shouldRegisterReadImageView(undefined)).toBe(true);
    expect(shouldRegisterReadImageView(null)).toBe(true);
    expect(shouldRegisterReadImageView({})).toBe(true);
  });

  it("renders for an explicitly-present `true`", () => {
    expect(shouldRegisterReadImageView({ renderReadImages: true })).toBe(true);
  });

  it("deregisters ONLY for an explicit `false` (the host row owns the call)", () => {
    expect(shouldRegisterReadImageView({ renderReadImages: false })).toBe(false);
  });

  it("treats a malformed value as the default (render on) — lenient, never throws", () => {
    expect(shouldRegisterReadImageView({ renderReadImages: "yes" })).toBe(true);
    expect(shouldRegisterReadImageView({ renderReadImages: 0 })).toBe(true);
    expect(shouldRegisterReadImageView({ renderReadImages: null })).toBe(true);
  });

  it("coexists with the section's other fields (routes/overrides are ignored here)", () => {
    expect(
      shouldRegisterReadImageView({
        routes: [{ name: "spoke", baseURL: "http://127.0.0.1:1/v1" }],
        overrides: {},
        renderReadImages: false,
      }),
    ).toBe(false);
  });
});
