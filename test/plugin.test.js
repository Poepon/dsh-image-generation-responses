/**
 * Plugin-level tests for dsh-image-generation-responses: module import and
 * defaults, `defineTool` schema registration (parameter enums, output schema,
 * render), and the full `generate_image` execution flow against a mock fetch
 * and stub harness services — asserting the exact official wire shape is
 * POSTed, the credential is resolved per call, the response read is bounded,
 * and the decoded image is saved through the attachment seam.
 *
 * @module dsh-image-generation-responses/test/plugin
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_CONFIG,
  apply,
  buildImageGenerationRequest,
  name,
  inject,
} from "../lib/index.js";

/** A tiny valid 1x1 PNG byte payload. */
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/** A stub harness context: tools registry, per-call credential, attachment seam. */
function stubCtx({ credential } = {}) {
  const calls = { credentials: [], saveImage: [], registered: null };
  const ctx = {
    tools: {
      register: (definition) => {
        calls.registered = definition;
      },
    },
    credentials: {
      resolve: async (ref) => {
        calls.credentials.push(ref);
        return credential;
      },
    },
    attachments: {
      saveImage: async (input) => {
        calls.saveImage.push(input);
        return {
          attachmentId: "att_1",
          mediaType: input.mediaType,
          bytes: input.data.length,
          width: 1024,
          height: 1024,
          name: input.name,
        };
      },
    },
  };
  return { ctx, calls };
}

test("module metadata and defaults match the official configuration", () => {
  assert.equal(name, "dsh-image-generation-responses");
  assert.deepEqual(inject, ["tools", "credentials", "attachments"]);
  assert.equal(DEFAULT_CONFIG.responseModel, "gpt-5.6-sol");
  assert.equal(DEFAULT_CONFIG.imageModel, "gpt-image-2");
  assert.equal(DEFAULT_CONFIG.size, "1024x1024");
  assert.equal(DEFAULT_CONFIG.quality, "medium");
  assert.equal(DEFAULT_CONFIG.background, "opaque");
  assert.equal(DEFAULT_CONFIG.format, "png");
});

test("apply registers a generate_image tool whose schema defineTool validates", async () => {
  const { ctx, calls } = stubCtx();
  apply(ctx, {});
  const tool = calls.registered;
  assert.ok(tool, "a tool definition was registered");
  assert.equal(tool.name, "generate_image");
  assert.ok(tool.description.length > 0);
  // Parameter schema (defineTool compiles the spec to JSON Schema).
  assert.deepEqual(tool.parameters.properties.size.enum, ["1024x1024", "1024x1536", "1536x1024", "auto"]);
  assert.deepEqual(tool.parameters.properties.quality.enum, ["low", "medium", "high", "auto"]);
  assert.deepEqual(tool.parameters.properties.background.enum, ["opaque", "transparent", "auto"]);
  assert.deepEqual(tool.parameters.properties.format.enum, ["png", "jpeg", "webp"]);
  assert.ok(tool.parameters.required.includes("prompt"));
  // Output schema.
  assert.equal(tool.output.schema.type, "object");
  for (const required of ["attachment", "model", "responseModel", "size", "quality", "background", "format"]) {
    assert.ok(tool.output.schema.required.includes(required), `output schema requires ${required}`);
  }
  assert.ok(tool.output.schema.properties.responseId);
  assert.equal(tool.timeoutMs, DEFAULT_CONFIG.timeoutMs);
  // defineTool's own execute wrapper rejects invalid args (schema validation).
  const exec = { signal: new AbortController().signal };
  await assert.rejects(tool.execute({ prompt: "   " }, exec), /prompt must be a non-empty string/);
});

test("generate_image posts the exact official wire shape and saves the decoded attachment", async () => {
  const { ctx, calls } = stubCtx({ credential: { value: "sk-test", source: "env" } });
  const posted = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    posted.push({ url, init });
    const body = JSON.stringify({
      id: "resp_abc",
      status: "completed",
      output: [{ id: "call_1", type: "image_generation_call", status: "completed", result: PNG_1PX.toString("base64") }],
    });
    return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    apply(ctx, {});
    const tool = calls.registered;
    const value = await tool.execute(
      { prompt: "  a red panda  " },
      { signal: new AbortController().signal },
    );
    assert.equal(posted.length, 1);
    assert.equal(posted[0].url, "https://api.openai.com/v1/responses");
    assert.equal(posted[0].init.method, "POST");
    assert.equal(posted[0].init.redirect, "error");
    assert.equal(posted[0].init.headers.authorization, "Bearer sk-test");
    assert.equal(posted[0].init.headers["content-type"], "application/json");
    const sent = JSON.parse(posted[0].init.body);
    assert.deepEqual(sent, buildImageGenerationRequest({
      prompt: "a red panda",
      responseModel: "gpt-5.6-sol",
      imageModel: "gpt-image-2",
      size: "1024x1024",
      quality: "medium",
      background: "opaque",
      format: "png",
    }));
    // Per-call credential resolution.
    assert.equal(calls.credentials.length, 1);
    // Attachment saved with the decoded bytes.
    assert.equal(calls.saveImage.length, 1);
    assert.deepEqual(calls.saveImage[0].data, PNG_1PX);
    assert.equal(calls.saveImage[0].mediaType, "image/png");
    // Canonical result.
    assert.equal(value.attachment.attachmentId, "att_1");
    assert.equal(value.attachment.mediaType, "image/png");
    assert.equal(value.attachment.bytes, PNG_1PX.length);
    assert.equal(value.model, "gpt-image-2");
    assert.equal(value.responseModel, "gpt-5.6-sol");
    assert.equal(value.size, "1024x1024");
    assert.equal(value.quality, "medium");
    assert.equal(value.background, "opaque");
    assert.equal(value.format, "png");
    assert.equal(value.callId, "call_1");
    assert.equal(value.responseId, "resp_abc");
    // Image content render.
    const blocks = tool.output.render({ prompt: "a red panda" }, value);
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0].type, "text");
    assert.match(blocks[0].text, /Generated image \(png, 1024x1024, medium\)/);
    assert.equal(blocks[1].type, "image");
    assert.equal(blocks[1].attachment, value.attachment);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("generate_image surfaces HTTP failures with status and provider detail", async () => {
  const { ctx } = stubCtx({ credential: { value: "sk-test", source: "env" } });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    JSON.stringify({ error: { message: "bad\u0000\nkey" } }),
    { status: 401, headers: { "content-type": "application/json" } },
  );
  try {
    const definition = registeredDefinition(ctx);
    await assert.rejects(
      definition.execute({ prompt: "x" }, { signal: new AbortController().signal }),
      (error) => error.code === "HTTP_ERROR"
        && /401/.test(error.message)
        && error.message.includes("bad key")
        && !error.message.includes("api.openai.com"),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

/** Re-run apply and capture the registered definition (helper for one-off tests). */
function registeredDefinition(ctx) {
  let captured;
  const original = ctx.tools.register;
  ctx.tools.register = (definition) => {
    captured = definition;
    original(definition);
  };
  apply(ctx, {});
  ctx.tools.register = original;
  return captured;
}

test("generate_image fails cleanly when the credential is unconfigured", async () => {
  const { ctx } = stubCtx({ credential: undefined });
  const originalFetch = globalThis.fetch;
  let fetched = false;
  globalThis.fetch = async () => {
    fetched = true;
    return new Response("{}", { status: 200 });
  };
  try {
    const definition = registeredDefinition(ctx);
    await assert.rejects(
      definition.execute({ prompt: "x" }, { signal: new AbortController().signal }),
      (error) => error.code === "MISSING_CREDENTIAL" && /OPENAI_API_KEY/.test(error.message),
    );
    assert.equal(fetched, false, "no request is made without a credential");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
