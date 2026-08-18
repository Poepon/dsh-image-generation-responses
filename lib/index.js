/**
 * Standalone Cordis plugin for DeepSeek Harness: model-facing image tools over
 * a Responses API `/responses` endpoint — `generate_image` (text-to-image and
 * image-to-image editing through the built-in `image_generation` tool, e.g.
 * `gpt-image-2`) and `analyze_image` (image understanding through a plain
 * vision completion).
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
 * The model-facing result carries the image ContentBlock only when the
 * conversation model's route declares image input (resolved through
 * `llm.resolveModelInfo` against the session's folded request header).
 * Adapters such as pi-ai reject a whole turn with `UNSUPPORTED_CONTENT` when
 * nested tool-result content holds an image the model cannot read, so the
 * gate is conservative: any unknown capability yields a text-only result that
 * still names the saved attachment id. The UI is unaffected — the client
 * renders from the presentation meta either way.
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
  buildVisionRequest,
  extractGeneratedImage,
  extractResponseText,
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
  buildVisionRequest,
  extractGeneratedImage,
  extractResponseText,
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
  /** Model answering analyze_image vision calls; defaults to responseModel. */
  visionModel: undefined,
  /** Cooperative per-call timeout in milliseconds (also the tool timeoutMs). */
  timeoutMs: 120_000,
  /** Bound on the response body and on the decoded image bytes. */
  maxResponseBytes: 32 * 1024 * 1024,
});

/** Maximum reference images accepted in one edit call. */
export const MAX_REFERENCE_IMAGES = 8;

/**
 * Whether the conversation model for this call accepts image input.
 *
 * The generated image must only ride the model-facing tool result when the
 * conversation model can actually read it: adapters such as pi-ai hard-fail the
 * whole turn (`UNSUPPORTED_CONTENT`) when any nested tool-result content
 * carries an image block the model does not support. The route is read from
 * the calling session's folded request header — the exact provider/model of
 * the in-flight request, which survives waterfall-based route selection — and
 * the modality list comes from `llm.resolveModelInfo`.
 *
 * Conservative by contract: any failure to establish capability — no agent, no
 * header yet, no `llm` service, an adapter that reports no modalities, or a
 * lookup that throws — answers `false`, so an unknown model gets a text-only
 * result instead of a crashed turn.
 * @param ctx - plugin context.
 * @param exec - the tool execution (agent and signal).
 * @returns true only when the resolved model explicitly declares image input.
 */
export async function modelAcceptsImages(ctx, exec) {
  try {
    const llm = ctx.get("llm");
    if (llm === undefined) return false;
    const session = exec.agent?.session;
    const header = typeof session?.requestHeader === "function" ? session.requestHeader() : undefined;
    const config = header?.config;
    if (config === undefined
      || typeof config.provider !== "string" || config.provider.length === 0
      || typeof config.model !== "string" || config.model.length === 0) {
      return false;
    }
    const info = await llm.resolveModelInfo(config.provider, config.model, exec.signal);
    return Array.isArray(info?.inputModalities) && info.inputModalities.includes("image");
  } catch {
    return false;
  }
}

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
  // The vision route for analyze_image; defaults to the generation response
  // model, which is already the deployment's image-capable Responses model.
  const visionModel = typeof cfg.visionModel === "string" && cfg.visionModel.trim().length > 0
    ? cfg.visionModel.trim()
    : cfg.responseModel;

  /**
   * Read every requested reference image from the calling session and encode
   * it for the wire. Shared by generate_image (editing) and analyze_image.
   * `readImage` verifies the whole reference against the stored bytes, so the
   * exact one is recovered from the session's own durable log — which also
   * confines both tools to images this session can already see.
   */
  async function readSessionReferences(exec, requested, toolLabel) {
    const agent = exec.agent;
    if (agent === undefined) {
      throw new ImageGenerationError(
        `${toolLabel}: resolving attachment ids needs a calling session`,
        "NO_SESSION",
      );
    }
    const visible = indexSessionImages(agent.session);
    const references = [];
    for (const id of requested) {
      if (typeof id !== "string" || id.length === 0) {
        throw new ImageGenerationError(
          `${toolLabel}: every entry of images must be a non-empty attachment id`,
          "INVALID_IMAGE_REFERENCE",
        );
      }
      const found = visible.get(id);
      if (found === undefined) {
        throw new ImageGenerationError(
          `${toolLabel}: no image attachment "${id}" is visible in this conversation`,
          "IMAGE_NOT_FOUND",
        );
      }
      let stored;
      try {
        stored = await ctx.attachments.readImage(found, exec.signal);
      } catch (error) {
        if (exec.signal.aborted) throw error;
        throw new ImageGenerationError(
          `${toolLabel}: unable to read image attachment "${id}": ${safeErrorText(error?.message ?? error)}`,
          "IMAGE_READ_FAILED",
          { cause: error },
        );
      }
      references.push({
        mediaType: stored.ref.mediaType,
        base64: Buffer.from(stored.data).toString("base64"),
      });
    }
    return references;
  }

  /**
   * POST one non-streaming `/responses` request with the per-call credential
   * and read its bounded JSON body. Shared transport for both tools.
   */
  async function postResponses(request, exec, toolLabel) {
    // Resolve the credential per call so a changed key reaches the next call.
    const resolved = await ctx.credentials.resolve(ref);
    if (resolved === undefined || resolved.value.length === 0) {
      throw new ImageGenerationError(
        `${toolLabel}: no API key configured for ${cfg.apiKeyEnv} — store it through the credentials service or export it in the environment`,
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
          `${toolLabel}: provider request timed out after ${cfg.timeoutMs}ms`,
          "TIMEOUT",
          { cause: error },
        );
      }
      throw new ImageGenerationError(
        `${toolLabel}: provider request failed: ${safeErrorText(error?.message ?? error)}`,
        "TRANSPORT",
        { cause: error },
      );
    }
    try {
      return await readBoundedJson(response, cfg.maxResponseBytes, toolLabel);
    } catch (error) {
      if (exec.signal.aborted) throw error;
      if (error instanceof ImageGenerationError) throw error;
      throw new ImageGenerationError(
        `${toolLabel}: reading the provider response failed: ${safeErrorText(error?.message ?? error)}`,
        "TRANSPORT",
        { cause: error },
      );
    }
  }

  ctx.tools.register(defineTool({
    name: "generate_image",
    description:
      "Generate an image from a natural-language prompt, or edit existing images from this conversation by passing their attachment ids, using the configured image generation model. The result is durably saved as an attachment and its metadata returned; the result text names the attachment id — pass it to analyze_image to inspect or review the image (the way to see results when the conversation model has no image input).",
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
          modelSeesImage: { type: "boolean" },
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
        const text = `${verb} (${detail})${from}${subject ? `: ${subject}` : ""}. Saved as attachment ${value.attachment.attachmentId}.`;
        const blocks = [{ type: "text", text }];
        // The image block reaches the model only when its route accepts image
        // input; a text-only model still learns the attachment id for later
        // edit calls, and the UI renders the result from presentation meta.
        if (value.modelSeesImage === true) {
          blocks.push({ type: "image", attachment: value.attachment });
        }
        return blocks;
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
      const references = requested.length > 0
        ? await readSessionReferences(exec, requested, "generate_image")
        : [];
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
      const payload = await postResponses(request, exec, "generate_image");
      const image = extractGeneratedImage(payload, {
        maxBytes: cfg.maxResponseBytes,
        format: request.tools[0].output_format,
      });
      const saved = await ctx.attachments.saveImage({
        data: image.data,
        mediaType: image.mediaType,
        ...(image.name !== undefined ? { name: image.name } : {}),
      });
      // Gate the model-facing image block on the conversation model's declared
      // input modalities; text-only routes must never see one (pi-ai aborts the
      // whole turn with UNSUPPORTED_CONTENT otherwise).
      const modelSeesImage = await modelAcceptsImages(ctx, exec);
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
        modelSeesImage,
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

  ctx.tools.register(defineTool({
    name: "analyze_image",
    description:
      "Answer a question about images from this conversation — describe content, read text, compare, or inspect details. The images are read by a vision model over the same Responses endpoint, so the conversation model itself does not need image input. Pass attachment ids of images already present in this conversation; pair with generate_image, whose result text names the saved attachment id, to review a generated image before editing it.",
    parameters: {
      question: {
        type: "string",
        required: true,
        description: "What to answer about the images, in natural language.",
      },
      images: {
        type: "array",
        required: true,
        items: { type: "string" },
        description: `Attachment ids of images already present in this conversation. Up to ${MAX_REFERENCE_IMAGES}.`,
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          answer: { type: "string", required: true },
          model: { type: "string", required: true },
          sourceImages: { type: "array", required: true, items: { type: "string" } },
          responseId: { type: "string" },
        },
      },
      // The answer is pure text: no image blocks, so no capability gating is
      // needed and text-only conversation models are always safe.
      render: (_args, value) => [{ type: "text", text: value.answer }],
      presentationMeta: (_args, value) => value,
    },
    timeoutMs: cfg.timeoutMs,
    async execute(args, exec) {
      const requested = Array.isArray(args.images) ? args.images : [];
      if (requested.length === 0) {
        throw new ImageGenerationError(
          "analyze_image: at least one image attachment id is required",
          "MISSING_INPUT",
        );
      }
      if (requested.length > MAX_REFERENCE_IMAGES) {
        throw new ImageGenerationError(
          `analyze_image: at most ${MAX_REFERENCE_IMAGES} images are supported (received ${requested.length})`,
          "TOO_MANY_IMAGES",
        );
      }
      const references = await readSessionReferences(exec, requested, "analyze_image");
      const request = buildVisionRequest({
        question: args.question,
        responseModel: visionModel,
        images: references,
      });
      const payload = await postResponses(request, exec, "analyze_image");
      const answer = extractResponseText(payload);
      return {
        answer: answer.text,
        model: visionModel,
        sourceImages: [...requested],
        ...(answer.responseId !== undefined ? { responseId: answer.responseId } : {}),
      };
    },
    presentCall: (args) => ({
      card: "generic",
      title: "Analyze image",
      kind: "other",
      rawInput: args.question,
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
async function readBoundedJson(response, maxBytes, label = "generate_image") {
  if (!response.ok) {
    let detail = "";
    try {
      const body = await readBoundedBytes(response, maxBytes, label);
      const parsed = JSON.parse(body.toString("utf8"));
      const apiError = parsed !== null && typeof parsed === "object" ? parsed.error : undefined;
      if (apiError !== null && typeof apiError === "object" && typeof apiError.message === "string" && apiError.message.length > 0) {
        const safe = safeErrorText(apiError.message);
        if (safe.length > 0) detail = `: ${safe}`;
      }
    } catch {
      // Keep the HTTP status as the primary signal when the body is unreadable.
    }
    throw new ImageGenerationError(`${label}: HTTP ${response.status} from image provider${detail}`, "HTTP_ERROR", {
      status: response.status,
    });
  }
  const bytes = await readBoundedBytes(response, maxBytes, label);
  let payload;
  try {
    payload = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new ImageGenerationError(`${label}: response body is not valid JSON`, "INVALID_RESPONSE", { cause: error });
  }
  return payload;
}

/** Drain a fetch response body, aborting once it exceeds `maxBytes`. */
async function readBoundedBytes(response, maxBytes, label = "generate_image") {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new ImageGenerationError(
      `${label}: response body length ${declared} exceeds the ${maxBytes}-byte bound`,
      "OVERSIZED",
    );
  }
  if (response.body === null) {
    throw new ImageGenerationError(`${label}: response has no body`, "EMPTY_RESPONSE");
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
        `${label}: response body exceeds the ${maxBytes}-byte bound`,
        "OVERSIZED",
      );
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}
