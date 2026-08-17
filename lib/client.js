/**
 * Browser half of `dsh-image-generation-responses`.
 *
 * Two contributions:
 *
 * 1. A keyed `tool.call.toolview` entry for the `generate_image` wire name, so a
 *    generated image renders as an actual thumbnail instead of the generic
 *    card's serialized image ContentBlock.
 * 2. A session image gallery: an additive `sidebar.footer.action` toggle beside
 *    Settings, plus a `shell.overlay` panel listing every durable image in the
 *    current session (generated, uploaded, or tool-produced), newest first.
 *
 * The sidebar seat is root-scoped and receives only `{ wide }` plus the global
 * kit, so the panel reads the current session id from `useSessions` and
 * subscribes to that session's conversation snapshot through `ctx.sessions`
 * (`binding(id).session` is an ObservableSnapshot). Both registrations are
 * additive: no shipped occupant is replaced.
 *
 * Shipped as authored distributable source in the
 * `window.__ModuleLoader__.load({ id, factory })` shape used by installed DSH
 * client packages. The final runtime format is maintained directly, so no
 * generated artifact or hidden build step is required.
 *
 * Externals are resolved through the loader's synchronous `require` against the
 * frozen platform module table, so only platform seed words may be required
 * here (`react` and `@deepseek-ai/dsh-client-ui-attachment` both are).
 *
 * @module dsh-image-generation-responses/client
 */
window.__ModuleLoader__.load({
  id: "dsh-image-generation-responses",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var React = require("react");
    var uiAttachment = require("@deepseek-ai/dsh-client-ui-attachment");
    var ImageGallery = uiAttachment.ImageGallery;
    var h = React.createElement;

    //#region styles
    /** Scoped, theme-token-driven styling for the row and the gallery panel. */
    var CSS = [
      ".dsh-igr-card{display:flex;flex-direction:column;gap:4px}",
      ".dsh-igr-row{display:flex;align-items:center;min-width:0;height:24px;gap:6px}",
      ".dsh-igr-title{flex:none;font-size:14px;line-height:24px;color:var(--dsw-alias-label-secondary)}",
      ".dsh-igr-sep{flex:none;width:2px;height:2px;margin:0 2px;border-radius:1px;background:var(--dsw-alias-label-caption)}",
      ".dsh-igr-summary{flex:auto;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;",
      "font-size:14px;line-height:24px;color:var(--dsw-alias-label-tertiary)}",
      ".dsh-igr-summary[data-error]{color:var(--dsw-alias-state-error-primary)}",
      ".dsh-igr-meta{flex:none;font-size:11px;line-height:24px;color:var(--dsw-alias-label-caption)}",
      ".dsh-igr-body{display:flex;flex-direction:column;padding-left:4px}",
      ".dsh-igr-note{font-size:12px;line-height:20px;color:var(--dsw-alias-label-caption)}",
      ".dsh-igr-note[data-error]{color:var(--dsw-alias-state-error-primary)}",
      ".dsh-igr-card[data-state=running] .dsh-igr-summary{opacity:.72}",
      ".dsh-igr-inspect{align-self:flex-start;margin:2px 0 0 4px;padding:2px 8px;border-radius:999px;",
      "border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);",
      "color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;cursor:pointer;",
      "opacity:0;transition:opacity .1s}",
      ".dsh-igr-card:hover .dsh-igr-inspect,.dsh-igr-inspect:focus-visible{opacity:1}",
      ".dsh-igr-inspect:hover{background:var(--dsw-alias-interactive-bg-hover-solid);color:var(--dsw-alias-label-primary)}",
      "@media (prefers-reduced-motion:reduce){.dsh-igr-inspect{transition:none}}",
      // Sidebar toggle: matches the foot row's compact affordance in both column states.
      ".dsh-igr-toggle{display:flex;align-items:center;gap:8px;width:100%;min-width:0;height:32px;",
      "padding:0 8px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);",
      "font-size:13px;line-height:32px;text-align:left;cursor:pointer}",
      ".dsh-igr-toggle[data-rail]{width:32px;justify-content:center;padding:0}",
      ".dsh-igr-toggle:hover{background:var(--dsw-alias-interactive-bg-hover-solid);color:var(--dsw-alias-label-primary)}",
      ".dsh-igr-toggle[data-open]{background:var(--dsw-alias-interactive-bg-hover-solid);color:var(--dsw-alias-label-primary)}",
      ".dsh-igr-toggle-icon{flex:none;display:block}",
      ".dsh-igr-toggle-label{flex:auto;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}",
      ".dsh-igr-toggle-count{flex:none;font-size:11px;color:var(--dsw-alias-label-caption)}",
      // Overlay panel: the shell layer is click-through, so the card opts back in.
      ".dsh-igr-panel{position:fixed;left:12px;bottom:56px;z-index:30;display:flex;flex-direction:column;",
      "width:320px;max-width:calc(100vw - 24px);max-height:min(60vh,480px);pointer-events:auto;",
      "border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-base);",
      "box-shadow:0 8px 24px rgba(0,0,0,.18);overflow:hidden}",
      ".dsh-igr-panel-head{display:flex;align-items:center;gap:8px;flex:none;padding:10px 12px;",
      "border-bottom:1px solid var(--dsw-alias-border-l1)}",
      ".dsh-igr-panel-title{flex:auto;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;",
      "font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}",
      ".dsh-igr-panel-count{flex:none;font-size:11px;color:var(--dsw-alias-label-caption)}",
      ".dsh-igr-panel-close{flex:none;width:22px;height:22px;padding:0;border:0;border-radius:6px;",
      "background:transparent;color:var(--dsw-alias-label-tertiary);font-size:14px;line-height:22px;cursor:pointer}",
      ".dsh-igr-panel-close:hover{background:var(--dsw-alias-interactive-bg-hover-solid);color:var(--dsw-alias-label-primary)}",
      ".dsh-igr-panel-body{flex:auto;min-height:0;overflow:auto;padding:12px}",
    ].join("");

    var STYLE_TAG_ID = "dsh-image-generation-responses/ImageRow.css";
    if (typeof document !== "undefined"
      && document.querySelector("style[data-plugin-css=" + JSON.stringify(STYLE_TAG_ID) + "]") === null) {
      var tag = document.createElement("style");
      tag.dataset.plugin = "dsh-image-generation-responses";
      tag.dataset.pluginCss = STYLE_TAG_ID;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }
    //#endregion

    //#region pure model
    /** Strings the gallery atoms resolve through their owner. */
    var LABELS = {
      image: "Generated image",
      open: "Open the original image",
      openNamed: function (label) { return "Open the original image: " + label; },
      loading: "Loading image…",
      loadFailed: "Load failed — retry",
      lightbox: { dialog: "Generated image preview", close: "Close" },
    };

    /** First physical line, for one-line summaries. */
    function firstLine(text) {
      var nl = text.indexOf("\n");
      return nl === -1 ? text : text.slice(0, nl);
    }

    /** A settled node carries `kind`; a still-running call does not. */
    function isSettled(block) {
      return block !== null && typeof block === "object" && "kind" in block;
    }

    /** Structurally validate one durable image reference before handing it to the gallery. */
    function isImageRef(value) {
      return value !== null
        && typeof value === "object"
        && typeof value.attachmentId === "string"
        && value.attachmentId !== ""
        && typeof value.mediaType === "string"
        && typeof value.width === "number"
        && typeof value.height === "number"
        && Number.isFinite(value.width)
        && Number.isFinite(value.height)
        && value.width > 0
        && value.height > 0;
    }

    /**
     * Collect the durable image references a settled result carries. Prefers the
     * canonical image ContentBlocks and falls back to the tool's presentation
     * meta, so a result whose blocks were pruned still renders when the meta
     * survived.
     * @param block - the frozen running-or-settled node from the owner.
     * @returns gallery items, newest-call order; empty when there is no image.
     */
    function selectImages(block) {
      if (!isSettled(block)) return [];
      var images = [];
      var content = Array.isArray(block.content) ? block.content : [];
      for (var i = 0; i < content.length; i += 1) {
        var entry = content[i];
        if (entry !== null && typeof entry === "object" && entry.type === "image" && isImageRef(entry.attachment)) {
          images.push({ attachment: entry.attachment });
        }
      }
      if (images.length === 0) {
        var meta = readMeta(block);
        if (meta !== undefined && isImageRef(meta.attachment)) images.push({ attachment: meta.attachment });
      }
      return images;
    }

    /**
     * Collect every durable image in one conversation snapshot, newest first and
     * deduplicated by attachment id.
     *
     * Reads only the leaf fields three node shapes expose: `content` blocks
     * (user / steering / context / tool-result), classified assistant `blocks`,
     * and a tool result's presentation `meta.attachment` fallback. Unknown node
     * kinds contribute nothing rather than throwing, so a newer host surface
     * degrades quietly.
     * @param snapshot - the session's ConversationSnapshot.
     * @returns gallery items in newest-first order.
     */
    function collectSessionImages(snapshot) {
      if (snapshot === null || typeof snapshot !== "object") return [];
      var nodes = Array.isArray(snapshot.nodes) ? snapshot.nodes : [];
      var seen = new Set();
      var images = [];
      var push = function (attachment) {
        if (!isImageRef(attachment)) return;
        if (seen.has(attachment.attachmentId)) return;
        seen.add(attachment.attachmentId);
        images.push({ attachment: attachment });
      };
      // Newest first: walk the seq-ordered node list backwards.
      for (var i = nodes.length - 1; i >= 0; i -= 1) {
        var node = nodes[i];
        if (node === null || typeof node !== "object") continue;
        var before = images.length;
        var content = Array.isArray(node.content) ? node.content : [];
        for (var j = 0; j < content.length; j += 1) {
          var entry = content[j];
          if (entry !== null && typeof entry === "object" && entry.type === "image") push(entry.attachment);
        }
        var blocks = Array.isArray(node.blocks) ? node.blocks : [];
        for (var k = 0; k < blocks.length; k += 1) {
          var block = blocks[k];
          if (block !== null && typeof block === "object" && block.kind === "image") push(block.attachment);
        }
        // Presentation meta is a per-node fallback, exactly as in the tool row:
        // it only speaks for a node whose canonical blocks carried no image.
        if (images.length === before && node.meta !== null && typeof node.meta === "object") {
          push(node.meta.attachment);
        }
      }
      return images;
    }

    /**
     * Whether two collected galleries address the same images in the same order.
     * Keeps the panel's state identity stable across the many snapshot flushes a
     * streaming turn produces.
     * @param a - previous gallery items.
     * @param b - freshly collected gallery items.
     * @returns true when both address an identical id sequence.
     */
    function sameImages(a, b) {
      if (a === b) return true;
      if (a.length !== b.length) return false;
      for (var i = 0; i < a.length; i += 1) {
        if (a[i].attachment.attachmentId !== b[i].attachment.attachmentId) return false;
      }
      return true;
    }

    /** Read the tool's `presentationMeta` object defensively (it is typed `unknown`). */
    function readMeta(block) {
      if (!isSettled(block)) return undefined;
      var meta = block.meta;
      return meta !== null && typeof meta === "object" ? meta : undefined;
    }

    /** The prompt the model asked for, from the call's raw arguments. */
    function readPrompt(block) {
      var raw = isSettled(block)
        ? (block.call !== null && block.call !== undefined ? block.call.argsRaw : undefined)
        : block.argsRaw;
      if (typeof raw !== "string" || raw === "") return undefined;
      try {
        var parsed = JSON.parse(raw);
        if (parsed !== null && typeof parsed === "object" && typeof parsed.prompt === "string" && parsed.prompt !== "") {
          return firstLine(parsed.prompt.trim());
        }
      } catch (_error) {
        // A malformed argument string is presentation-only: fall through.
      }
      return undefined;
    }

    /** Flatten the settled text blocks — the failure message source. */
    function readText(block) {
      if (!isSettled(block)) return "";
      var content = Array.isArray(block.content) ? block.content : [];
      var parts = [];
      for (var i = 0; i < content.length; i += 1) {
        var entry = content[i];
        if (entry !== null && typeof entry === "object" && entry.type === "text" && typeof entry.text === "string") {
          parts.push(entry.text);
        }
      }
      if (parts.length === 0 && isSettled(block) && block.error !== null && block.error !== undefined) {
        parts.push(String(block.error.name) + ": " + String(block.error.code));
      }
      return parts.join("\n");
    }

    /** `format, size, quality` detail line, from whichever meta fields survived. */
    function readDetail(block) {
      var meta = readMeta(block);
      if (meta === undefined) return undefined;
      var parts = [];
      var keys = ["format", "size", "quality"];
      for (var i = 0; i < keys.length; i += 1) {
        var value = meta[keys[i]];
        if (typeof value === "string" && value !== "") parts.push(value);
      }
      return parts.length === 0 ? undefined : parts.join(", ");
    }

    /**
     * Reduce the frozen node to the row's presentation state. Kept pure so the
     * view stays a function of what the turn already knows.
     * @param block - the frozen running-or-settled node.
     * @returns one of `running` | `error` | `ready` | `empty` with its copy.
     */
    function describeState(block) {
      if (!isSettled(block)) return { state: "running", summary: "Generating image…" };
      if (block.isError === true) {
        var text = readText(block);
        return { state: "error", summary: text === "" ? "Image generation failed" : firstLine(text) };
      }
      var images = selectImages(block);
      if (images.length === 0) {
        return { state: "empty", summary: "No image in the tool result", images: images };
      }
      return { state: "ready", summary: undefined, images: images };
    }

    /**
     * Plugin-owned open/closed state shared by the sidebar toggle and the
     * overlay panel. Deliberately tiny and in-memory: a dynamic client
     * contribution is process-local, so the panel needs no persistence.
     * @returns the store face (`get` / `set` / `subscribe`).
     */
    function createPanelStore() {
      var open = false;
      var listeners = new Set();
      return {
        get: function () { return open; },
        set: function (next) {
          var value = next === true;
          if (open === value) return;
          open = value;
          listeners.forEach(function (listener) { listener(); });
        },
        subscribe: function (listener) {
          listeners.add(listener);
          return function () { listeners.delete(listener); };
        },
      };
    }
    //#endregion

    //#region view
    /** Subscribe a component to the shared panel store. */
    function usePanelOpen(store) {
      var state = React.useState(store.get());
      var open = state[0];
      var setOpen = state[1];
      React.useEffect(function () {
        setOpen(store.get());
        return store.subscribe(function () { setOpen(store.get()); });
      }, [store]);
      return open;
    }

    /**
     * Subscribe to one session's conversation snapshot and project its images.
     * The root-scoped seats receive no `useSession`, so the session face is
     * resolved through the sessions service and observed directly.
     */
    function useSessionImages(sessions, sessionId) {
      var state = React.useState([]);
      var images = state[0];
      var setImages = state[1];
      React.useEffect(function () {
        if (sessions === undefined || sessionId === undefined) {
          setImages(function (prev) { return prev.length === 0 ? prev : []; });
          return undefined;
        }
        var binding = sessions.binding(sessionId);
        var face = binding === undefined ? undefined : binding.session;
        if (face === undefined || typeof face.subscribe !== "function") {
          setImages(function (prev) { return prev.length === 0 ? prev : []; });
          return undefined;
        }
        var read = function () {
          var next = collectSessionImages(face.getSnapshot());
          setImages(function (prev) { return sameImages(prev, next) ? prev : next; });
        };
        read();
        return face.subscribe(read);
      }, [sessions, sessionId]);
      return images;
    }

    /** The picture glyph shared by the sidebar toggle. */
    function galleryIcon() {
      return h("svg", {
        className: "dsh-igr-toggle-icon",
        width: 16,
        height: 16,
        viewBox: "0 0 16 16",
        "aria-hidden": true,
      }, [
        h("rect", {
          key: "frame",
          x: 1.6,
          y: 2.6,
          width: 12.8,
          height: 10.8,
          rx: 2,
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 1.3,
        }),
        h("path", { key: "hill", d: "M3.4 11.6l2.9-3.3 2.2 2.4 1.8-2 2.3 2.9z", fill: "currentColor" }),
      ]);
    }

    /**
     * The `sidebar.footer.action` entry: an additive toggle beside Settings.
     * Root-scoped, so its only owner prop is the column's `wide` state.
     */
    function makeGalleryButton(store) {
      return function SessionImagesToggle(props) {
        var open = usePanelOpen(store);
        var wide = props.wide !== false;
        var label = "Session images";
        var children = [galleryIcon()];
        if (wide) children.push(h("span", { className: "dsh-igr-toggle-label", key: "label" }, label));
        return h("button", {
          type: "button",
          className: "dsh-igr-toggle",
          "data-open": open ? true : undefined,
          "data-rail": wide ? undefined : true,
          "aria-pressed": open,
          title: label,
          onClick: function () { store.set(!store.get()); },
        }, children);
      };
    }

    /**
     * The `shell.overlay` entry: the gallery card itself. Renders `null` while
     * closed, so the click-through overlay layer stays empty until asked for.
     */
    function makeGalleryPanel(store, loaderFor, sessionsOf) {
      return function SessionImagesPanel(props) {
        var open = usePanelOpen(store);
        var sessionId = typeof props.useSessions === "function"
          ? props.useSessions(function (state) { return state.current; })
          : undefined;
        var images = useSessionImages(sessionsOf(), sessionId);

        if (!open) return null;

        var body;
        if (sessionId === undefined) {
          body = h("div", { className: "dsh-igr-note" }, "Open a session to see its images.");
        } else if (images.length === 0) {
          body = h("div", { className: "dsh-igr-note" }, "No images in this session yet.");
        } else {
          body = h(ImageGallery, {
            images: images,
            load: loaderFor(sessionId),
            align: "start",
            labels: LABELS,
          });
        }

        return h("div", { className: "dsh-igr-panel", role: "dialog", "aria-label": "Session images" }, [
          h("div", { className: "dsh-igr-panel-head", key: "head" }, [
            h("span", { className: "dsh-igr-panel-title", key: "title" }, "Session images"),
            h("span", { className: "dsh-igr-panel-count", key: "count" }, String(images.length)),
            h("button", {
              type: "button",
              className: "dsh-igr-panel-close",
              key: "close",
              title: "Close",
              "aria-label": "Close",
              onClick: function () { store.set(false); },
            }, "×"),
          ]),
          h("div", { className: "dsh-igr-panel-body", key: "body" }, body),
        ]);
      };
    }

    /**
     * The `generate_image` atomic tool row: a compact head plus the durable
     * image gallery. Hook-free — the session-authorized loader is memoized
     * outside the component, so `MessageImage`'s effect does not refetch.
     */
    function makeImageRow(loaderFor) {
      return function GenerateImageRow(props) {
        var block = props.block;
        var described = describeState(block);
        var prompt = readPrompt(block);
        var detail = readDetail(block);
        var summary = described.summary !== undefined ? described.summary : prompt;

        var head = [
          h("span", { className: "dsh-igr-title", key: "title" }, "Image"),
          h("span", { className: "dsh-igr-sep", key: "sep" }),
          h(
            "span",
            {
              className: "dsh-igr-summary",
              key: "summary",
              "data-error": described.state === "error" ? true : undefined,
              title: summary,
            },
            summary !== undefined ? summary : "",
          ),
        ];
        if (detail !== undefined && described.state === "ready") {
          head.push(h("span", { className: "dsh-igr-meta", key: "meta" }, detail));
        }

        var children = [h("div", { className: "dsh-igr-row", key: "row" }, head)];

        if (described.state === "ready") {
          children.push(h(
            "div",
            { className: "dsh-igr-body", key: "body" },
            h(ImageGallery, {
              images: described.images,
              load: loaderFor(props.sessionId),
              align: "start",
              labels: LABELS,
            }),
          ));
        } else if (described.state === "empty") {
          children.push(h(
            "div",
            { className: "dsh-igr-body", key: "body" },
            h("div", { className: "dsh-igr-note" }, "The call succeeded but carried no saved image attachment."),
          ));
        }

        if (typeof props.inspect === "function") {
          children.push(h(
            "button",
            { type: "button", className: "dsh-igr-inspect", key: "inspect", onClick: props.inspect },
            "Inspect",
          ));
        }

        return h("div", { className: "dsh-igr-card", "data-state": described.state }, children);
      };
    }
    //#endregion

    //#region plugin
    /**
     * Services this client plugin requires: the slot registry it registers into,
     * the conversation service that mints session-authorized image URLs, and the
     * sessions service the root-scoped gallery observes for snapshots.
     */
    var inject = ["slots", "conversation", "sessions"];

    /**
     * Mount the browser half: claim the `generate_image` key of the keyed
     * `tool.call.toolview` slot, and add the session gallery's sidebar toggle
     * and overlay panel. Every registration is wrapped in `ctx.slots.inject`
     * and therefore unwinds with the fiber.
     * @param ctx - client root context.
     */
    function apply(ctx) {
      // One stable loader per session: MessageImage's effect lists `load` in its
      // dependencies, so a fresh closure per render would refetch forever.
      var loaders = new Map();
      var loaderFor = function (sessionId) {
        var hit = loaders.get(sessionId);
        if (hit !== undefined) return hit;
        var loader = function (attachment) {
          var conversation = ctx.get("conversation");
          if (conversation === undefined) {
            return Promise.reject(new Error("dsh-image-generation-responses: conversation service unavailable"));
          }
          return conversation.resolveImage(sessionId, attachment);
        };
        loaders.set(sessionId, loader);
        return loader;
      };
      ctx.effect(function () {
        return function () { loaders.clear(); };
      }, "image-generation: image loaders");

      var GenerateImageRow = makeImageRow(loaderFor);
      ctx.slots.inject("tool.call.toolview", function () {
        return ctx.slots.register({ name: "tool.call.toolview", key: "generate_image" }, GenerateImageRow);
      });

      var panel = createPanelStore();
      var sessionsOf = function () { return ctx.get("sessions"); };
      var SessionImagesToggle = makeGalleryButton(panel);
      var SessionImagesPanel = makeGalleryPanel(panel, loaderFor, sessionsOf);

      ctx.slots.inject("sidebar.footer.action", function () {
        return ctx.slots.register(
          { name: "sidebar.footer.action", id: "dsh-image-generation-responses/gallery-toggle" },
          SessionImagesToggle,
        );
      });
      ctx.slots.inject("shell.overlay", function () {
        return ctx.slots.register(
          { name: "shell.overlay", id: "dsh-image-generation-responses/gallery-panel" },
          SessionImagesPanel,
        );
      });
    }
    //#endregion

    exports.apply = apply;
    exports.inject = inject;
    // Pure helpers exported for focused tests; the runtime only reads apply/inject.
    exports.describeState = describeState;
    exports.selectImages = selectImages;
    exports.collectSessionImages = collectSessionImages;
    exports.sameImages = sameImages;
    exports.createPanelStore = createPanelStore;
    exports.readPrompt = readPrompt;
    exports.readDetail = readDetail;
    exports.readText = readText;
    exports.makeImageRow = makeImageRow;
    exports.makeGalleryButton = makeGalleryButton;
    exports.makeGalleryPanel = makeGalleryPanel;
    exports.LABELS = LABELS;
    return module.exports;
  },
});
