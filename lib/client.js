/**
 * Browser half of `dsh-image-generation-responses`: a keyed `tool.call.toolview`
 * entry for the `generate_image` wire name, so a generated image renders as an
 * actual thumbnail instead of the generic card's serialized image ContentBlock.
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
    /** Scoped, theme-token-driven styling for the row. */
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
    //#endregion

    //#region view
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
     * Services this client plugin requires: the slot registry it registers into
     * and the conversation service that mints session-authorized image URLs.
     */
    var inject = ["slots", "conversation"];

    /**
     * Mount the browser half: claim the `generate_image` key of the keyed
     * `tool.call.toolview` slot. The registration is wrapped in `ctx.slots.inject`
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
    }
    //#endregion

    exports.apply = apply;
    exports.inject = inject;
    // Pure helpers exported for focused tests; the runtime only reads apply/inject.
    exports.describeState = describeState;
    exports.selectImages = selectImages;
    exports.readPrompt = readPrompt;
    exports.readDetail = readDetail;
    exports.readText = readText;
    exports.makeImageRow = makeImageRow;
    exports.LABELS = LABELS;
    return module.exports;
  },
});
