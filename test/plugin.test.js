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
  MAX_REFERENCE_IMAGES,
  apply,
  buildImageGenerationRequest,
  indexSessionImages,
  modelAcceptsImages,
  name,
  inject,
} from "../lib/index.js";

/** A tiny valid 1x1 PNG byte payload. */
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/** A stub harness context: tools registry, per-call credential, attachment seam. */
function stubCtx({ credential, storedImages = {}, llm } = {}) {
  const calls = { credentials: [], saveImage: [], readImage: [], registered: null };
  const ctx = {
    get: (name) => (name === "llm" ? llm : undefined),
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
      readImage: async (ref, signal) => {
        calls.readImage.push({ ref, signal });
        const hit = storedImages[ref.attachmentId];
        if (hit === undefined) throw new Error("ATTACHMENT_NOT_FOUND");
        return { ref, data: hit };
      },
    },
  };
  return { ctx, calls };
}

/**
 * A stub calling agent whose session log carries the given image references, in
 * the same leaf shapes the real durable log uses. `header` supplies the folded
 * request header the session reports (provider/model of the current route).
 */
function stubAgent(refs, header) {
  return {
    session: {
      events: [
        { type: "user/message", data: { content: refs.map((ref) => ({ type: "image", attachment: ref })) } },
      ],
      requestHeader: () => header,
    },
  };
}

/** A complete durable image reference as the attachment service mints them. */
function imageRef(id, overrides = {}) {
  return {
    attachmentId: id,
    mediaType: "image/png",
    bytes: PNG_1PX.length,
    width: 1,
    height: 1,
    ...overrides,
  };
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
    // Capability-gated render: this execution has no calling agent, so the
    // route is unknown and the model-facing result stays text-only (the image
    // block is added only for routes that declare image input).
    const blocks = tool.output.render({ prompt: "a red panda" }, value);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].type, "text");
    assert.match(blocks[0].text, /Generated image \(png, 1024x1024, medium\)/);
    assert.ok(blocks[0].text.includes("att_1"));
    assert.equal(value.modelSeesImage, false);
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

//#region image-to-image editing

/** Mock a single successful generation response carrying the 1x1 PNG. */
function okFetch(posted) {
  return async (url, init) => {
    posted.push({ url, init });
    const body = JSON.stringify({
      id: "resp_edit",
      status: "completed",
      output: [{ id: "call_e", type: "image_generation_call", status: "completed", result: PNG_1PX.toString("base64") }],
    });
    return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
  };
}

test("the tool advertises the image-to-image parameters and edit output fields", () => {
  const { ctx, calls } = stubCtx();
  apply(ctx, {});
  const tool = calls.registered;

  assert.equal(tool.parameters.properties.images.type, "array");
  assert.equal(tool.parameters.properties.images.items.type, "string");
  assert.deepEqual(tool.parameters.properties.input_fidelity.enum, ["high", "low"]);
  // Editing stays opt-in: only `prompt` is ever required.
  assert.deepEqual(tool.parameters.required, ["prompt"]);
  assert.ok(tool.output.schema.required.includes("action"));
  assert.equal(tool.output.schema.properties.sourceImages.type, "array");
  assert.equal(tool.output.schema.properties.inputFidelity.type, "string");
});

test("generate_image edits a session image, sending action edit with the reference bytes", async () => {
  const ref = imageRef("att_src");
  const { ctx, calls } = stubCtx({
    credential: { value: "sk-test", source: "env" },
    storedImages: { att_src: PNG_1PX },
  });
  const posted = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = okFetch(posted);
  try {
    apply(ctx, {});
    const tool = calls.registered;
    const value = await tool.execute(
      { prompt: "make it night", images: ["att_src"], input_fidelity: "high" },
      { signal: new AbortController().signal, agent: stubAgent([ref]) },
    );

    // The reference was read back through the attachment seam with the FULL
    // reference recovered from the session log, not a bare id.
    assert.equal(calls.readImage.length, 1);
    assert.deepEqual(calls.readImage[0].ref, ref);

    const sent = JSON.parse(posted[0].init.body);
    assert.equal(sent.tools[0].action, "edit");
    assert.equal(sent.tools[0].input_fidelity, "high");
    // Editing switches `input` from a bare string to a message array.
    assert.equal(Array.isArray(sent.input), true);
    assert.equal(sent.input[0].role, "user");
    assert.deepEqual(sent.input[0].content[0], { type: "input_text", text: "make it night" });
    assert.deepEqual(sent.input[0].content[1], {
      type: "input_image",
      image_url: `data:image/png;base64,${PNG_1PX.toString("base64")}`,
      detail: "auto",
    });

    assert.equal(value.action, "edit");
    assert.deepEqual(value.sourceImages, ["att_src"]);
    assert.equal(value.inputFidelity, "high");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("omitting images keeps the byte-identical text-to-image request", async () => {
  const { ctx, calls } = stubCtx({ credential: { value: "sk-test", source: "env" } });
  const posted = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = okFetch(posted);
  try {
    apply(ctx, {});
    const tool = calls.registered;
    const value = await tool.execute({ prompt: "a cat" }, { signal: new AbortController().signal });
    const sent = JSON.parse(posted[0].init.body);
    assert.equal(sent.input, "a cat", "no reference images means the bare-string input");
    assert.equal(sent.tools[0].action, "generate");
    assert.equal(sent.tools[0].input_fidelity, undefined);
    assert.equal(calls.readImage.length, 0, "nothing is read from the attachment seam");
    assert.equal(value.action, "generate");
    assert.equal(value.sourceImages, undefined);
    assert.equal(value.inputFidelity, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an attachment id outside the conversation is refused before any provider call", async () => {
  const { ctx, calls } = stubCtx({
    credential: { value: "sk-test", source: "env" },
    storedImages: { att_other: PNG_1PX },
  });
  let fetched = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetched = true;
    return new Response("{}", { status: 200 });
  };
  try {
    apply(ctx, {});
    const tool = calls.registered;
    await assert.rejects(
      tool.execute(
        { prompt: "edit", images: ["att_other"] },
        { signal: new AbortController().signal, agent: stubAgent([imageRef("att_visible")]) },
      ),
      (error) => error.code === "IMAGE_NOT_FOUND" && /att_other/.test(error.message),
    );
    assert.equal(fetched, false, "an unresolvable id never reaches the provider");
    assert.equal(calls.readImage.length, 0);
    assert.equal(calls.credentials.length, 0, "and never spends a credential");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("editing without a calling session, over the cap, or on a broken object fails cleanly", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("{}", { status: 200 });
  try {
    // No agent: there is no session to resolve ids against.
    {
      const { ctx, calls } = stubCtx({ credential: { value: "sk", source: "env" } });
      apply(ctx, {});
      await assert.rejects(
        calls.registered.execute(
          { prompt: "edit", images: ["att_src"] },
          { signal: new AbortController().signal },
        ),
        (error) => error.code === "NO_SESSION",
      );
    }
    // Over the reference cap.
    {
      const { ctx, calls } = stubCtx({ credential: { value: "sk", source: "env" } });
      apply(ctx, {});
      const many = Array.from({ length: MAX_REFERENCE_IMAGES + 1 }, (_v, i) => `att_${i}`);
      await assert.rejects(
        calls.registered.execute(
          { prompt: "edit", images: many },
          { signal: new AbortController().signal, agent: stubAgent([]) },
        ),
        (error) => error.code === "TOO_MANY_IMAGES",
      );
    }
    // Visible in the log, but the stored object cannot be read.
    {
      const ref = imageRef("att_gone");
      const { ctx, calls } = stubCtx({ credential: { value: "sk", source: "env" }, storedImages: {} });
      apply(ctx, {});
      await assert.rejects(
        calls.registered.execute(
          { prompt: "edit", images: ["att_gone"] },
          { signal: new AbortController().signal, agent: stubAgent([ref]) },
        ),
        (error) => error.code === "IMAGE_READ_FAILED" && /att_gone/.test(error.message),
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("indexSessionImages reads every durable image shape and ignores junk", () => {
  const a = imageRef("a");
  const b = imageRef("b");
  const c = imageRef("c");
  const session = {
    events: [
      { type: "user/message", data: { content: [{ type: "image", attachment: a }, { type: "text", text: "hi" }] } },
      { type: "assistant/message", data: { message: { content: [{ type: "image", attachment: b }] } } },
      { type: "tool/result", data: { meta: { attachment: c } } },
      { type: "unknown/shape", data: { nothing: true } },
      { type: "broken", data: null },
      { type: "partial", data: { content: [{ type: "image", attachment: { attachmentId: "bad" } }] } },
      null,
    ],
  };
  const index = indexSessionImages(session);
  assert.deepEqual([...index.keys()].sort(), ["a", "b", "c"]);
  assert.deepEqual(index.get("a"), a);
  assert.deepEqual(index.get("c"), c);
  assert.equal(index.has("bad"), false, "an incomplete reference is unusable and dropped");
  assert.equal(indexSessionImages(undefined).size, 0);
  assert.equal(indexSessionImages({}).size, 0);
});
//#endregion

//#region model capability gating

/** A stub llm service whose one model declares the given input modalities. */
function stubLlm(modalities, { throwError } = {}) {
  return {
    resolveModelInfo: async (provider, model, signal) => {
      if (throwError) throw new Error("capability lookup failed");
      return {
        provider,
        id: model,
        name: model,
        ...(modalities === undefined ? {} : { inputModalities: modalities }),
      };
    },
  };
}

const HEADER = { config: { provider: "pi-ai", model: "claude-opus-5" } };

/** Run one successful generation and return the canonical value. */
async function runGeneration(ctx, calls, exec) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = okFetch([]);
  try {
    apply(ctx, {});
    return await calls.registered.execute({ prompt: "a red panda" }, exec);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("the model-facing result carries the image only when the route accepts image input", async () => {
  const { ctx, calls } = stubCtx({
    credential: { value: "sk-test", source: "env" },
    llm: stubLlm(["text", "image"]),
  });
  const value = await runGeneration(ctx, calls, {
    signal: new AbortController().signal,
    agent: stubAgent([], HEADER),
  });
  assert.equal(value.modelSeesImage, true, "a vision-capable route keeps the image block");

  const blocks = calls.registered.output.render({ prompt: "x" }, value);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[1].type, "image");
  assert.deepEqual(blocks[1].attachment, value.attachment);
  assert.ok(blocks[0].text.includes(value.attachment.attachmentId),
    "the summary names the attachment id so later edit calls can reference it");
});

test("a text-only route gets a text-only result — no UNSUPPORTED_CONTENT resurrection", async () => {
  const { ctx, calls } = stubCtx({
    credential: { value: "sk-test", source: "env" },
    llm: stubLlm(["text"]),
  });
  const value = await runGeneration(ctx, calls, {
    signal: new AbortController().signal,
    agent: stubAgent([], HEADER),
  });
  assert.equal(value.modelSeesImage, false, "the text-only route is detected");

  const blocks = calls.registered.output.render({ prompt: "x" }, value);
  assert.equal(blocks.length, 1, "the image block is withheld from the model");
  assert.equal(blocks[0].type, "text");
  assert.ok(blocks[0].text.includes(value.attachment.attachmentId));
  assert.ok(blocks[0].text.includes("Generated image"));
});

test("capability gating is conservative for unknown routes and lookup failures", async () => {
  const signal = new AbortController().signal;

  // No llm service at all.
  {
    const { ctx } = stubCtx({ credential: { value: "sk", source: "env" } });
    assert.equal(await modelAcceptsImages(ctx, { signal, agent: stubAgent([], HEADER) }), false);
  }
  // No calling agent, or no folded request header yet.
  {
    const { ctx } = stubCtx({ credential: { value: "sk", source: "env" }, llm: stubLlm(["text", "image"]) });
    assert.equal(await modelAcceptsImages(ctx, { signal }), false);
    assert.equal(await modelAcceptsImages(ctx, { signal, agent: stubAgent([], undefined) }), false);
  }
  // An adapter that reports no modality list (unknown capability).
  {
    const { ctx } = stubCtx({ credential: { value: "sk", source: "env" }, llm: stubLlm(undefined) });
    assert.equal(await modelAcceptsImages(ctx, { signal, agent: stubAgent([], HEADER) }), false);
  }
  // A lookup that throws must never bubble into the tool result.
  {
    const { ctx } = stubCtx({ credential: { value: "sk", source: "env" }, llm: stubLlm(["text", "image"], { throwError: true }) });
    assert.equal(await modelAcceptsImages(ctx, { signal, agent: stubAgent([], HEADER) }), false);
  }
  // A header with an empty route (waterfall unresolved) is not a capability.
  {
    const { ctx } = stubCtx({ credential: { value: "sk", source: "env" }, llm: stubLlm(["text", "image"]) });
    assert.equal(
      await modelAcceptsImages(ctx, { signal, agent: stubAgent([], { config: { provider: "", model: "" } }) }),
      false,
    );
  }
});

test("execute records the gated decision in the canonical value", async () => {
  const { ctx, calls } = stubCtx({
    credential: { value: "sk-test", source: "env" },
    llm: stubLlm(["text"]),
  });
  const value = await runGeneration(ctx, calls, {
    signal: new AbortController().signal,
    agent: stubAgent([], HEADER),
  });
  assert.equal(value.modelSeesImage, false);
  assert.equal(value.action, "generate");
});
//#endregion
