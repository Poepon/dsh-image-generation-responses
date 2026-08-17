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
  IMAGE_GENERATION_BACKGROUNDS,
  IMAGE_GENERATION_FORMATS,
  IMAGE_GENERATION_QUALITIES,
  IMAGE_GENERATION_SIZES,
  IMAGE_MEDIA_TYPES,
  ImageGenerationError,
  buildImageGenerationRequest,
  extractGeneratedImage,
  normalizeResponsesUrl,
  responsesEndpoint,
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
      "Generate an image from a natural-language prompt using the configured image generation model, durably save it as an attachment, and return its metadata.",
    parameters: {
      prompt: {
        type: "string",
        required: true,
        description: "The image to generate, described in natural language.",
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
          callId: { type: "string" },
          revisedPrompt: { type: "string" },
          responseId: { type: "string" },
        },
      },
      render: (_args, value) => {
        const detail = [value.format, value.size, value.quality].filter(Boolean).join(", ");
        const subject = value.revisedPrompt ?? value.attachment.name;
        return [
          { type: "text", text: `Generated image (${detail})${subject ? `: ${subject}` : ""}.` },
          { type: "image", attachment: value.attachment },
        ];
      },
      presentationMeta: (_args, value) => value,
    },
    timeoutMs: cfg.timeoutMs,
    async execute(args, exec) {
      const request = buildImageGenerationRequest({
        prompt: args.prompt,
        responseModel: cfg.responseModel,
        imageModel: cfg.imageModel,
        size: args.size ?? cfg.size,
        quality: args.quality ?? cfg.quality,
        background: args.background ?? cfg.background,
        format: args.format ?? cfg.format,
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
