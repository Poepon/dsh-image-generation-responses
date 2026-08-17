/**
 * Pure protocol helpers for the OpenAI-compatible `/responses`
 * image-generation flow (the built-in `image_generation` tool, e.g.
 * `gpt-image-2`). This module has zero imports — every function is
 * dependency-free so it unit-tests anywhere with plain `node --test`, and
 * `lib/index.js` reuses it unchanged.
 *
 * Wire contract implemented here (non-streaming), matching the official
 * OpenAI Responses API surface:
 *
 *   POST {normalized baseURL}/responses
 *   {
 *     "model": responseModel,
 *     "input": <trimmed prompt>,
 *     "stream": false,
 *     "tools": [{
 *       "type": "image_generation",
 *       "model": imageModel,
 *       "action": "generate",
 *       "size": "1024x1024",
 *       "quality": "medium",
 *       "background": "opaque",
 *       "output_format": "png"
 *     }],
 *     "tool_choice": { "type": "image_generation" },
 *     "store": false
 *   }
 *
 * There is no `name` on the tool and no nested `options` object: generation
 * parameters live flat on the tool entry. Tool parameters are validated
 * against the official enums, and `transparent` + `jpeg` (which cannot carry
 * an alpha channel) is rejected up front.
 *
 * IMAGE-TO-IMAGE (editing) uses the same endpoint and the same tool. Two things
 * change when reference images are supplied:
 *
 *   - the tool entry carries `"action": "edit"` (the enum is
 *     `generate | edit | auto`), plus the optional `input_fidelity` and
 *     `input_image_mask` controls;
 *   - `input` becomes a message array rather than a bare string, so the
 *     reference images can ride alongside the instruction:
 *
 *     "input": [{ "role": "user", "content": [
 *        { "type": "input_text",  "text": <trimmed prompt> },
 *        { "type": "input_image", "image_url": "data:image/png;base64,...", "detail": "auto" }
 *     ]}]
 *
 * `input_image` accepts either `image_url` (a fully qualified URL or a base64
 * data URL) or `file_id`, and `detail` is required by the typed schema
 * (`low | high | auto | original`). The mask is an object with the same
 * `image_url` / `file_id` alternatives and is only meaningful for inpainting.
 *
 * A successful non-streaming response carries an `output` array whose
 * `image_generation_call` items are
 * `{ type: "image_generation_call", id?, result: string|null, status? }`
 * where `result` is the raw base64 image payload; that value is read directly
 * and strictly decoded. The top-level `response.id` is preserved on the
 * result when present. Refusals surface as output message content
 * `{ type: "refusal", refusal: string }` (or a bare `{ type: "refusal" }`
 * output item) and API failures as a top-level `error` object.
 *
 * IMAGE UNDERSTANDING uses the same endpoint without the tool: a plain
 * completion whose `input` message carries an `input_text` question plus one
 * `input_image` block per reference image (`buildVisionRequest`), answered by
 * `output` message items holding `output_text` blocks (`extractResponseText`).
 * The image ContentBlocks are normalized exactly as in the edit path.
 *
 * The nested `output: [{ type: "image", image_url|b64_json, ... }]` shape
 * emitted by earlier providers is still tolerated, but only as a clearly
 * backward-compatible fallback that runs strictly after the official direct
 * `result` path has found nothing.
 *
 * @module dsh-image-generation-responses/protocol
 */

/** Media types the attachment seam can durably store (see @deepseek-ai/dsh-attachment). */
export const IMAGE_MEDIA_TYPES = Object.freeze([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

/** Official `size` enum for the `image_generation` tool. */
export const IMAGE_GENERATION_SIZES = Object.freeze(["1024x1024", "1024x1536", "1536x1024", "auto"]);
/** Official `quality` enum for the `image_generation` tool. */
export const IMAGE_GENERATION_QUALITIES = Object.freeze(["low", "medium", "high", "auto"]);
/** Official `background` enum for the `image_generation` tool. */
export const IMAGE_GENERATION_BACKGROUNDS = Object.freeze(["transparent", "opaque", "auto"]);
/** Official `output_format` enum for the `image_generation` tool. */
export const IMAGE_GENERATION_FORMATS = Object.freeze(["png", "webp", "jpeg"]);
/**
 * Official `action` enum for the `image_generation` tool. `generate` makes a new
 * image, `edit` transforms the supplied reference images, and `auto` lets the
 * model decide. Defaults to `auto` upstream; this module sends an explicit
 * value so a request's intent never depends on a provider default.
 */
export const IMAGE_GENERATION_ACTIONS = Object.freeze(["generate", "edit", "auto"]);
/**
 * Official `input_fidelity` enum: how hard the model works to preserve the style
 * and features (notably faces) of the input images. Edit-only control.
 */
export const IMAGE_INPUT_FIDELITIES = Object.freeze(["high", "low"]);
/** Official `detail` enum for an `input_image` content block. */
export const IMAGE_INPUT_DETAILS = Object.freeze(["low", "high", "auto", "original"]);
/** Requested output format to stored media type. */
export const FORMAT_MEDIA_TYPES = Object.freeze({
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
});

/**
 * One structured failure of the image-generation protocol. `code` is a stable
 * machine-routing value; `status` carries the HTTP status when the failure
 * came from a non-2xx transport response.
 */
export class ImageGenerationError extends Error {
  /**
   * @param message - human-readable failure text.
   * @param code - stable code: HTTP_ERROR, API_ERROR, REFUSED, MISSING_OUTPUT,
   *   BAD_BASE64, OVERSIZED, UNSUPPORTED_MEDIA_TYPE, UNSUPPORTED_IMAGE_URL,
   *   INVALID_RESPONSE, GENERATION_FAILED, INCOMPLETE.
   * @param options - `status` (HTTP status when known) and `cause` (wrapped error).
   */
  constructor(message, code, options = {}) {
    super(message);
    this.name = "ImageGenerationError";
    this.code = code;
    if (options.status !== undefined) this.status = options.status;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

/**
 * Normalize a configured Responses base URL: trim surrounding whitespace,
 * require an absolute http(s) URL without embedded credentials, drop any query
 * string or hash, and strip trailing slashes. The endpoint posted to is
 * `${normalizeResponsesUrl(baseURL)}/responses`.
 * @param baseURL - the configured base URL (e.g. `https://api.openai.com/v1`).
 * @returns the normalized base URL without a trailing slash.
 * @throws TypeError for non-string, non-absolute, non-http(s), or credential-bearing input.
 */
export function normalizeResponsesUrl(baseURL) {
  if (typeof baseURL !== "string" || baseURL.trim().length === 0) {
    throw new TypeError("baseURL must be a non-empty string");
  }
  let url;
  try {
    url = new URL(baseURL.trim());
  } catch {
    throw new TypeError(`baseURL is not a valid absolute URL: "${baseURL}"`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError(`baseURL must use http: or https:, got "${url.protocol}"`);
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new TypeError("baseURL must not embed user credentials");
  }
  url.search = "";
  url.hash = "";
  let normalized = url.toString();
  while (normalized.endsWith("/")) normalized = normalized.slice(0, -1);
  return normalized;
}

/**
 * The full endpoint a generation is POSTed to: the normalized base URL plus
 * `/responses`.
 * @param baseURL - the configured base URL.
 * @returns the normalized `.../responses` endpoint.
 */
export function responsesEndpoint(baseURL) {
  return `${normalizeResponsesUrl(baseURL)}/responses`;
}

/** Throw a TypeError listing the allowed values when `value` is not in `allowed`. */
function assertEnum(value, allowed, what) {
  if (!allowed.includes(value)) {
    throw new TypeError(`invalid image_generation ${what} "${value}" (expected one of: ${allowed.join(", ")})`);
  }
}

/**
 * Build the non-streaming `/responses` request body for one generation. The
 * top-level `model` is the response model; the built-in `image_generation`
 * tool is forced via `tool_choice: { type: "image_generation" }`, with
 * generation options flat on the tool entry (no `name`, no nested
 * `options`). Undefined options are omitted so provider defaults apply.
 * @param options - `prompt` and `responseModel` (required) plus the optional
 *   `imageModel`, `size`, `quality`, `background`, and `format`.
 * @returns the wire body.
 * @throws TypeError for a blank `prompt`, a missing `responseModel`, an
 *   out-of-enum generation option, or the unsupported `transparent` + `jpeg`
 *   combination.
 */
/**
 * Encode one reference image as an RFC 2397 base64 data URL, the form
 * `input_image.image_url` accepts besides a fully qualified URL.
 * @param mediaType - stored media type of the image.
 * @param base64 - standard base64 payload (no data-URL prefix, no whitespace).
 * @returns the `data:<mediaType>;base64,<payload>` string.
 * @throws TypeError for a blank media type or payload.
 */
export function toImageDataUrl(mediaType, base64) {
  if (typeof mediaType !== "string" || mediaType.trim().length === 0) {
    throw new TypeError("mediaType must be a non-empty string");
  }
  if (typeof base64 !== "string" || base64.trim().length === 0) {
    throw new TypeError("base64 must be a non-empty string");
  }
  return `data:${mediaType.trim()};base64,${base64.trim()}`;
}

/**
 * Normalize one caller-supplied reference image into an `input_image` content
 * block. Accepts either an already-encoded `imageUrl`/`fileId`, or a
 * `mediaType` + `base64` pair that is encoded into a data URL here.
 * @param image - one reference image descriptor.
 * @param index - position, used only for error text.
 * @returns the wire `input_image` block.
 * @throws TypeError when neither an image reference nor bytes are present, or
 *   when `detail` falls outside the official enum.
 */
function toInputImageBlock(image, index) {
  if (image === null || typeof image !== "object") {
    throw new TypeError(`images[${index}] must be an object`);
  }
  const block = { type: "input_image" };
  const fileId = typeof image.fileId === "string" ? image.fileId.trim() : "";
  const imageUrl = typeof image.imageUrl === "string" ? image.imageUrl.trim() : "";
  if (fileId.length > 0) {
    block.file_id = fileId;
  } else if (imageUrl.length > 0) {
    block.image_url = imageUrl;
  } else if (typeof image.base64 === "string" && image.base64.trim().length > 0) {
    block.image_url = toImageDataUrl(image.mediaType, image.base64);
  } else {
    throw new TypeError(`images[${index}] must carry one of fileId, imageUrl, or mediaType + base64`);
  }
  // `detail` is required by the typed schema; default to the documented `auto`.
  const detail = typeof image.detail === "string" && image.detail.trim().length > 0
    ? image.detail.trim()
    : "auto";
  assertEnum(detail, IMAGE_INPUT_DETAILS, "detail");
  block.detail = detail;
  return block;
}

/**
 * Normalize an inpainting mask into the tool's `input_image_mask` object, which
 * carries the same `image_url` / `file_id` alternatives as a reference image.
 * @param mask - mask descriptor.
 * @returns the wire `input_image_mask` value.
 * @throws TypeError when the mask carries no usable reference.
 */
function toInputImageMask(mask) {
  if (mask === null || typeof mask !== "object") {
    throw new TypeError("mask must be an object");
  }
  const fileId = typeof mask.fileId === "string" ? mask.fileId.trim() : "";
  const imageUrl = typeof mask.imageUrl === "string" ? mask.imageUrl.trim() : "";
  if (fileId.length > 0) return { file_id: fileId };
  if (imageUrl.length > 0) return { image_url: imageUrl };
  if (typeof mask.base64 === "string" && mask.base64.trim().length > 0) {
    return { image_url: toImageDataUrl(mask.mediaType, mask.base64) };
  }
  throw new TypeError("mask must carry one of fileId, imageUrl, or mediaType + base64");
}

/**
 * Build the non-streaming `/responses` request body for one generation or edit.
 * The top-level `model` is the response model; the built-in `image_generation`
 * tool is forced via `tool_choice: { type: "image_generation" }`, with
 * generation options flat on the tool entry (no `name`, no nested
 * `options`). Undefined options are omitted so provider defaults apply.
 *
 * Supplying `images` switches the request to image-to-image: `action` becomes
 * `edit` (unless the caller pins it explicitly) and `input` becomes a single
 * user message carrying an `input_text` block followed by one `input_image`
 * block per reference image. With no `images`, the body is byte-for-byte the
 * text-to-image shape this module has always sent.
 *
 * @param options - `prompt` and `responseModel` (required) plus the optional
 *   `imageModel`, `size`, `quality`, `background`, `format`, `images`,
 *   `action`, `inputFidelity`, and `mask`.
 * @returns the wire body.
 * @throws TypeError for a blank `prompt`, a missing `responseModel`, an
 *   out-of-enum option, the unsupported `transparent` + `jpeg` combination, an
 *   unusable reference image, or edit-only options passed without `images`.
 */
export function buildImageGenerationRequest(options = {}) {
  const {
    prompt,
    responseModel,
    imageModel,
    size,
    quality,
    background,
    format,
    images,
    action,
    inputFidelity,
    mask,
  } = options;
  if (typeof prompt !== "string" || prompt.trim().length === 0) {
    throw new TypeError("prompt must be a non-empty string");
  }
  if (typeof responseModel !== "string" || responseModel.trim().length === 0) {
    throw new TypeError("responseModel must be a non-empty string");
  }
  if (images !== undefined && !Array.isArray(images)) {
    throw new TypeError("images must be an array when provided");
  }
  const references = Array.isArray(images) ? images : [];
  const editing = references.length > 0;
  // An explicit action wins; otherwise the presence of references decides, so
  // callers never have to restate the mode they already implied.
  let resolvedAction = editing ? "edit" : "generate";
  if (typeof action === "string" && action.trim().length > 0) {
    resolvedAction = action.trim();
    assertEnum(resolvedAction, IMAGE_GENERATION_ACTIONS, "action");
  }
  if (resolvedAction === "edit" && !editing) {
    throw new TypeError("image_generation action \"edit\" requires at least one reference image");
  }
  const tool = { type: "image_generation", action: resolvedAction };
  if (typeof imageModel === "string" && imageModel.trim().length > 0) tool.model = imageModel.trim();
  if (typeof size === "string" && size.trim().length > 0) {
    const trimmed = size.trim();
    assertEnum(trimmed, IMAGE_GENERATION_SIZES, "size");
    tool.size = trimmed;
  }
  if (typeof quality === "string" && quality.trim().length > 0) {
    const trimmed = quality.trim();
    assertEnum(trimmed, IMAGE_GENERATION_QUALITIES, "quality");
    tool.quality = trimmed;
  }
  if (typeof background === "string" && background.trim().length > 0) {
    const trimmed = background.trim();
    assertEnum(trimmed, IMAGE_GENERATION_BACKGROUNDS, "background");
    tool.background = trimmed;
  }
  if (typeof format === "string" && format.trim().length > 0) {
    const trimmed = format.trim();
    assertEnum(trimmed, IMAGE_GENERATION_FORMATS, "output_format");
    tool.output_format = trimmed;
  }
  if (typeof inputFidelity === "string" && inputFidelity.trim().length > 0) {
    if (!editing) {
      throw new TypeError("image_generation input_fidelity applies only to an edit with reference images");
    }
    const trimmed = inputFidelity.trim();
    assertEnum(trimmed, IMAGE_INPUT_FIDELITIES, "input_fidelity");
    tool.input_fidelity = trimmed;
  }
  if (mask !== undefined && mask !== null) {
    if (!editing) {
      throw new TypeError("image_generation input_image_mask applies only to an edit with reference images");
    }
    tool.input_image_mask = toInputImageMask(mask);
  }
  if (tool.background === "transparent" && tool.output_format === "jpeg") {
    throw new TypeError("image_generation cannot combine background \"transparent\" with output_format \"jpeg\" (JPEG has no alpha channel)");
  }
  // Text-to-image keeps the bare-string input; image-to-image needs the message
  // array so the reference images can travel with the instruction.
  const input = editing
    ? [{
      role: "user",
      content: [
        { type: "input_text", text: prompt.trim() },
        ...references.map((image, index) => toInputImageBlock(image, index)),
      ],
    }]
    : prompt.trim();
  return {
    model: responseModel.trim(),
    input,
    stream: false,
    tools: [tool],
    tool_choice: { type: "image_generation" },
    store: false,
  };
}

/**
 * Build the non-streaming `/responses` request body for one image-understanding
 * call: a plain completion whose single user message carries the question plus
 * one `input_image` block per reference image. There is deliberately no
 * `tools` entry and no `tool_choice` — the vision model answers directly
 * instead of invoking the `image_generation` tool.
 * @param options - `question` and `responseModel` (required) plus the non-empty
 *   `images` array of reference image descriptors (see {@link toInputImageBlock}).
 * @returns the wire body.
 * @throws TypeError for a blank question or response model, an empty images
 *   array, or an unusable reference image.
 */
export function buildVisionRequest(options = {}) {
  const { question, responseModel, images } = options;
  if (typeof question !== "string" || question.trim().length === 0) {
    throw new TypeError("question must be a non-empty string");
  }
  if (typeof responseModel !== "string" || responseModel.trim().length === 0) {
    throw new TypeError("responseModel must be a non-empty string");
  }
  if (!Array.isArray(images) || images.length === 0) {
    throw new TypeError("images must be a non-empty array of reference images");
  }
  return {
    model: responseModel.trim(),
    input: [{
      role: "user",
      content: [
        { type: "input_text", text: question.trim() },
        ...images.map((image, index) => toInputImageBlock(image, index)),
      ],
    }],
    stream: false,
    store: false,
  };
}

/**
 * Extract the assistant text of a non-streaming `/responses` completion, the
 * answer side of an image-understanding call. The official shape carries
 * `output` message items whose content blocks are `{ type: "output_text",
 * text }`; a top-level `output_text` convenience string is honored as a
 * fallback for providers that flatten the message away. Refusals surface as
 * REFUSED, top-level API errors as API_ERROR, and a text-less failed or
 * incomplete response as GENERATION_FAILED or INCOMPLETE.
 * @param response - the parsed JSON response object.
 * @returns `{ text, responseId? }`.
 * @throws ImageGenerationError with code API_ERROR, REFUSED, MISSING_OUTPUT,
 *   GENERATION_FAILED, INCOMPLETE, or INVALID_RESPONSE.
 */
export function extractResponseText(response) {
  if (response === null || typeof response !== "object" || Array.isArray(response)) {
    throw new ImageGenerationError("responses payload is not a JSON object", "INVALID_RESPONSE");
  }
  const apiError = response.error;
  if (apiError !== null && typeof apiError === "object") {
    const code = typeof apiError.code === "string" && apiError.code.length > 0 ? apiError.code : "api_error";
    const message = typeof apiError.message === "string" && apiError.message.length > 0 ? apiError.message : "the provider returned an error";
    throw new ImageGenerationError(`image analysis API error (${code}): ${message}`, "API_ERROR");
  }
  const output = response.output;
  if (!Array.isArray(output)) {
    throw new ImageGenerationError("responses payload has no output array", "MISSING_OUTPUT");
  }
  const responseId = typeof response.id === "string" && response.id.length > 0 ? response.id : undefined;
  const parts = [];
  let refusal = null;
  for (const item of output) {
    if (item === null || typeof item !== "object") continue;
    if (item.type === "refusal") {
      refusal = typeof item.refusal === "string" && item.refusal.length > 0
        ? item.refusal
        : "the model refused to answer";
      break;
    }
    if (item.type === "message" && Array.isArray(item.content)) {
      for (const part of item.content) {
        if (part === null || typeof part !== "object") continue;
        if (part.type === "output_text" && typeof part.text === "string" && part.text.trim().length > 0) {
          parts.push(part.text);
        } else if (part.type === "refusal" && refusal === null) {
          refusal = typeof part.refusal === "string" && part.refusal.length > 0
            ? part.refusal
            : "the model refused to answer";
        }
      }
    }
  }
  if (refusal !== null) {
    throw new ImageGenerationError(`image analysis refused: ${refusal}`, "REFUSED");
  }
  const text = parts.join("\n").trim();
  if (text.length > 0) {
    return { text, ...(responseId !== undefined ? { responseId } : {}) };
  }
  // Provider convenience flattening: a top-level output_text string.
  if (typeof response.output_text === "string" && response.output_text.trim().length > 0) {
    return { text: response.output_text.trim(), ...(responseId !== undefined ? { responseId } : {}) };
  }
  if (response.status === "failed") {
    throw new ImageGenerationError("image analysis failed (response status: failed)", "GENERATION_FAILED");
  }
  if (response.status === "incomplete") {
    const reason = response.incomplete_details !== null && typeof response.incomplete_details === "object"
      && typeof response.incomplete_details.reason === "string"
      ? ` (${response.incomplete_details.reason})`
      : "";
    throw new ImageGenerationError(`image analysis did not complete${reason}`, "INCOMPLETE");
  }
  throw new ImageGenerationError("responses payload contains no answer text", "MISSING_OUTPUT");
}

const STANDARD_BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const DATA_URL = /^data:([^;,]*)(?:;[^,]*)?,(.*)$/s;

/**
 * Strictly decode a canonical base64 payload: standard alphabet only, length a
 * multiple of four, padding only at the end, non-empty, and byte-exact
 * round-trip so non-canonical encodings are rejected.
 */
function decodeStrictBase64(value, what) {
  if (typeof value !== "string") {
    throw new ImageGenerationError(`generated image ${what} must be a base64 string`, "BAD_BASE64");
  }
  const b64 = value.trim();
  if (b64.length === 0 || b64.length % 4 !== 0 || !STANDARD_BASE64.test(b64)) {
    throw new ImageGenerationError(
      `generated image ${what} is not strict base64 (standard alphabet, 4-multiple length, trailing padding)`,
      "BAD_BASE64",
    );
  }
  const data = Buffer.from(b64, "base64");
  if (data.length === 0) {
    throw new ImageGenerationError(`generated image ${what} decoded to zero bytes`, "BAD_BASE64");
  }
  if (data.toString("base64") !== b64) {
    throw new ImageGenerationError(`generated image ${what} is not canonical base64`, "BAD_BASE64");
  }
  return data;
}

/**
 * Normalize a declared media type to a stored-media type the attachment seam
 * accepts (`image/jpg` is mapped to `image/jpeg`).
 */
function normalizeMediaType(mediaType) {
  const type = (mediaType ?? "").trim().toLowerCase();
  const mapped = type === "image/jpg" ? "image/jpeg" : type;
  if (!IMAGE_MEDIA_TYPES.includes(mapped)) {
    throw new ImageGenerationError(
      `unsupported generated image media type "${type}" (expected one of ${IMAGE_MEDIA_TYPES.join(", ")})`,
      "UNSUPPORTED_MEDIA_TYPE",
    );
  }
  return mapped;
}

/**
 * Sniff a decoded image's media type from its magic bytes. Returns `null`
 * when the payload is not a recognizable PNG/JPEG/WebP/GIF.
 */
function sniffMediaType(data) {
  if (data.byteLength >= 12) {
    if (
      data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47
      && data[4] === 0x0d && data[5] === 0x0a && data[6] === 0x1a && data[7] === 0x0a
    ) {
      return "image/png";
    }
    if (
      data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46
      && data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50
    ) {
      return "image/webp";
    }
  } else if (
    data.byteLength >= 8
    && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47
    && data[4] === 0x0d && data[5] === 0x0a && data[6] === 0x1a && data[7] === 0x0a
  ) {
    return "image/png";
  }
  if (data.byteLength >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return "image/jpeg";
  }
  if (data.byteLength >= 6) {
    const head = data.subarray(0, 6).toString("ascii");
    if (head === "GIF87a" || head === "GIF89a") return "image/gif";
  }
  return null;
}

/**
 * Resolve the stored media type of an officially-shaped `image_generation_call`
 * result: prefer the type sniffed from the decoded bytes, then fall back to
 * the requested output format, then `image/png`.
 */
function mediaTypeForResult(data, formatHint) {
  const sniffed = sniffMediaType(data);
  if (sniffed !== null) return sniffed;
  if (typeof formatHint === "string" && Object.prototype.hasOwnProperty.call(FORMAT_MEDIA_TYPES, formatHint)) {
    return FORMAT_MEDIA_TYPES[formatHint];
  }
  return "image/png";
}

/**
 * Extract the generated image from a parsed non-streaming `/responses`
 * payload, strictly decoding its base64 bytes. The official shape is an
 * `output` item `{ type: "image_generation_call", result: string, ... }`
 * whose `result` is read directly; the legacy nested
 * `output: [{ type: "image", ... }]` shape is honored only as a documented
 * backward-compatible fallback. Refusals, failed/incomplete calls, top-level
 * API errors, and missing output surface as clear {@link ImageGenerationError}s.
 * @param response - the parsed JSON response object.
 * @param options - optional `maxBytes` bound on the decoded image bytes and
 *   `format` hint (the requested `output_format`) for media-type fallback.
 * @returns `{ data, mediaType, width?, height?, callId?, revisedPrompt?, name?, responseId? }`.
 * @throws ImageGenerationError with code API_ERROR, REFUSED, MISSING_OUTPUT,
 *   GENERATION_FAILED, INCOMPLETE, BAD_BASE64, OVERSIZED,
 *   UNSUPPORTED_MEDIA_TYPE, UNSUPPORTED_IMAGE_URL, or INVALID_RESPONSE.
 */
export function extractGeneratedImage(response, options = {}) {
  const maxBytes = options.maxBytes ?? Infinity;
  if (typeof maxBytes !== "number" || Number.isNaN(maxBytes) || maxBytes <= 0) {
    throw new TypeError("maxBytes must be a positive number (or Infinity for unbounded)");
  }
  const formatHint = typeof options.format === "string" && options.format.length > 0 ? options.format : undefined;
  if (response === null || typeof response !== "object" || Array.isArray(response)) {
    throw new ImageGenerationError("responses payload is not a JSON object", "INVALID_RESPONSE");
  }
  const apiError = response.error;
  if (apiError !== null && typeof apiError === "object") {
    const code = typeof apiError.code === "string" && apiError.code.length > 0 ? apiError.code : "api_error";
    const message = typeof apiError.message === "string" && apiError.message.length > 0 ? apiError.message : "the provider returned an error";
    throw new ImageGenerationError(`image generation API error (${code}): ${message}`, "API_ERROR");
  }
  const output = response.output;
  if (!Array.isArray(output)) {
    throw new ImageGenerationError("responses payload has no output array", "MISSING_OUTPUT");
  }
  const responseId = typeof response.id === "string" && response.id.length > 0 ? response.id : undefined;
  let firstFailure = null; // { code, message } from the first unusable official call item.
  for (const item of output) {
    if (item === null || typeof item !== "object") continue;
    if (item.type === "refusal") {
      const text = typeof item.refusal === "string" && item.refusal.length > 0
        ? item.refusal
        : "the model refused to generate an image";
      throw new ImageGenerationError(`image generation refused: ${text}`, "REFUSED");
    }
    if (item.type === "message" && Array.isArray(item.content)) {
      for (const part of item.content) {
        if (part !== null && typeof part === "object" && part.type === "refusal") {
          const text = typeof part.refusal === "string" && part.refusal.length > 0
            ? part.refusal
            : "the model refused to generate an image";
          throw new ImageGenerationError(`image generation refused: ${text}`, "REFUSED");
        }
      }
    }
    if (item.type !== "image_generation_call") continue;
    const status = item.status;
    if (status === "failed") {
      if (firstFailure === null) {
        const detail = typeof item.error === "string" && item.error.length > 0
          ? item.error
          : typeof item.status_detail === "string" && item.status_detail.length > 0
            ? item.status_detail
            : "";
        firstFailure = {
          code: "GENERATION_FAILED",
          message: `image generation failed${detail.length > 0 ? `: ${detail}` : ""}`,
        };
      }
      continue;
    }
    if (status === "in_progress" || status === "generating") {
      if (firstFailure === null) {
        firstFailure = {
          code: "INCOMPLETE",
          message: `image generation call did not complete (status: ${status})`,
        };
      }
      continue;
    }
    // completed (or status omitted): a non-empty direct `result` is the image.
    if (typeof item.result === "string" && item.result.trim().length > 0) {
      const data = decodeStrictBase64(item.result, "result");
      if (data.byteLength > maxBytes) {
        throw new ImageGenerationError(
          `generated image is ${data.byteLength} bytes, exceeding the ${maxBytes}-byte bound`,
          "OVERSIZED",
        );
      }
      const result = { data, mediaType: mediaTypeForResult(data, formatHint) };
      if (responseId !== undefined) result.responseId = responseId;
      const callId = typeof item.id === "string" && item.id.length > 0
        ? item.id
        : typeof item.call_id === "string" && item.call_id.length > 0
          ? item.call_id
          : undefined;
      if (callId !== undefined) result.callId = callId;
      const revised = typeof item.revised_prompt === "string" && item.revised_prompt.length > 0 ? item.revised_prompt : undefined;
      if (revised !== undefined) result.revisedPrompt = revised;
      return result;
    }
    if (firstFailure === null) {
      firstFailure = {
        code: "MISSING_OUTPUT",
        message: "image_generation_call has no base64 image data",
      };
    }
  }
  // Backward-compatible fallback (legacy providers): nested `output` arrays of
  // `{ type: "image", image_url|b64_json }` entries. Runs only when the
  // official direct `result` path found nothing above.
  for (const item of output) {
    if (item === null || typeof item !== "object") continue;
    const candidates = [];
    if (Array.isArray(item.output)) candidates.push(...item.output);
    if (item.type === "image") candidates.push(item);
    for (const entry of candidates) {
      if (entry === null || typeof entry !== "object" || entry.type !== "image") continue;
      const image = parseLegacyImageEntry(entry, item, maxBytes);
      if (image !== null) {
        if (responseId !== undefined && image.responseId === undefined) image.responseId = responseId;
        return image;
      }
    }
  }
  if (firstFailure !== null) {
    throw new ImageGenerationError(firstFailure.message, firstFailure.code);
  }
  throw new ImageGenerationError("responses payload contains no generated image output", "MISSING_OUTPUT");
}

/** Decode one legacy image entry, attaching call-level metadata; `null` when the entry carries no payload. */
function parseLegacyImageEntry(entry, item, maxBytes) {
  const imageUrl = entry.image_url;
  const b64 = entry.b64_json;
  let data;
  let mediaType;
  if (typeof imageUrl === "string" && imageUrl.length > 0) {
    if (!imageUrl.startsWith("data:")) {
      throw new ImageGenerationError(
        "generated image image_url is not a data: URL (a remote URL would require a network fetch)",
        "UNSUPPORTED_IMAGE_URL",
      );
    }
    const match = DATA_URL.exec(imageUrl.trim());
    if (match === null) {
      throw new ImageGenerationError("generated image image_url is not a well-formed data: URL", "BAD_BASE64");
    }
    const [, declaredType, payload] = match;
    mediaType = declaredType.length > 0 ? normalizeMediaType(declaredType) : "image/png";
    data = decodeStrictBase64(payload, "data URL payload");
  } else if (typeof b64 === "string" && b64.length > 0) {
    mediaType = normalizeMediaType(entry.media_type ?? "image/png");
    data = decodeStrictBase64(b64, "b64_json");
  } else {
    return null;
  }
  if (data.byteLength > maxBytes) {
    throw new ImageGenerationError(
      `generated image is ${data.byteLength} bytes, exceeding the ${maxBytes}-byte bound`,
      "OVERSIZED",
    );
  }
  const result = {
    data,
    mediaType,
    ...(typeof entry.width === "number" && Number.isInteger(entry.width) && entry.width > 0 ? { width: entry.width } : {}),
    ...(typeof entry.height === "number" && Number.isInteger(entry.height) && entry.height > 0 ? { height: entry.height } : {}),
  };
  const callId = typeof item.call_id === "string" && item.call_id.length > 0
    ? item.call_id
    : typeof item.id === "string" && item.id.length > 0
      ? item.id
      : undefined;
  const revised = typeof item.revised_prompt === "string" && item.revised_prompt.length > 0
    ? item.revised_prompt
    : typeof entry.revised_prompt === "string" && entry.revised_prompt.length > 0
      ? entry.revised_prompt
      : undefined;
  if (callId !== undefined) result.callId = callId;
  if (revised !== undefined) result.revisedPrompt = revised;
  const name = typeof entry.name === "string" && entry.name.length > 0 ? entry.name : undefined;
  if (name !== undefined) result.name = name;
  return result;
}
