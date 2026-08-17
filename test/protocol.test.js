/**
 * node:test suite for the pure protocol helpers of
 * dsh-image-generation-responses (`lib/protocol.js`). Asserts the exact
 * official Responses API wire shape (flat `image_generation` tool entry,
 * `tool_choice: { type: "image_generation" }`, `stream: false`, no `name`,
 * no nested `options`), generation-parameter enum validation, and parsing of
 * the official `image_generation_call` output item (direct `result` base64,
 * refusals, failures, top-level `response.id`), plus the clearly-marked
 * backward-compatible legacy nested shape.
 *
 * @module dsh-image-generation-responses/test
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
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
} from "../lib/protocol.js";

/** A tiny valid 1x1 PNG byte payload for decoding tests. */
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/** Assert that `fn` throws an ImageGenerationError with the given code. */
function assertImageGenerationError(fn, code, messagePart = "") {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof ImageGenerationError, `expected ImageGenerationError, got ${error?.constructor?.name}`);
    assert.equal(error.code, code);
    if (messagePart.length > 0) assert.ok(error.message.includes(messagePart), `message ${JSON.stringify(error.message)} lacks ${JSON.stringify(messagePart)}`);
    return true;
  });
}

test("normalizeResponsesUrl strips trailing slashes, query, hash, and whitespace", () => {
  assert.equal(normalizeResponsesUrl("https://api.openai.com/v1/"), "https://api.openai.com/v1");
  assert.equal(normalizeResponsesUrl("https://api.openai.com"), "https://api.openai.com");
  assert.equal(normalizeResponsesUrl("  https://api.openai.com/v1///?foo=1#hash  "), "https://api.openai.com/v1");
  assert.equal(normalizeResponsesUrl("http://127.0.0.1:8787/v1//"), "http://127.0.0.1:8787/v1");
});

test("responsesEndpoint composes the normalized base with /responses", () => {
  assert.equal(responsesEndpoint("https://api.openai.com/v1/"), "https://api.openai.com/v1/responses");
  assert.equal(responsesEndpoint("https://api.openai.com"), "https://api.openai.com/responses");
});

test("normalizeResponsesUrl rejects invalid bases", () => {
  assert.throws(() => normalizeResponsesUrl(""), TypeError);
  assert.throws(() => normalizeResponsesUrl("   "), TypeError);
  assert.throws(() => normalizeResponsesUrl(42), TypeError);
  assert.throws(() => normalizeResponsesUrl("not a url"), TypeError);
  assert.throws(() => normalizeResponsesUrl("ftp://files.example/v1"), /must use http/);
  assert.throws(() => normalizeResponsesUrl("https://user:pass@api.example/v1"), /must not embed/);
});

test("buildImageGenerationRequest emits the exact official wire shape", () => {
  const request = buildImageGenerationRequest({
    prompt: "A serene mountain lake at dawn",
    responseModel: "gpt-5.6-sol",
    imageModel: "gpt-image-2",
    size: "1024x1024",
    quality: "high",
    background: "transparent",
    format: "png",
  });
  assert.deepEqual(request, {
    model: "gpt-5.6-sol",
    input: "A serene mountain lake at dawn",
    stream: false,
    tools: [
      {
        type: "image_generation",
        model: "gpt-image-2",
        action: "generate",
        size: "1024x1024",
        quality: "high",
        background: "transparent",
        output_format: "png",
      },
    ],
    tool_choice: { type: "image_generation" },
    store: false,
  });
  // No `name` and no nested `options` on the tool entry.
  assert.equal("name" in request.tools[0], false);
  assert.equal("options" in request.tools[0], false);
});

test("buildImageGenerationRequest trims the input prompt and keeps the body non-streaming", () => {
  const request = buildImageGenerationRequest({ prompt: "  hello world  ", responseModel: "gpt-5.6-sol" });
  assert.equal(request.input, "hello world");
  assert.equal(request.stream, false);
  assert.deepEqual(request.tool_choice, { type: "image_generation" });
  assert.equal(request.store, false);
  // Optional generation parameters omitted so provider defaults apply.
  assert.deepEqual(request.tools[0], { type: "image_generation", action: "generate" });
});

test("buildImageGenerationRequest validates the size, quality, background, and format enums", () => {
  const base = { prompt: "p", responseModel: "m", imageModel: "gpt-image-2" };
  assert.throws(() => buildImageGenerationRequest({ ...base, size: "512x512" }), /invalid image_generation size .*1024x1024, 1024x1536, 1536x1024, auto/);
  assert.throws(() => buildImageGenerationRequest({ ...base, quality: "ultra" }), /invalid image_generation quality/);
  assert.throws(() => buildImageGenerationRequest({ ...base, background: "checkerboard" }), /invalid image_generation background/);
  assert.throws(() => buildImageGenerationRequest({ ...base, format: "gif" }), /invalid image_generation output_format/);
  // Values are validated after trimming, so padded valid values pass.
  assert.equal(buildImageGenerationRequest({ ...base, size: " 1536x1024 " }).tools[0].size, "1536x1024");
});

test("buildImageGenerationRequest rejects transparent + jpeg but allows transparent + png/webp", () => {
  const base = { prompt: "p", responseModel: "m", imageModel: "gpt-image-2" };
  assert.throws(
    () => buildImageGenerationRequest({ ...base, background: "transparent", format: "jpeg" }),
    /cannot combine background "transparent" with output_format "jpeg"/,
  );
  assert.equal(buildImageGenerationRequest({ ...base, background: "transparent", format: "png" }).tools[0].background, "transparent");
  assert.equal(buildImageGenerationRequest({ ...base, background: "transparent", format: "webp" }).tools[0].background, "transparent");
  // Opaque backgrounds are fine with jpeg.
  assert.equal(buildImageGenerationRequest({ ...base, background: "opaque", format: "jpeg" }).tools[0].output_format, "jpeg");
});

test("buildImageGenerationRequest rejects a blank prompt and a missing responseModel", () => {
  assert.throws(() => buildImageGenerationRequest({ prompt: "   ", responseModel: "m" }), /prompt/);
  assert.throws(() => buildImageGenerationRequest({ prompt: "ok" }), /responseModel/);
  assert.throws(() => buildImageGenerationRequest({}), /prompt/);
});

test("extractGeneratedImage reads the official direct result and preserves the top-level response.id", () => {
  const b64 = PNG_1PX.toString("base64");
  const image = extractGeneratedImage(
    {
      id: "resp_abc",
      output: [
        { id: "call_1", type: "image_generation_call", status: "completed", result: b64 },
      ],
    },
    { maxBytes: 1024 * 1024 },
  );
  assert.equal(image.responseId, "resp_abc");
  assert.equal(image.callId, "call_1");
  assert.deepEqual(Buffer.from(image.data), PNG_1PX);
  // The PNG magic bytes are sniffed from the decoded payload.
  assert.equal(image.mediaType, "image/png");
});

test("extractGeneratedImage falls back to the requested output_format for the media type", () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
  const image = extractGeneratedImage(
    { output: [{ type: "image_generation_call", result: jpeg.toString("base64") }] },
    { format: "jpeg" },
  );
  assert.equal(image.mediaType, "image/jpeg");
  const webpHeader = Buffer.from([
    0x52, 0x49, 0x46, 0x46,
    0x04, 0x00, 0x00, 0x00,
    0x57, 0x45, 0x42, 0x50,
  ]);
  const webp = extractGeneratedImage({
    output: [{ type: "image_generation_call", result: webpHeader.toString("base64") }],
  });
  assert.equal(webp.mediaType, "image/webp");
  const malformedWebp = Buffer.from("RIFFWEBP");
  const malformed = extractGeneratedImage({
    output: [{ type: "image_generation_call", result: malformedWebp.toString("base64") }],
  });
  assert.equal(malformed.mediaType, "image/png");
  // Unknown bytes with no hint default to image/png.
  const unknown = extractGeneratedImage({ output: [{ type: "image_generation_call", result: Buffer.from([1, 2, 3, 4]).toString("base64") }] });
  assert.equal(unknown.mediaType, "image/png");
  assert.equal(unknown.responseId, undefined);
});

test("extractGeneratedImage strictly decodes the official result base64", () => {
  const payload = (b64) => ({ output: [{ type: "image_generation_call", status: "completed", result: b64 }] });
  assertImageGenerationError(() => extractGeneratedImage(payload("not base64!")), "BAD_BASE64");
  assertImageGenerationError(() => extractGeneratedImage(payload("QQ")), "BAD_BASE64"); // length not a multiple of 4
  assertImageGenerationError(() => extractGeneratedImage(payload("Z m9v")), "BAD_BASE64"); // whitespace inside
  assertImageGenerationError(() => extractGeneratedImage(payload("Zm9v====")), "BAD_BASE64"); // excess padding
  assertImageGenerationError(() => extractGeneratedImage(payload("AB==")), "BAD_BASE64"); // non-canonical padding bits
  const image = extractGeneratedImage(payload("QQ=="));
  assert.equal(Buffer.from(image.data).toString(), "A");
});

test("extractGeneratedImage returns the first official image in output order", () => {
  const a = PNG_1PX.toString("base64");
  const b = Buffer.from([1, 2, 3, 4]).toString("base64");
  const image = extractGeneratedImage({
    output: [
      { type: "image_generation_call", id: "call_1", status: "completed", result: a },
      { type: "image_generation_call", id: "call_2", status: "completed", result: b },
    ],
  });
  assert.equal(image.callId, "call_1");
  assert.deepEqual(Buffer.from(image.data), PNG_1PX);
});

test("extractGeneratedImage surfaces a refusal from output message content", () => {
  assertImageGenerationError(
    () => extractGeneratedImage({
      output: [
        { id: "msg_1", type: "message", content: [{ type: "refusal", refusal: "I cannot generate that content." }] },
      ],
    }),
    "REFUSED",
    "I cannot generate that content.",
  );
});

test("extractGeneratedImage surfaces a bare refusal output item", () => {
  assertImageGenerationError(
    () => extractGeneratedImage({ output: [{ type: "refusal", refusal: "policy" }] }),
    "REFUSED",
    "policy",
  );
});

test("extractGeneratedImage surfaces a top-level API error", () => {
  assertImageGenerationError(
    () => extractGeneratedImage({ error: { code: "invalid_request_error", message: "model not found" } }),
    "API_ERROR",
    "model not found",
  );
});

test("extractGeneratedImage rejects failed, incomplete, and result-less official calls", () => {
  assertImageGenerationError(
    () => extractGeneratedImage({ output: [{ id: "c", type: "image_generation_call", status: "failed", error: "content policy" }] }),
    "GENERATION_FAILED",
    "content policy",
  );
  assertImageGenerationError(
    () => extractGeneratedImage({ output: [{ id: "c", type: "image_generation_call", status: "in_progress", result: PNG_1PX.toString("base64") }] }),
    "INCOMPLETE",
    "did not complete",
  );
  assertImageGenerationError(
    () => extractGeneratedImage({ output: [{ id: "c", type: "image_generation_call", status: "completed", result: null }] }),
    "MISSING_OUTPUT",
    "no base64 image data",
  );
});

test("extractGeneratedImage reports missing image output", () => {
  assertImageGenerationError(() => extractGeneratedImage({ output: [] }), "MISSING_OUTPUT");
  assertImageGenerationError(() => extractGeneratedImage({}), "MISSING_OUTPUT");
  assertImageGenerationError(
    () => extractGeneratedImage({ output: [{ type: "image_generation_call", output: [{ type: "text", text: "x" }] }] }),
    "MISSING_OUTPUT",
  );
});

test("extractGeneratedImage enforces the byte bound on the official result", () => {
  const b64 = PNG_1PX.toString("base64");
  assertImageGenerationError(
    () => extractGeneratedImage({ output: [{ type: "image_generation_call", result: b64 }] }, { maxBytes: 8 }),
    "OVERSIZED",
  );
  assert.throws(() => extractGeneratedImage({}, { maxBytes: 0 }), TypeError);
});

test("extractGeneratedImage still honors the legacy nested shape as a backward-compatible fallback", () => {
  const b64 = PNG_1PX.toString("base64");
  const image = extractGeneratedImage(
    {
      id: "resp_1",
      output: [
        {
          type: "image_generation_call",
          call_id: "call_abc",
          revised_prompt: "A serene mountain lake at dawn, photorealistic",
          output: [{ type: "image", image_url: `data:image/png;base64,${b64}` }],
        },
      ],
    },
    { maxBytes: 1024 * 1024 },
  );
  assert.equal(image.mediaType, "image/png");
  assert.equal(image.responseId, "resp_1");
  assert.deepEqual(Buffer.from(image.data), PNG_1PX);
  assert.equal(image.callId, "call_abc");
  assert.equal(image.revisedPrompt, "A serene mountain lake at dawn, photorealistic");

  const webp = extractGeneratedImage({
    output: [
      { type: "image_generation_call", output: [{ type: "image", b64_json: b64, media_type: "image/webp", width: 1, height: 1 }] },
    ],
  });
  assert.equal(webp.mediaType, "image/webp");
  assert.equal(webp.width, 1);
  assert.equal(webp.height, 1);
  assert.deepEqual(Buffer.from(webp.data), PNG_1PX);
});

test("extractGeneratedImage legacy fallback maps image/jpg, rejects remote URLs and bad media types", () => {
  const b64 = PNG_1PX.toString("base64");
  const legacy = (entry) => ({ output: [{ type: "image_generation_call", output: [entry] }] });
  const jpg = extractGeneratedImage(legacy({ type: "image", image_url: `data:image/jpg;base64,${b64}` }));
  assert.equal(jpg.mediaType, "image/jpeg");
  assertImageGenerationError(
    () => extractGeneratedImage(legacy({ type: "image", image_url: `data:image/avif;base64,${b64}` })),
    "UNSUPPORTED_MEDIA_TYPE",
  );
  assertImageGenerationError(
    () => extractGeneratedImage(legacy({ type: "image", image_url: "https://cdn.example/img.png" })),
    "UNSUPPORTED_IMAGE_URL",
  );
});

test("ImageGenerationError carries code and optional status and cause", () => {
  const error = new ImageGenerationError("boom", "HTTP_ERROR", { status: 429 });
  assert.ok(error instanceof Error);
  assert.ok(error instanceof ImageGenerationError);
  assert.equal(error.code, "HTTP_ERROR");
  assert.equal(error.status, 429);
  const cause = new Error("inner");
  const wrapped = new ImageGenerationError("outer", "TRANSPORT", { cause });
  assert.equal(wrapped.cause, cause);
});

test("IMAGE_MEDIA_TYPES and the generation enums cover the official surface", () => {
  assert.deepEqual([...IMAGE_MEDIA_TYPES], ["image/png", "image/jpeg", "image/webp", "image/gif"]);
  assert.deepEqual([...IMAGE_GENERATION_SIZES], ["1024x1024", "1024x1536", "1536x1024", "auto"]);
  assert.deepEqual([...IMAGE_GENERATION_QUALITIES], ["low", "medium", "high", "auto"]);
  assert.deepEqual([...IMAGE_GENERATION_BACKGROUNDS], ["transparent", "opaque", "auto"]);
  assert.deepEqual([...IMAGE_GENERATION_FORMATS], ["png", "webp", "jpeg"]);
  assert.deepEqual(FORMAT_MEDIA_TYPES, { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" });
  for (const list of [IMAGE_MEDIA_TYPES, IMAGE_GENERATION_SIZES, IMAGE_GENERATION_QUALITIES, IMAGE_GENERATION_BACKGROUNDS, IMAGE_GENERATION_FORMATS]) {
    assert.ok(Object.isFrozen(list));
  }
});

//#region image-to-image (edit) request building

test("supplying images switches the request to action edit with an input message array", () => {
  const body = buildImageGenerationRequest({
    prompt: "  make it snow  ",
    responseModel: "gpt-5.6-sol",
    imageModel: "gpt-image-2",
    images: [
      { mediaType: "image/png", base64: "AAAA" },
      { mediaType: "image/webp", base64: "BBBB", detail: "high" },
    ],
  });
  assert.deepEqual(body.tools, [{ type: "image_generation", action: "edit", model: "gpt-image-2" }]);
  assert.equal(body.stream, false);
  assert.deepEqual(body.tool_choice, { type: "image_generation" });
  assert.deepEqual(body.input, [{
    role: "user",
    content: [
      { type: "input_text", text: "make it snow" },
      { type: "input_image", image_url: "data:image/png;base64,AAAA", detail: "auto" },
      { type: "input_image", image_url: "data:image/webp;base64,BBBB", detail: "high" },
    ],
  }]);
});

test("a reference image may be a file id or an already-qualified url", () => {
  const body = buildImageGenerationRequest({
    prompt: "combine",
    responseModel: "m",
    images: [{ fileId: " file_123 " }, { imageUrl: " https://cdn.example/a.png " }],
  });
  assert.deepEqual(body.input[0].content.slice(1), [
    { type: "input_image", file_id: "file_123", detail: "auto" },
    { type: "input_image", image_url: "https://cdn.example/a.png", detail: "auto" },
  ]);
});

test("edit-only options ride the tool entry and are rejected without images", () => {
  const withMask = buildImageGenerationRequest({
    prompt: "inpaint",
    responseModel: "m",
    images: [{ mediaType: "image/png", base64: "AAAA" }],
    inputFidelity: "high",
    mask: { mediaType: "image/png", base64: "MMMM" },
  });
  assert.equal(withMask.tools[0].input_fidelity, "high");
  assert.deepEqual(withMask.tools[0].input_image_mask, { image_url: "data:image/png;base64,MMMM" });

  const maskById = buildImageGenerationRequest({
    prompt: "inpaint",
    responseModel: "m",
    images: [{ fileId: "f1" }],
    mask: { fileId: "mask_1" },
  });
  assert.deepEqual(maskById.tools[0].input_image_mask, { file_id: "mask_1" });

  assert.throws(
    () => buildImageGenerationRequest({ prompt: "x", responseModel: "m", inputFidelity: "high" }),
    /input_fidelity applies only to an edit/,
  );
  assert.throws(
    () => buildImageGenerationRequest({ prompt: "x", responseModel: "m", mask: { fileId: "m1" } }),
    /input_image_mask applies only to an edit/,
  );
  assert.throws(
    () => buildImageGenerationRequest({ prompt: "x", responseModel: "m", action: "edit" }),
    /action "edit" requires at least one reference image/,
  );
});

test("an explicit action overrides the images-derived default", () => {
  const auto = buildImageGenerationRequest({
    prompt: "x",
    responseModel: "m",
    images: [{ fileId: "f1" }],
    action: "auto",
  });
  assert.equal(auto.tools[0].action, "auto");
  assert.equal(Array.isArray(auto.input), true, "the reference still travels in the message array");

  assert.throws(
    () => buildImageGenerationRequest({ prompt: "x", responseModel: "m", action: "sideways" }),
    /invalid image_generation action "sideways"/,
  );
});

test("malformed reference images and masks are rejected", () => {
  assert.throws(
    () => buildImageGenerationRequest({ prompt: "x", responseModel: "m", images: "att_1" }),
    /images must be an array when provided/,
  );
  assert.throws(
    () => buildImageGenerationRequest({ prompt: "x", responseModel: "m", images: [null] }),
    /images\[0\] must be an object/,
  );
  assert.throws(
    () => buildImageGenerationRequest({ prompt: "x", responseModel: "m", images: [{}] }),
    /images\[0\] must carry one of fileId, imageUrl, or mediaType \+ base64/,
  );
  assert.throws(
    () => buildImageGenerationRequest({
      prompt: "x",
      responseModel: "m",
      images: [{ mediaType: "image/png", base64: "AA", detail: "ultra" }],
    }),
    /invalid image_generation detail "ultra"/,
  );
  assert.throws(
    () => buildImageGenerationRequest({
      prompt: "x",
      responseModel: "m",
      images: [{ fileId: "f1" }],
      inputFidelity: "medium",
    }),
    /invalid image_generation input_fidelity "medium"/,
  );
  assert.throws(
    () => buildImageGenerationRequest({ prompt: "x", responseModel: "m", images: [{ fileId: "f" }], mask: {} }),
    /mask must carry one of fileId, imageUrl, or mediaType \+ base64/,
  );
});

test("an empty images array stays text-to-image", () => {
  const body = buildImageGenerationRequest({ prompt: "a cat", responseModel: "m", images: [] });
  assert.equal(body.input, "a cat");
  assert.equal(body.tools[0].action, "generate");
});

test("toImageDataUrl builds an RFC 2397 payload and rejects blanks", () => {
  assert.equal(toImageDataUrl("image/png", "AAAA"), "data:image/png;base64,AAAA");
  assert.equal(toImageDataUrl(" image/webp ", " BBBB "), "data:image/webp;base64,BBBB");
  assert.throws(() => toImageDataUrl("", "AAAA"), /mediaType must be a non-empty string/);
  assert.throws(() => toImageDataUrl("image/png", "  "), /base64 must be a non-empty string/);
});

test("the edit enums match the official surface and stay frozen", () => {
  assert.deepEqual([...IMAGE_GENERATION_ACTIONS], ["generate", "edit", "auto"]);
  assert.deepEqual([...IMAGE_INPUT_FIDELITIES], ["high", "low"]);
  assert.deepEqual([...IMAGE_INPUT_DETAILS], ["low", "high", "auto", "original"]);
  for (const list of [IMAGE_GENERATION_ACTIONS, IMAGE_INPUT_FIDELITIES, IMAGE_INPUT_DETAILS]) {
    assert.ok(Object.isFrozen(list));
  }
});
//#endregion

//#region image understanding (vision) request building and answer extraction

test("buildVisionRequest emits the plain completion wire shape with input_image blocks", () => {
  const body = buildVisionRequest({
    question: "  what species is this?  ",
    responseModel: "gpt-5.6-sol",
    images: [
      { mediaType: "image/png", base64: "AAAA" },
      { fileId: "file_9" },
    ],
  });
  assert.deepEqual(body, {
    model: "gpt-5.6-sol",
    input: [{
      role: "user",
      content: [
        { type: "input_text", text: "what species is this?" },
        { type: "input_image", image_url: "data:image/png;base64,AAAA", detail: "auto" },
        { type: "input_image", file_id: "file_9", detail: "auto" },
      ],
    }],
    stream: false,
    store: false,
  });
  assert.equal(body.tools, undefined, "no tool entries on a plain completion");
  assert.equal(body.tool_choice, undefined);
});

test("buildVisionRequest rejects blank input and empty or malformed images", () => {
  assert.throws(() => buildVisionRequest({ question: "  ", responseModel: "m", images: [{ fileId: "f" }] }), /question must be a non-empty string/);
  assert.throws(() => buildVisionRequest({ question: "q", responseModel: " ", images: [{ fileId: "f" }] }), /responseModel must be a non-empty string/);
  assert.throws(() => buildVisionRequest({ question: "q", responseModel: "m", images: [] }), /images must be a non-empty array/);
  assert.throws(() => buildVisionRequest({ question: "q", responseModel: "m" }), /images must be a non-empty array/);
  assert.throws(() => buildVisionRequest({ question: "q", responseModel: "m", images: [{}] }), /images\[0\] must carry one of/);
});

test("extractResponseText joins output_text blocks and keeps the response id", () => {
  const payload = {
    id: "resp_v1",
    status: "completed",
    output: [
      { type: "message", role: "assistant", content: [
        { type: "output_text", text: "It is a ranchu goldfish." },
        { type: "output_text", text: "Red and white." },
      ] },
    ],
  };
  assert.deepEqual(extractResponseText(payload), {
    text: "It is a ranchu goldfish.\nRed and white.",
    responseId: "resp_v1",
  });
});

test("extractResponseText honors the top-level output_text convenience field", () => {
  assert.deepEqual(
    extractResponseText({ id: "r2", output: [], output_text: "  a goldfish  " }),
    { text: "a goldfish", responseId: "r2" },
  );
});

test("extractResponseText surfaces refusals, API errors, and dead responses", () => {
  assertImageGenerationError(
    () => extractResponseText({ output: [{ type: "message", content: [{ type: "refusal", refusal: "cannot identify people" }] }] }),
    "REFUSED",
  );
  assertImageGenerationError(
    () => extractResponseText({ output: [{ type: "refusal", refusal: "no" }] }),
    "REFUSED",
  );
  assertImageGenerationError(
    () => extractResponseText({ error: { code: "rate_limited", message: "slow down" }, output: [] }),
    "API_ERROR",
  );
  assertImageGenerationError(() => extractResponseText({}), "MISSING_OUTPUT");
  assertImageGenerationError(() => extractResponseText({ output: [], status: "failed" }), "GENERATION_FAILED");
  assertImageGenerationError(
    () => extractResponseText({ output: [], status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }),
    "INCOMPLETE",
  );
  assertImageGenerationError(() => extractResponseText({ output: [{ type: "message", content: [] }] }), "MISSING_OUTPUT");
  assertImageGenerationError(() => extractResponseText(null), "INVALID_RESPONSE");
  assertImageGenerationError(() => extractResponseText([]), "INVALID_RESPONSE");
});
//#endregion
