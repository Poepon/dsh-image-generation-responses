/**
 * Client-bundle tests for dsh-image-generation-responses.
 *
 * The bundle is a `window.__ModuleLoader__.load({ id, factory })` artifact, not
 * an ES module, so these tests install a minimal loader sink plus a `require`
 * that answers the two platform seed words the factory pulls (`react` and
 * `@deepseek-ai/dsh-client-ui-attachment`). That mirrors exactly how the shell
 * materializes a plugin bundle and lets the pure presentation model be asserted
 * without a browser or a React renderer.
 *
 * Covered: the loader handoff shape, the slot registration (name/key) and its
 * fiber-scoped disposal, and the running / error / ready / missing-image states.
 *
 * @module dsh-image-generation-responses/test/client
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CLIENT_PATH = fileURLToPath(new URL("../lib/client.js", import.meta.url));

/** A stand-in for the ImageGallery atom; identity is enough to assert dispatch. */
const ImageGallery = function ImageGallery() {};

/** Minimal React seed: only `createElement` is used by the bundle. */
const React = {
  createElement: (type, props, ...children) => ({
    type,
    props: props ?? {},
    children: children.length === 1 ? children[0] : children,
  }),
};

/**
 * Execute the built bundle the way the shell does and materialize its factory.
 * @returns the factory's `module.exports`.
 */
function materialize() {
  const source = readFileSync(CLIENT_PATH, "utf8");
  const handoffs = [];
  // Evaluated in THIS realm (not vm.runInNewContext) so values the bundle
  // builds share these tests' intrinsics and deepStrictEqual compares by
  // structure rather than failing on a foreign realm's prototypes. `window` is
  // a parameter shadowing the global; `document` stays undefined, which the
  // bundle's style injection must tolerate.
  const evaluate = new Function("window", source);
  evaluate({ __ModuleLoader__: { load: (handoff) => handoffs.push(handoff) } });

  assert.equal(handoffs.length, 1, "the bundle registers exactly one factory");
  assert.equal(handoffs[0].id, "dsh-image-generation-responses");
  assert.equal(typeof handoffs[0].factory, "function");

  const require = (spec) => {
    if (spec === "react") return React;
    if (spec === "@deepseek-ai/dsh-client-ui-attachment") return { ImageGallery };
    throw new Error(`unexpected require("${spec}") — not a platform seed word`);
  };
  return handoffs[0].factory(require);
}

const client = materialize();

/** A durable image reference shaped like the attachment service's output. */
const REF = {
  attachmentId: "att_1",
  mediaType: "image/png",
  bytes: 1024,
  width: 1024,
  height: 1024,
  name: "panda.png",
};

/** A settled successful tool-result node carrying one image ContentBlock. */
function settled(overrides = {}) {
  return {
    kind: "tool-result",
    seq: 1,
    time: 0,
    callId: "call_1",
    call: { name: "generate_image", argsRaw: JSON.stringify({ prompt: "a red panda" }) },
    callTime: 0,
    content: [
      { type: "text", text: "Generated image (png, 1024x1024, medium): a red panda." },
      { type: "image", attachment: REF },
    ],
    isError: false,
    meta: { format: "png", size: "1024x1024", quality: "medium", attachment: REF },
    callView: null,
    resultView: null,
    subCalls: [],
    ...overrides,
  };
}

test("the bundle exports the client plugin contract", () => {
  assert.equal(typeof client.apply, "function");
  assert.deepEqual(client.inject, ["slots", "conversation"]);
});

test("apply claims the generate_image key of tool.call.toolview and unwinds with the fiber", () => {
  const registrations = [];
  const injections = [];
  let disposed = 0;
  const effects = [];
  const ctx = {
    get: () => undefined,
    effect: (fn) => {
      effects.push(fn());
    },
    slots: {
      inject: (name, body) => {
        injections.push(name);
        body();
      },
      register: (options, component) => {
        registrations.push({ options, component });
        return () => {
          disposed += 1;
        };
      },
    },
  };

  client.apply(ctx);

  assert.deepEqual(injections, ["tool.call.toolview"]);
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].options.name, "tool.call.toolview");
  assert.equal(registrations[0].options.key, "generate_image");
  assert.equal(typeof registrations[0].component, "function");

  // Every side effect is reversible through the fiber's disposers.
  assert.equal(effects.length, 1);
  assert.equal(typeof effects[0], "function");
  effects[0]();
  assert.equal(disposed, 0, "the effect disposer is independent of the slot disposer");
});

test("the session image loader is stable per session and routes through conversation.resolveImage", async () => {
  const calls = [];
  const conversation = {
    resolveImage: (sessionId, attachment) => {
      calls.push({ sessionId, attachment });
      return Promise.resolve(`blob:${sessionId}/${attachment.attachmentId}`);
    },
  };
  let captured;
  const ctx = {
    get: (name) => (name === "conversation" ? conversation : undefined),
    effect: (fn) => fn(),
    slots: {
      inject: (_name, body) => body(),
      register: (_options, component) => {
        captured = component;
        return () => {};
      },
    },
  };
  client.apply(ctx);

  const first = captured({ block: settled(), sessionId: "s1", callId: "call_1", toolName: "generate_image" });
  const second = captured({ block: settled(), sessionId: "s1", callId: "call_1", toolName: "generate_image" });

  const gallery = (node) => node.children.find((child) => child?.props?.className === "dsh-igr-body").children;
  const loadA = gallery(first).props.load;
  const loadB = gallery(second).props.load;
  assert.equal(loadA, loadB, "the loader identity is stable so MessageImage's effect does not refetch");

  assert.equal(await loadA(REF), "blob:s1/att_1");
  assert.deepEqual(calls, [{ sessionId: "s1", attachment: REF }]);
});

test("a still-running call renders the running state", () => {
  const running = {
    callId: "call_1",
    name: "generate_image",
    argsRaw: JSON.stringify({ prompt: "a red panda" }),
    turn: 1,
    step: 1,
    time: 0,
    callView: null,
    subCalls: [],
  };
  const described = client.describeState(running);
  assert.equal(described.state, "running");
  assert.equal(described.summary, "Generating image…");
  assert.deepEqual(client.selectImages(running), [], "a running call has no durable image yet");
});

test("a settled success selects the durable image reference from the image ContentBlock", () => {
  const block = settled();
  const described = client.describeState(block);
  assert.equal(described.state, "ready");
  assert.deepEqual(described.images, [{ attachment: REF }]);
  assert.equal(client.readPrompt(block), "a red panda");
  assert.equal(client.readDetail(block), "png, 1024x1024, medium");
});

test("the image falls back to presentation meta when the content blocks were pruned", () => {
  const block = settled({ content: [{ type: "text", text: "Generated image." }] });
  const described = client.describeState(block);
  assert.equal(described.state, "ready");
  assert.deepEqual(described.images, [{ attachment: REF }]);
});

test("a failed call renders the first error line", () => {
  const block = settled({
    isError: true,
    content: [{ type: "text", text: "generate_image: HTTP 401 from https://api.openai.com/v1/responses: bad key\ntrace" }],
    meta: undefined,
  });
  const described = client.describeState(block);
  assert.equal(described.state, "error");
  assert.equal(described.summary, "generate_image: HTTP 401 from https://api.openai.com/v1/responses: bad key");
});

test("a failed call with no text falls back to the structured error", () => {
  const block = settled({
    isError: true,
    content: [],
    error: { name: "ImageGenerationError", code: "TIMEOUT" },
    meta: undefined,
  });
  assert.equal(client.describeState(block).summary, "ImageGenerationError: TIMEOUT");
});

test("a success carrying no usable image reports the missing-image state", () => {
  const described = client.describeState(settled({ content: [{ type: "text", text: "ok" }], meta: undefined }));
  assert.equal(described.state, "empty");
  assert.deepEqual(described.images, []);
});

test("malformed image references and arguments never reach the gallery", () => {
  const bad = settled({
    content: [
      { type: "image", attachment: { attachmentId: "", mediaType: "image/png", width: 1, height: 1 } },
      { type: "image", attachment: { attachmentId: "att_2", mediaType: "image/png", width: 0, height: 10 } },
      { type: "image", attachment: null },
    ],
    meta: undefined,
  });
  assert.deepEqual(client.selectImages(bad), []);
  assert.equal(client.readPrompt(settled({ call: { name: "generate_image", argsRaw: "{not json" } })), undefined);
});
