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
const ImageLightbox = function ImageLightbox() {};

/** Minimal react-dom seed: the dock only needs `createPortal`. */
const ReactDOM = {
  createPortal: (children, container) => ({ portal: true, container, children }),
};

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
    if (spec === "react-dom") return ReactDOM;
    if (spec === "@deepseek-ai/dsh-client-ui-attachment") return { ImageGallery, ImageLightbox };
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
  assert.deepEqual(client.inject, ["slots", "conversation", "sessions", "locale"]);
});

/** A stub ctx covering every service apply touches, recording the calls. */
function stubApplyCtx() {
  const registrations = [];
  const injections = [];
  const effects = [];
  const dictionaries = [];
  const ctx = {
    get: () => undefined,
    effect: (fn) => {
      effects.push(fn());
    },
    locale: {
      register: (ns, dicts) => {
        dictionaries.push({ ns, dicts });
        return () => {};
      },
    },
    slots: {
      inject: (name, body) => {
        injections.push(name);
        body();
      },
      register: (options, component) => {
        registrations.push({ options, component });
        return () => {};
      },
    },
  };
  return { ctx, registrations, injections, effects, dictionaries };
}

test("apply claims the generate_image key of tool.call.toolview and unwinds with the fiber", () => {
  const { ctx, registrations, injections, effects, dictionaries } = stubApplyCtx();

  client.apply(ctx);

  assert.deepEqual(injections, ["tool.call.toolview", "shell.overlay"]);
  assert.equal(registrations.length, 2, "the dock needs no menu-bar action button");
  assert.equal(registrations[0].options.name, "tool.call.toolview");
  assert.equal(registrations[0].options.key, "generate_image");
  assert.equal(registrations[0].options.locale, "dsh-image-generation-responses");
  assert.equal(typeof registrations[0].component, "function");

  // The dock is an additive list entry addressed by a namespaced id, so no
  // shipped overlay occupant is replaced.
  assert.equal(registrations[1].options.name, "shell.overlay");
  assert.equal(registrations[1].options.id, "dsh-image-generation-responses/gallery-panel");
  assert.equal(registrations[1].options.locale, "dsh-image-generation-responses");
  assert.equal(registrations[1].options.key, undefined);
  assert.ok(
    !injections.includes("sidebar.footer.action"),
    "the sidebar footer seat is no longer occupied",
  );

  // Both UI dictionaries register under the plugin namespace.
  assert.equal(dictionaries.length, 1);
  assert.equal(dictionaries[0].ns, "dsh-image-generation-responses");
  assert.deepEqual(
    Object.keys(dictionaries[0].dicts.zh).sort(),
    Object.keys(dictionaries[0].dicts.en).sort(),
    "zh and en carry exactly the same keys",
  );

  // Every side effect is reversible through the fiber's disposers.
  assert.equal(effects.length, 2, "image loaders + dictionaries");
  assert.equal(typeof effects[0], "function");
  effects[0]();
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
    locale: { register: () => () => {} },
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
  assert.equal(described.summary, undefined, "static strings are translated by the row, not the pure model");
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

test("the session gallery keeps only model-returned images, newest first", () => {
  const snapshot = {
    nodes: [
      { kind: "user", seq: 1, content: [{ type: "image", attachment: ref("up_1") }, { type: "text", text: "hi" }] },
      { kind: "steering", seq: 2, content: [{ type: "image", attachment: ref("steer_1") }] },
      { kind: "context", seq: 3, content: [{ type: "image", attachment: ref("ctx_1") }] },
      { kind: "assistant", seq: 4, blocks: [{ kind: "text", text: "ok" }, { kind: "image", attachment: ref("as_1") }] },
      settled({ seq: 5, content: [{ type: "image", attachment: ref("gen_1") }], meta: { attachment: ref("gen_1") } }),
      { kind: "tool-result", seq: 6, content: [{ type: "text", text: "pruned" }], meta: { attachment: ref("gen_2") } },
    ],
  };

  assert.deepEqual(
    client.collectSessionImages(snapshot).map((item) => item.attachment.attachmentId),
    ["gen_2", "gen_1", "as_1"],
    "assistant output and tool results survive; human-sent and injected images do not",
  );
});

test("a user node cannot smuggle an image through the meta fallback", () => {
  const snapshot = {
    nodes: [
      { kind: "user", seq: 1, content: [], meta: { attachment: ref("sneaky") } },
      { kind: "user", seq: 2, content: [{ type: "image", attachment: ref("up_2") }] },
    ],
  };
  assert.deepEqual(client.collectSessionImages(snapshot), []);
});

test("the session gallery deduplicates by attachment id and tolerates unknown nodes", () => {
  const snapshot = {
    nodes: [
      { kind: "user", seq: 1, content: [{ type: "image", attachment: ref("up_only") }] },
      { kind: "future-kind", seq: 2, surface: "unknown" },
      null,
      { kind: "assistant", seq: 3, blocks: [{ kind: "image", attachment: ref("dup") }] },
      { kind: "tool-result", seq: 4, content: [{ type: "image", attachment: ref("dup") }] },
      { kind: "assistant", seq: 5, blocks: [{ kind: "image", attachment: { attachmentId: "bad", width: 0, height: 1, mediaType: "image/png" } }] },
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

/** Build a session double whose snapshot holds the given images, newest last. */
function sessionWith(ids) {
  const snapshot = {
    nodes: ids.map((id, seq) => settled({
      seq: seq + 1,
      content: [{ type: "image", attachment: ref(id) }],
      meta: undefined,
    })),
  };
  let listener;
  return {
    face: {
      getSnapshot: () => snapshot,
      subscribe: (fn) => {
        listener = fn;
        return () => { listener = undefined; };
      },
    },
    get subscribed() { return typeof listener === "function"; },
  };
}

/** Let the loader promises settle so resolved URLs reach the dock's state. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("the dock renders nothing until the session actually holds an image", async () => {
  const empty = sessionWith([]);
  const sessions = { binding: () => ({ sessionId: "s1", session: empty.face }) };
  const Dock = client.makeGalleryPanel(() => () => Promise.resolve("blob:x"), () => sessions);

  // No toggle exists, so absence is the whole "closed" state.
  const none = render(Dock, { useSessions: (select) => select({ current: "s1" }) });
  assert.equal(none.tree, null, "an image-free conversation contributes no dock");
  none.unmount();

  const noSession = render(Dock, { useSessions: (select) => select({ current: undefined }) });
  assert.equal(noSession.tree, null, "no current session means no dock");
  noSession.unmount();
});

test("the dock portals to body, centres vertically, and sits above the lightbox", async () => {
  const live = sessionWith(["a1", "a2"]);
  const sessions = { binding: (id) => (id === "s1" ? { sessionId: id, session: live.face } : undefined) };
  const load = (attachment) => Promise.resolve(`blob:${attachment.attachmentId}`);
  const Dock = client.makeGalleryPanel(() => load, () => sessions);
  const props = { useSessions: (select) => select({ current: "s1" }) };

  const column = { getBoundingClientRect: () => ({ width: 248 }) };
  const layer = { parentElement: { firstElementChild: column } };
  const body = { tag: "body" };
  global.document = { body, querySelector: (sel) => (sel === "[data-shell-overlay]" ? layer : null) };
  try {
    const view = render(Dock, props);
    await flush();
    const tree = view.rerender();

    // Portalling to body is what escapes the overlay layer's own stacking
    // context, which would otherwise trap the strip beneath the lightbox.
    assert.equal(tree.portal, true);
    assert.equal(tree.container, body);

    const dock = tree.children.find((child) => child.props.className === "dsh-igr-dock");
    assert.equal(dock.props.style.left, "260px", "offset by the measured sidebar width plus a gutter");
    assert.equal(dock.props.role, "list");

    const tiles = dock.children;
    assert.deepEqual(tiles.map((t) => t.props.key), ["a2", "a1"], "newest image first");
    assert.deepEqual(tiles.map((t) => t.children.type), ["img", "img"]);
    assert.deepEqual(tiles.map((t) => t.children.props.src), ["blob:a2", "blob:a1"]);
    assert.deepEqual(tiles.map((t) => t.props.disabled), [false, false]);

    assert.ok(live.subscribed, "the dock subscribes to the live session face");
    view.unmount();
    assert.equal(live.subscribed, false, "unmounting releases the session subscription");
  } finally {
    delete global.document;
  }
});

test("clicking a thumbnail opens the preview and another switches it in place", async () => {
  const live = sessionWith(["a1", "a2"]);
  const sessions = { binding: () => ({ sessionId: "s1", session: live.face }) };
  const load = (attachment) => Promise.resolve(`blob:${attachment.attachmentId}`);
  const Dock = client.makeGalleryPanel(() => load, () => sessions);
  const props = { useSessions: (select) => select({ current: "s1" }) };

  global.document = { body: {}, querySelector: () => null };
  try {
    const view = render(Dock, props);
    await flush();
    let tree = view.rerender();

    const dockOf = (t) => t.children.find((child) => child.props.className === "dsh-igr-dock");
    const previewOf = (t) => t.children.find((child) => child.type === ImageLightbox);

    assert.equal(previewOf(tree), undefined, "no preview until a thumbnail is clicked");

    dockOf(tree).children[0].props.onClick();
    tree = view.rerender();
    assert.equal(previewOf(tree).props.src, "blob:a2");
    assert.equal(dockOf(tree).children[0].props["data-active"], true);

    // The strip stays mounted above the open preview, so a second click swaps
    // the previewed image rather than needing a close first.
    dockOf(tree).children[1].props.onClick();
    tree = view.rerender();
    assert.equal(previewOf(tree).props.src, "blob:a1", "the preview switches in place");
    assert.equal(dockOf(tree).children[0].props["data-active"], undefined);
    assert.equal(dockOf(tree).children[1].props["data-active"], true);

    previewOf(tree).props.onClose();
    tree = view.rerender();
    assert.equal(previewOf(tree), undefined, "closing dismisses the preview but keeps the strip");
    assert.ok(dockOf(tree) !== undefined);
    view.unmount();
  } finally {
    delete global.document;
  }
});

test("an unresolved thumbnail is inert and a vanished preview target is dropped", async () => {
  const live = sessionWith(["a1"]);
  const sessions = { binding: () => ({ sessionId: "s1", session: live.face }) };
  const Dock = client.makeGalleryPanel(() => () => new Promise(() => {}), () => sessions);
  const props = { useSessions: (select) => select({ current: "s1" }) };

  global.document = { body: {}, querySelector: () => null };
  try {
    const view = render(Dock, props);
    await flush();
    const tree = view.rerender();
    const tile = tree.children.find((c) => c.props.className === "dsh-igr-dock").children[0];

    assert.equal(tile.props.disabled, true, "a pending image cannot open a preview");
    assert.equal(tile.children.props.className, "dsh-igr-thumb-pending");
    tile.props.onClick();
    assert.equal(
      view.rerender().children.find((c) => c.type === ImageLightbox),
      undefined,
      "clicking a pending tile opens nothing",
    );
    view.unmount();
  } finally {
    delete global.document;
  }
});

test("the dock degrades when the portal or document is unavailable", () => {
  const live = sessionWith(["a1"]);
  const sessions = { binding: () => ({ sessionId: "s1", session: live.face }) };
  const Dock = client.makeGalleryPanel(() => () => Promise.resolve("blob:a1"), () => sessions);
  const props = { useSessions: (select) => select({ current: "s1" }) };

  // No document in this realm at all: the dock must return null, not throw.
  const bare = render(Dock, props);
  assert.equal(bare.tree, null);
  bare.unmount();
});
//#endregion

//#region i18n

/** A translator backed by the plugin's own zh dictionary, with interpolation. */
function zhT(key, params) {
  const template = client.DICT_ZH[key];
  if (typeof template !== "string") return key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
}

test("the zh and en dictionaries carry identical, non-empty keys", () => {
  const zhKeys = Object.keys(client.DICT_ZH).sort();
  const enKeys = Object.keys(client.DICT_EN).sort();
  assert.deepEqual(zhKeys, enKeys);
  assert.ok(zhKeys.length > 0);
  for (const key of zhKeys) {
    assert.ok(client.DICT_ZH[key].trim().length > 0, `zh "${key}" is blank`);
    assert.ok(client.DICT_EN[key].trim().length > 0, `en "${key}" is blank`);
  }
});

test("defaultT renders the English fallback and interpolates placeholders", () => {
  assert.equal(client.defaultT("row.running"), "Generating image…");
  assert.equal(client.defaultT("label.openNamed", { label: "panda.png" }), "Open the original image: panda.png");
  assert.equal(client.defaultT("missing.key"), "missing.key", "unknown keys degrade to the key itself");
});

test("the tool row translates its static strings through the t seat", () => {
  const Row = client.makeImageRow(() => () => Promise.resolve("blob:x"));

  const ready = Row({ block: settled(), sessionId: "s1", t: zhT });
  const title = ready.children
    .find((child) => child.props.className === "dsh-igr-row")
    .children.find((child) => child.props.className === "dsh-igr-title");
  assert.equal(title.children, "图像");

  const running = Row({
    block: { callId: "c", name: "generate_image", argsRaw: "{}", turn: 1, step: 1, time: 0, callView: null, subCalls: [] },
    sessionId: "s1",
    t: zhT,
  });
  const runningSummary = running.children
    .find((child) => child.props.className === "dsh-igr-row")
    .children.find((child) => child.props.className === "dsh-igr-summary");
  assert.equal(runningSummary.children, "正在生成图像…");

  const empty = Row({
    block: settled({ content: [{ type: "text", text: "ok" }], meta: undefined }),
    sessionId: "s1",
    t: zhT,
  });
  const note = empty.children
    .find((child) => child.props.className === "dsh-igr-body")
    .children;
  assert.equal(note.children, "调用成功，但没有返回已保存的图像附件。");

  // Without a t seat the row falls back to English.
  const bare = Row({ block: settled(), sessionId: "s1" });
  const bareTitle = bare.children
    .find((child) => child.props.className === "dsh-igr-row")
    .children.find((child) => child.props.className === "dsh-igr-title");
  assert.equal(bareTitle.children, "Image");
});

test("the dock translates its aria label, tile affordances, and pending text", async () => {
  const live = sessionWith(["a1"]);
  const sessions = { binding: () => ({ sessionId: "s1", session: live.face }) };
  const pendingLoad = () => new Promise(() => {});
  const Dock = client.makeGalleryPanel(() => pendingLoad, () => sessions);

  global.document = { body: {}, querySelector: () => null };
  try {
    const view = render(Dock, { useSessions: (select) => select({ current: "s1" }), t: zhT });
    await flush();
    const tree = view.rerender();
    const dock = tree.children.find((child) => child.props.className === "dsh-igr-dock");
    assert.equal(dock.props["aria-label"], "会话图片");
    const tile = dock.children[0];
    assert.equal(tile.props.title, "查看原图");
    assert.equal(tile.children.props.className, "dsh-igr-thumb-pending");
    assert.equal(tile.children.children, "图片加载中…");
    view.unmount();
  } finally {
    delete global.document;
  }
});
//#endregion
