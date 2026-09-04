/**
 * Pure helpers for the dsh client's `read_image` tool view.
 *
 * Framework-neutral on purpose: NO react import, no DOM, no node-only deps,
 * and NO `@deepseek-ai/*` type imports (the types below are duck-typed
 * subsets of the host contracts, so this module stays importable from a bare
 * node test environment). The client bundle (src/dsh/client.tsx) imports
 * these and tsdown inlines the module (the bundle's runtime requires stay
 * react + react/jsx-runtime); the unit tests (test/toolview.test.ts) import
 * the module directly. This mirrors the `./import.js` split: the client
 * file cannot be imported from a test (its top-level react import is not
 * installed in this repo's node_modules — the bundle's require is answered
 * by the web shell's module table at runtime, not by the repo).
 *
 * The gap these helpers address: `read_image` logs its result as
 * `[text envelope, image block]` where the image block is
 * `{ type: 'image', attachment: <ImageAttachmentRef> }` — a content-addressed
 * REFERENCE (`attachmentId: "sha256:…"`, plus verified mediaType/width/height/
 * bytes), NOT base64. The bytes live under `<DSH_HOME>/attachments/v1/` and are
 * fetched on demand through `ISession.readAttachment(attachmentId)`. The model
 * side walks those refs (the LLM context builder), but the web GUI's generic
 * tool card flattens non-text blocks with `JSON.stringify` — so this view
 * re-renders the ref as an actual image.
 */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A content-addressed image attachment reference as it rides in the settled
 * `read_image` result — a duck-typed subset of the host `ImageAttachmentRef`
 * carrying only the fields this view uses. `attachmentId` is the byte key;
 * everything else is verified metadata the host stamped at write time.
 */
export interface ReadImageAttachmentRef {
  /** Opaque storage identifier (e.g. `sha256:…`); never a path or URL. */
  attachmentId: string;
  /** Media type verified from the stored bytes. */
  mediaType?: string;
  /** Exact encoded byte length. */
  bytes?: number;
  /** Intrinsic encoded width in pixels. */
  width?: number;
  /** Intrinsic encoded height in pixels. */
  height?: number;
  /** Optional display name (local path information already stripped). */
  name?: string;
}

/**
 * Extract the image attachment references from a settled tool result's content
 * blocks. Lenient by the reader contract (never throws): non-array content,
 * non-object blocks, blocks whose `type` is not `'image'`, and refs without a
 * non-empty string `attachmentId` are all skipped. Input order is preserved.
 *
 * @param content - the settled `ToolResultNode.content` block array (typed as
 *   `unknown[]` here so the module stays dsh-import-free; the real
 *   `ContentBlock[]` is assignable to it).
 * @returns the image refs in content order (possibly empty — a running call or
 *   a text-only result yields none).
 */
export function imageAttachmentRefs(content: readonly unknown[]): ReadImageAttachmentRef[] {
  const out: ReadImageAttachmentRef[] = [];
  if (!Array.isArray(content)) return out;
  for (const block of content) {
    if (!isPlainObject(block) || block.type !== "image") continue;
    const attachment = block.attachment;
    if (!isPlainObject(attachment)) continue;
    if (typeof attachment.attachmentId !== "string" || attachment.attachmentId === "") continue;
    out.push(attachment as unknown as ReadImageAttachmentRef);
  }
  return out;
}

/**
 * Join the text blocks of a content array into one string — the `read_image`
 * envelope is a single `{ type: 'text', text }` block, but this helper is
 * generic over any settled content that carries several. Only blocks tagged
 * `type: 'text'` are picked (a `reasoning` block also carries a `text` field
 * and must NOT join the envelope). Lenient: non-array content, non-object
 * blocks, and non-string `text` fields are skipped, never thrown.
 *
 * @returns the concatenated text blocks (`"\n"`-joined), or `""` when none.
 */
export function textBlocksOf(content: readonly unknown[]): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (isPlainObject(block) && block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("\n");
}

/**
 * The one-line caption under a rendered tool image: the ref's display name
 * (or `image`), plus the intrinsic dimensions when the ref carries them. The
 * on-disk path already rides the envelope text above, so the caption is
 * metadata-only.
 *
 * @returns e.g. `screenshot.png · 120×80`, or `image` when the name is absent.
 */
export function imageCaption(ref: ReadImageAttachmentRef): string {
  const label = typeof ref.name === "string" && ref.name !== "" ? ref.name : "image";
  if (typeof ref.width === "number" && typeof ref.height === "number") {
    return `${label} · ${ref.width}×${ref.height}`;
  }
  return label;
}

/**
 * The registration gating decision (owner rule): `renderReadImages` gates
 * the `read_image` keyed tool view's REGISTRATION, not just the image — an
 * explicit `false` deregisters the keyed view entirely so the host's own row
 * owns the call (today the generic card; tomorrow its fixed rendering — no
 * double render, no dead view shadowing an upstream fix). The DEFAULT is ON:
 * an absent or malformed flag renders. Only an explicit `false` steps aside.
 *
 * @param section - the current resolved `modelspoke:` section (or `undefined`
 *   before the first acceptance — treated as the default, render on).
 */
export function shouldRegisterReadImageView(section: unknown): boolean {
  const raw = isPlainObject(section) ? section.renderReadImages : undefined;
  return raw !== false;
}
