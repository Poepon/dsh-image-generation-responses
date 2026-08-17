/**
 * Standalone Cordis plugin for DeepSeek Harness: the model-facing
 * `generate_image` tool over a Responses API `/responses` endpoint using
 * the built-in `image_generation` tool (`gpt-image-2`).
 *
 * The plugin injects `tools`, `credentials`, and `attachments`. Per call it
 * resolves the configured `apiKeyEnv` reference through `ctx.credentials`,
 * POSTs a non-streaming request to `{normalized baseURL}/responses` with the
 * bearer credential and standard attribution headers, reads a bounded JSON
 * response, strictly decodes the generated image, persists it through
 * `ctx.attachments.saveImage`, and returns canonical JSON output metadata.
 * Failures surface as clear `ImageGenerationError`s (HTTP, API, refusal,
 * missing output, invalid base64, oversized).
 *
 * The tool covers both directions. Passing `images` — attachment ids already
 * present in the calling session — turns the call into image-to-image editing:
 * the referenced bytes are read back through `ctx.attachments.readImage` and
 * ride the request as `input_image` blocks. `readImage` verifies the FULL
 * reference (media type, byte length, and intrinsic dimensions) against the
 * stored object, so an id alone is not enough; the exact reference is recovered
 * from the calling session's own durable log, which also scopes editing to
 * images the session can legitimately see.
 *
 * Protocol logic lives in `lib/protocol.js` as pure, dependency-free helpers.
 *
 * @module dsh-image-generation-responses
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { attributionHeaders } from "@deepseek-ai/dsh-llm";
import {
  ImageGenerationError,
  buildImageGenerationRequest,
  extractGeneratedImage,
  responsesEndpoint,
} from "./protocol.js";

export {
  FORMAT_MEDIA_TYPES,
  IMAGE_GENERATION_ACTIONS,
  IMAGE_GENERATION_BACKGROUNDS,
  IMAGE_GENERATION_FORMATS,
  IMAGE_GENERATION_QUALITIES,
  IMAGE_GENERATION_SIZES,
  IMAGE_INPUT_DETAILS,
  IMAGE_INPUT_FIDELITIES,
  IMAGE_MEDIA_TYPES,
  ImageGenerationError,
  buildImageGenerationRequest,
  extractGeneratedImage,
  normalizeResponsesUrl,
  responsesEndpoint,
  toImageDataUrl,
} from "./protocol.js";

/** Cordis plugin name used by loader diagnostics. */
export const name = "dsh-image-generation-responses";
/** Services this plugin requires; it only loads while all are available. */
export const inject = ["tools", "credentials", "attachments"];

/** Default configuration, all overridable per deployment. */
export const DEFAULT_CONFIG = Object.freeze({
  /** Responses API host; the plugin POSTs `{baseURL}/responses`. */
  baseURL: "https://api.openai.com/v1",
  /** Environment-variable reference resolved per call through ctx.credentials. */
  apiKeyEnv: "OPENAI_API_KEY",
  /** Top-level `model` of the /responses request (the response model). */
  responseModel: "gpt-5.6-sol",
  /** Model named in the image_generation tool entry. */
  imageModel: "gpt-image-2",
  /** Default generation size; the model may override per call. */
  size: "1024x1024",
  /** Default quality: low | medium | high | auto. */
  quality: "medium",
  /** Default background: opaque | transparent | auto. */
  background: "opaque",
  /** Default output format: png | jpeg | webp. */
  format: "png",
  /** Cooperative per-call timeout in milliseconds (also the tool timeoutMs). */
  timeoutMs: 120_000,
  /** Bound on the response body and on the decoded image bytes. */
  maxResponseBytes: 32 * 1024 * 1024,
});

/** Maximum reference images accepted in one edit call. */
export const MAX_REFERENCE_IMAGES = 8;

/**
 * Structurally validate a durable image reference recovered from a session log.
 * `attachments.readImage` re-derives media type, byte length, and dimensions
 * from the stored bytes and rejects any mismatch, so a partial reference cannot
 * be used to read an attachment.
 * @param value - candidate reference.
 * @returns whether it is a complete `ImageAttachmentRef`.
 */
function isImageRef(value) {
  return value !== null
    && typeof value === "object"
    && typeof value.attachmentId === "string"
    && value.attachmentId.length > 0
    && typeof value.mediaType === "string"
    && Number.isFinite(value.bytes)
    && Number.isFinite(value.width)
    && Number.isFinite(value.height);
}

/**
 * Index every durable image reference visible in one session's log, keyed by
 * attachment id, newest occurrence winning.
 *
 * Walks only leaf fields of the append-only event log: image ContentBlocks in
 * message-shaped payloads and the `attachment` field of this tool's own
 * presentation meta. Event payloads are frozen at acceptance, so nothing here
 * mutates history; unknown event shapes contribute nothing rather than throwing.
 * @param session - the calling agent's live session.
 * @returns a Map from attachment id to its complete reference.
 */
export function indexSessionImages(session) {
  const found = new Map();
  const events = session === undefined || session === null ? undefined : session.events;
  if (!Array.isArray(events)) return found;
  const visitContent = (content) => {
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (block !== null && typeof block === "object" && block.type === "image" && isImageRef(block.attachment)) {
        found.set(block.attachment.attachmentId, block.attachment);
      }
    }
  };
  for (const event of events) {
    const data = event === null || typeof event !== "object" ? undefined : event.data;
    if (data === null || typeof data !== "object") continue;
    visitContent(data.content);
    if (data.message !== null && typeof data.message === "object") visitContent(data.message.content);
    // This tool's own results carry the saved reference in presentation meta,
    // which survives even when the rendered content blocks were pruned.
    const meta = data.meta;
    if (meta !== null && typeof meta === "object" && isImageRef(meta.attachment)) {
      found.set(meta.attachment.attachmentId, meta.attachment);
    }
  }
  return found;
}

/** Apply the plugin: register the `generate_image` tool on `ctx.tools`. */
export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  if (typeof cfg.timeoutMs !== "number" || !Number.isFinite(cfg.timeoutMs) || cfg.timeoutMs <= 0) {
    throw new TypeError("config.timeoutMs must be a positive finite number");
  }
  if (typeof cfg.maxResponseBytes !== "number" || !Number.isFinite(cfg.maxResponseBytes) || cfg.maxResponseBytes <= 0) {
    throw new TypeError("config.maxResponseBytes must be a positive finite number");
  }
  // Validates and normalizes the configured base URL at load time.
  const endpoint = responsesEndpoint(cfg.baseURL);
  const ref = credentialRef(cfg.apiKeyEnv);

  ctx.tools.register(defineTool({
    name: "generate_image",
    description:
      "Generate an image from a natural-language prompt, or edit existing images from this conversation by passing their attachment ids, using the configured image generation model. The result is durably saved as an attachment and its metadata returned.",
    parameters: {
      prompt: {
        type: "string",
        required: true,
        description:
          "What to create. With `images`, this is the edit instruction describing how to transform them.",
      },
      images: {
        type: "array",
        items: { type: "string" },
        description:
          `Attachment ids of images already present in this conversation, to edit instead of generating from scratch (image-to-image). Up to ${MAX_REFERENCE_IMAGES}; omit for text-to-image.`,
      },
      input_fidelity: {
        type: "string",
        enum: ["high", "low"],
        description:
          "How strictly to preserve the input images' style and features, especially faces. Only valid with `images`. Defaults to the provider's value.",
      },
      size: {
        type: "string",
        enum: ["1024x1024", "1024x1536", "1536x1024", "auto"],
        description: `Output size (1024x1024, 1024x1536, 1536x1024, auto). Defaults to ${cfg.size}.`,
      },
      quality: {
        type: "string",
        enum: ["low", "medium", "high", "auto"],
        description: `Generation quality. Defaults to ${cfg.quality}.`,
      },
      background: {
        type: "string",
        enum: ["opaque", "transparent", "auto"],
        description: `Background treatment. Defaults to ${cfg.background}.`,
      },
      format: {
        type: "string",
        enum: ["png", "jpeg", "webp"],
        description: `Output image format. Defaults to ${cfg.format}.`,
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          attachment: {
            type: "object",
            required: true,
            additionalProperties: false,
            properties: {
              attachmentId: { type: "string", required: true },
              mediaType: { type: "string", required: true },
              bytes: { type: "integer", required: true },
              width: { type: "integer", required: true },
              height: { type: "integer", required: true },
              name: { type: "string" },
            },
          },
          model: { type: "string", required: true },
          responseModel: { type: "string", required: true },
          size: { type: "string", required: true },
          quality: { type: "string", required: true },
          background: { type: "string", required: true },
          format: { type: "string", required: true },
          action: { type: "string", required: true },
          sourceImages: { type: "array", items: { type: "string" } },
          inputFidelity: { type: "string" },
          callId: { type: "string" },
          revisedPrompt: { type: "string" },
          responseId: { type: "string" },
        },
      },
      render: (_args, value) => {
        const detail = [value.format, value.size, value.quality].filter(Boolean).join(", ");
        const subject = value.revisedPrompt ?? value.attachment.name;
        const verb = value.action === "edit" ? "Edited image" : "Generated image";
        const from = Array.isArray(value.sourceImages) && value.sourceImages.length > 0
          ? ` from ${value.sourceImages.length} reference image${value.sourceImages.length === 1 ? "" : "s"}`
          : "";
        return [
          { type: "text", text: `${verb} (${detail})${from}${subject ? `: ${subject}` : ""}.` },
          { type: "image", attachment: value.attachment },
        ];
      },
      presentationMeta: (_args, value) => value,
    },
    timeoutMs: cfg.timeoutMs,
    async execute(args, exec) {
      // Resolve reference images before anything else: an unusable id is a
      // caller error and must not spend a credential or a provider call.
      const requested = Array.isArray(args.images) ? args.images : [];
      if (requested.length > MAX_REFERENCE_IMAGES) {
        throw new ImageGenerationError(
          `generate_image: at most ${MAX_REFERENCE_IMAGES} reference images are supported (received ${requested.length})`,
          "TOO_MANY_IMAGES",
        );
      }
      const references = [];
      if (requested.length > 0) {
        const agent = exec.agent;
        if (agent === undefined) {
          throw new ImageGenerationError(
            "generate_image: editing needs a calling session to resolve attachment ids against",
            "NO_SESSION",
          );
        }
        // readImage verifies the whole reference against the stored bytes, so
        // the exact one is recovered from the session's own durable log. That
        // also confines editing to images this session can already see.
        const visible = indexSessionImages(agent.session);
        for (const id of requested) {
          if (typeof id !== "string" || id.length === 0) {
            throw new ImageGenerationError(
              "generate_image: every entry of images must be a non-empty attachment id",
              "INVALID_IMAGE_REFERENCE",
            );
          }
          const found = visible.get(id);
          if (found === undefined) {
            throw new ImageGenerationError(
              `generate_image: no image attachment "${id}" is visible in this conversation`,
              "IMAGE_NOT_FOUND",
            );
          }
          let stored;
          try {
            stored = await ctx.attachments.readImage(found, exec.signal);
          } catch (error) {
            if (exec.signal.aborted) throw error;
            throw new ImageGenerationError(
              `generate_image: unable to read image attachment "${id}": ${safeErrorText(error?.message ?? error)}`,
              "IMAGE_READ_FAILED",
              { cause: error },
            );
          }
          references.push({
            mediaType: stored.ref.mediaType,
            base64: Buffer.from(stored.data).toString("base64"),
          });
        }
      }
      const request = buildImageGenerationRequest({
        prompt: args.prompt,
        responseModel: cfg.responseModel,
        imageModel: cfg.imageModel,
        size: args.size ?? cfg.size,
        quality: args.quality ?? cfg.quality,
        background: args.background ?? cfg.background,
        format: args.format ?? cfg.format,
        images: references.length > 0 ? references : undefined,
        inputFidelity: references.length > 0 ? args.input_fidelity : undefined,
      });
      // Resolve the credential per call so a changed key reaches the next call.
      const resolved = await ctx.credentials.resolve(ref);
      if (resolved === undefined || resolved.value.length === 0) {
        throw new ImageGenerationError(
          `generate_image: no API key configured for ${cfg.apiKeyEnv} — store it through the credentials service or export it in the environment`,
          "MISSING_CREDENTIAL",
        );
      }
      const signal = AbortSignal.any([exec.signal, AbortSignal.timeout(cfg.timeoutMs)]);
      let response;
      try {
        response = await fetch(endpoint, {
          method: "POST",
          headers: {
            authorization: `Bearer ${resolved.value}`,
            "content-type": "application/json",
            accept: "application/json",
            ...attributionHeaders(),
          },
          body: JSON.stringify(request),
          redirect: "error",
          signal,
        });
      } catch (error) {
        if (exec.signal.aborted) throw error;
        if (signal.aborted && !exec.signal.aborted) {
          throw new ImageGenerationError(
            `generate_image: provider request timed out after ${cfg.timeoutMs}ms`,
            "TIMEOUT",
            { cause: error },
          );
        }
        throw new ImageGenerationError(
          `generate_image: provider request failed: ${safeErrorText(error?.message ?? error)}`,
          "TRANSPORT",
          { cause: error },
        );
      }
      let payload;
      try {
        payload = await readBoundedJson(response, cfg.maxResponseBytes);
      } catch (error) {
        if (exec.signal.aborted) throw error;
        if (error instanceof ImageGenerationError) throw error;
        throw new ImageGenerationError(
          `generate_image: reading the provider response failed: ${safeErrorText(error?.message ?? error)}`,
          "TRANSPORT",
          { cause: error },
        );
      }
      const image = extractGeneratedImage(payload, {
        maxBytes: cfg.maxResponseBytes,
        format: request.tools[0].output_format,
      });
      const saved = await ctx.attachments.saveImage({
        data: image.data,
        mediaType: image.mediaType,
        ...(image.name !== undefined ? { name: image.name } : {}),
      });
      return {
        attachment: {
          attachmentId: saved.attachmentId,
          mediaType: saved.mediaType,
          bytes: saved.bytes,
          width: saved.width,
          height: saved.height,
          ...(saved.name !== undefined ? { name: saved.name } : {}),
        },
        model: request.tools[0].model ?? cfg.imageModel,
        responseModel: request.model ?? cfg.responseModel,
        size: request.tools[0].size ?? cfg.size,
        quality: request.tools[0].quality ?? cfg.quality,
        background: request.tools[0].background ?? cfg.background,
        format: request.tools[0].output_format ?? cfg.format,
        action: request.tools[0].action,
        ...(requested.length > 0 ? { sourceImages: [...requested] } : {}),
        ...(request.tools[0].input_fidelity !== undefined
          ? { inputFidelity: request.tools[0].input_fidelity }
          : {}),
        ...(image.callId !== undefined ? { callId: image.callId } : {}),
        ...(image.revisedPrompt !== undefined ? { revisedPrompt: image.revisedPrompt } : {}),
        ...(image.responseId !== undefined ? { responseId: image.responseId } : {}),
      };
    },
    presentCall: (args) => ({
      card: "generic",
      title: "Generate image",
      kind: "other",
      rawInput: args.prompt,
    }),
  }));
}

/** Remove control characters and cap provider-controlled text before surfacing it. */
function safeErrorText(value, maxLength = 500) {
  const normalized = String(value)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength)}…`;
}

/**
 * Read and parse a fetch response as JSON, bounded to `maxBytes` of encoded
 * body. Non-2xx responses surface as HTTP_ERROR carrying the provider's error
 * message when the body parses.
 */
async function readBoundedJson(response, maxBytes) {
  if (!response.ok) {
    let detail = "";
    try {
      const body = await readBoundedBytes(response, maxBytes);
      const parsed = JSON.parse(body.toString("utf8"));
      const apiError = parsed !== null && typeof parsed === "object" ? parsed.error : undefined;
      if (apiError !== null && typeof apiError === "object" && typeof apiError.message === "string" && apiError.message.length > 0) {
        const safe = safeErrorText(apiError.message);
        if (safe.length > 0) detail = `: ${safe}`;
      }
    } catch {
      // Keep the HTTP status as the primary signal when the body is unreadable.
    }
    throw new ImageGenerationError(`generate_image: HTTP ${response.status} from image provider${detail}`, "HTTP_ERROR", {
      status: response.status,
    });
  }
  const bytes = await readBoundedBytes(response, maxBytes);
  let payload;
  try {
    payload = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new ImageGenerationError("generate_image: response body is not valid JSON", "INVALID_RESPONSE", { cause: error });
  }
  return payload;
}

/** Drain a fetch response body, aborting once it exceeds `maxBytes`. */
async function readBoundedBytes(response, maxBytes) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new ImageGenerationError(
      `generate_image: response body length ${declared} exceeds the ${maxBytes}-byte bound`,
      "OVERSIZED",
    );
  }
  if (response.body === null) {
    throw new ImageGenerationError("generate_image: response has no body", "EMPTY_RESPONSE");
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new ImageGenerationError(
        `generate_image: response body exceeds the ${maxBytes}-byte bound`,
        "OVERSIZED",
      );
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}
