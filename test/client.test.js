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

/** Stand-ins for the attachment atoms; identity is enough to assert dispatch. */
const ImageGallery = function ImageGallery() {};
const MessageImage = function MessageImage() {};

/**
 * Minimal React seed. `createElement` backs every view assertion; `useState`
 * and `useEffect` are a tiny single-component renderer used only by the
 * sidebar/overlay tests, which need real subscribe/unsubscribe behavior.
 */
const React = {
  createElement: (type, props, ...children) => ({
    type,
    props: props ?? {},
    children: children.length === 1 ? children[0] : children,
  }),
  useState: (init) => {
    const cell = React.__hooks[React.__cursor++] ?? { value: typeof init === "function" ? init() : init };
    React.__hooks[React.__cursor - 1] = cell;
    const set = (next) => {
      const value = typeof next === "function" ? next(cell.value) : next;
      if (Object.is(value, cell.value)) return;
      cell.value = value;
      React.__render();
    };
    return [cell.value, set];
  },
  useEffect: (fn, deps) => {
    const index = React.__cursor++;
    const cell = React.__hooks[index] ?? { deps: undefined, cleanup: undefined, first: true };
    React.__hooks[index] = cell;
    const changed = cell.first
      || deps === undefined
      || cell.deps === undefined
      || deps.length !== cell.deps.length
      || deps.some((dep, i) => !Object.is(dep, cell.deps[i]));
    if (changed) {
      React.__pending.push(() => {
        if (typeof cell.cleanup === "function") cell.cleanup();
        cell.cleanup = fn();
      });
      cell.deps = deps;
      cell.first = false;
    }
  },
  __hooks: [],
  __cursor: 0,
  __pending: [],
  __render: () => {},
};

/**
 * Render one hook-using component repeatedly until its state settles, the way
 * React would across commits.
 * @param Component - the component under test.
 * @param props - props passed on every pass.
 * @returns a handle exposing the latest tree and an unmount that runs cleanups.
 */
function render(Component, props) {
  const hooks = [];
  let tree = null;
  let dirty = true;
  let guard = 0;
  const pass = () => {
    React.__hooks = hooks;
    React.__cursor = 0;
    React.__pending = [];
    React.__render = () => { dirty = true; };
    tree = Component(props);
    const effects = React.__pending;
    React.__pending = [];
    effects.forEach((run) => run());
  };
  while (dirty) {
    if ((guard += 1) > 20) throw new Error("render did not settle");
    dirty = false;
    pass();
  }
  return {
    get tree() { return tree; },
    rerender: () => {
      dirty = true;
      while (dirty) {
        if ((guard += 1) > 40) throw new Error("rerender did not settle");
        dirty = false;
        pass();
      }
      return tree;
    },
    unmount: () => {
      hooks.forEach((cell) => {
        if (cell !== undefined && typeof cell.cleanup === "function") cell.cleanup();
      });
    },
  };
}

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
    if (spec === "@deepseek-ai/dsh-client-ui-attachment") return { ImageGallery, MessageImage };
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
  assert.deepEqual(client.inject, ["slots", "conversation", "sessions"]);
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

  assert.deepEqual(injections, ["tool.call.toolview", "sidebar.footer.action", "shell.overlay"]);
  assert.equal(registrations.length, 3);
  assert.equal(registrations[0].options.name, "tool.call.toolview");
  assert.equal(registrations[0].options.key, "generate_image");
  assert.equal(typeof registrations[0].component, "function");

  // The gallery seats are additive list entries addressed by a namespaced id,
  // so no shipped sidebar or overlay occupant is replaced.
  assert.equal(registrations[1].options.name, "sidebar.footer.action");
  assert.equal(registrations[1].options.id, "dsh-image-generation-responses/gallery-toggle");
  assert.equal(registrations[1].options.key, undefined);
  assert.equal(registrations[2].options.name, "shell.overlay");
  assert.equal(registrations[2].options.id, "dsh-image-generation-responses/gallery-panel");
  assert.equal(registrations[2].options.key, undefined);

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
      register: (options, component) => {
        if (options.key === "generate_image") captured = component;
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

//#region session gallery

/** Build a durable image reference with a distinct id. */
function ref(id) {
  return { attachmentId: id, mediaType: "image/png", bytes: 16, width: 8, height: 8, name: `${id}.png` };
}

test("the session gallery collects images newest first across every node shape", () => {
  const snapshot = {
    nodes: [
      { kind: "user", seq: 1, content: [{ type: "image", attachment: ref("up_1") }, { type: "text", text: "hi" }] },
      { kind: "assistant", seq: 2, blocks: [{ kind: "text", text: "ok" }, { kind: "image", attachment: ref("as_1") }] },
      settled({ seq: 3, content: [{ type: "image", attachment: ref("gen_1") }], meta: { attachment: ref("gen_1") } }),
      { kind: "tool-result", seq: 4, content: [{ type: "text", text: "pruned" }], meta: { attachment: ref("gen_2") } },
    ],
  };

  assert.deepEqual(
    client.collectSessionImages(snapshot).map((item) => item.attachment.attachmentId),
    ["gen_2", "gen_1", "as_1", "up_1"],
    "newest node first, and the meta fallback still contributes",
  );
});

test("the session gallery deduplicates by attachment id and tolerates unknown nodes", () => {
  const snapshot = {
    nodes: [
      { kind: "user", seq: 1, content: [{ type: "image", attachment: ref("dup") }] },
      { kind: "future-kind", seq: 2, surface: "unknown" },
      null,
      { kind: "assistant", seq: 3, blocks: [{ kind: "image", attachment: ref("dup") }] },
      { kind: "assistant", seq: 4, blocks: [{ kind: "image", attachment: { attachmentId: "bad", width: 0, height: 1, mediaType: "image/png" } }] },
    ],
  };

  assert.deepEqual(client.collectSessionImages(snapshot).map((i) => i.attachment.attachmentId), ["dup"]);
  assert.deepEqual(client.collectSessionImages({}), [], "a snapshot without nodes yields nothing");
  assert.deepEqual(client.collectSessionImages(null), []);
});

test("sameImages keeps the projection identity stable across snapshot flushes", () => {
  const a = [{ attachment: ref("x") }, { attachment: ref("y") }];
  assert.equal(client.sameImages(a, [{ attachment: ref("x") }, { attachment: ref("y") }]), true);
  assert.equal(client.sameImages(a, [{ attachment: ref("y") }, { attachment: ref("x") }]), false);
  assert.equal(client.sameImages(a, [{ attachment: ref("x") }]), false);
});

test("the panel store notifies subscribers only on real transitions and unsubscribes", () => {
  const store = client.createPanelStore();
  let notified = 0;
  const stop = store.subscribe(() => { notified += 1; });

  assert.equal(store.get(), false, "the panel starts closed");
  store.set(false);
  assert.equal(notified, 0, "an idempotent write notifies nobody");
  store.set(true);
  assert.equal(store.get(), true);
  assert.equal(notified, 1);

  stop();
  store.set(false);
  assert.equal(notified, 1, "a removed listener stops hearing changes");
});

test("the sidebar toggle reflects and drives the shared panel state", () => {
  const store = client.createPanelStore();
  const Toggle = client.makeGalleryButton(store);

  const wide = render(Toggle, { wide: true });
  assert.equal(wide.tree.type, "button");
  assert.equal(wide.tree.props["aria-pressed"], false);
  assert.equal(wide.tree.props["data-rail"], undefined);
  assert.equal(wide.tree.children.length, 2, "the wide column shows icon + label");

  wide.tree.props.onClick();
  assert.equal(store.get(), true, "clicking opens the panel");
  assert.equal(wide.rerender().props["aria-pressed"], true);
  wide.unmount();

  const rail = render(Toggle, { wide: false });
  assert.equal(rail.tree.props["data-rail"], true);
  assert.equal(rail.tree.children.length, 1, "the rail column shows the icon only");
  assert.equal(rail.tree.props["aria-pressed"], true, "both seats read one shared store");
  rail.unmount();
});

test("the overlay panel stays empty while closed and stacks the current session's images when open", () => {
  const store = client.createPanelStore();
  const snapshot = {
    nodes: [
      { kind: "user", seq: 1, content: [{ type: "image", attachment: ref("a1") }] },
      { kind: "assistant", seq: 2, blocks: [{ kind: "image", attachment: ref("a2") }] },
    ],
  };
  let listener;
  const session = {
    getSnapshot: () => snapshot,
    subscribe: (fn) => {
      listener = fn;
      return () => { listener = undefined; };
    },
  };
  const sessions = { binding: (id) => (id === "s1" ? { sessionId: id, session } : undefined) };
  const load = () => Promise.resolve("blob:x");
  const Panel = client.makeGalleryPanel(store, () => load, () => sessions);
  const props = { useSessions: (select) => select({ current: "s1" }) };

  const closed = render(Panel, props);
  assert.equal(closed.tree, null, "a closed panel occupies no space in the click-through layer");
  closed.unmount();

  store.set(true);
  const open = render(Panel, props);
  assert.equal(open.tree.props.role, "dialog");
  const head = open.tree.children.find((child) => child.props.className === "dsh-igr-panel-head");
  assert.equal(head.children.find((c) => c.props.className === "dsh-igr-panel-count").children, "2");

  const body = open.tree.children.find((child) => child.props.className === "dsh-igr-panel-body");
  const stack = body.children;
  assert.equal(stack.props.className, "dsh-igr-stack", "images stack vertically, one per row");

  // ImageGallery would collapse a multi-image group into 64px tiles, so the
  // vertical dock drives MessageImage directly at `single` size instead.
  assert.deepEqual(stack.children.map((child) => child.type), [MessageImage, MessageImage]);
  assert.deepEqual(stack.children.map((child) => child.props.variant), ["single", "single"]);
  assert.deepEqual(stack.children.map((child) => child.props.attachment.attachmentId), ["a2", "a1"]);
  assert.deepEqual(stack.children.map((child) => child.props.key), ["a2", "a1"]);
  assert.equal(stack.children[0].props.load, load, "the panel reuses the session-authorized loader");
  assert.equal(stack.children[1].props.load, load, "every row shares one loader identity");

  assert.equal(typeof listener, "function", "the panel subscribes to the live session face");
  head.children.find((c) => c.props.className === "dsh-igr-panel-close").props.onClick();
  assert.equal(store.get(), false, "the close control shuts the shared store");

  open.unmount();
  assert.equal(listener, undefined, "unmounting releases the session subscription");
});

test("the open dock pins itself to the measured sidebar width", () => {
  const store = client.createPanelStore();
  store.set(true);
  const Panel = client.makeGalleryPanel(store, () => () => Promise.resolve(""), () => ({ binding: () => undefined }));
  const props = { useSessions: (select) => select({ current: undefined }) };

  // No document in this realm: the dock must still render, flush against the
  // frame's left edge rather than throwing on the missing measurement target.
  const bare = render(Panel, props);
  assert.equal(bare.tree.props.style.left, "0px");
  bare.unmount();

  const column = { getBoundingClientRect: () => ({ width: 248 }) };
  const layer = { parentElement: { firstElementChild: column } };
  global.document = { querySelector: (sel) => (sel === "[data-shell-overlay]" ? layer : null) };
  try {
    const docked = render(Panel, props);
    assert.equal(docked.tree.props.style.left, "248px", "the dock sits at the conversation column's left edge");
    docked.unmount();
  } finally {
    delete global.document;
  }
});

test("the overlay panel degrades when no session is current or the binding is gone", () => {
  const store = client.createPanelStore();
  store.set(true);
  const Panel = client.makeGalleryPanel(store, () => () => Promise.resolve(""), () => ({ binding: () => undefined }));

  const none = render(Panel, { useSessions: (select) => select({ current: undefined }) });
  const noneBody = none.tree.children.find((child) => child.props.className === "dsh-igr-panel-body");
  assert.equal(noneBody.children.props.className, "dsh-igr-note");
  assert.equal(noneBody.children.children, "Open a session to see its images.");
  none.unmount();

  const missing = render(Panel, { useSessions: (select) => select({ current: "gone" }) });
  const missingBody = missing.tree.children.find((child) => child.props.className === "dsh-igr-panel-body");
  assert.equal(missingBody.children.children, "No images in this session yet.");
  missing.unmount();
});
//#endregion
