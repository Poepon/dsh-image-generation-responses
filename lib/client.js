/**
 * Browser half of `dsh-image-generation-responses`.
 *
 * Two contributions:
 *
 * 1. A keyed `tool.call.toolview` entry for the `generate_image` wire name, so a
 *    generated image renders as an actual thumbnail instead of the generic
 *    card's serialized image ContentBlock.
 * 2. A session image dock: a vertically centred strip of every durable image
 *    the model returned in the current session (assistant output or tool
 *    results; user uploads are excluded), newest first. It has no toggle — it
 *    appears exactly when the conversation holds such an image and is absent
 *    otherwise.
 *
 * The dock renders through a `document.body` portal rather than inside the
 * `shell.overlay` layer. That layer establishes its own stacking context at
 * `z-index: 20`, which would trap the dock beneath the shipped image lightbox
 * (a body portal at `z-index: 1000`). Portalling to body and sitting above that
 * value is what lets the dock stay visible over an open preview and switch it.
 *
 * The overlay seat is root-scoped and receives only the global kit, so the dock
 * reads the current session id from `useSessions` and subscribes to that
 * session's conversation snapshot through `ctx.sessions` (`binding(id).session`
 * is an ObservableSnapshot). The registration is additive: no shipped occupant
 * is replaced.
 *
 * Shipped as authored distributable source in the
 * `window.__ModuleLoader__.load({ id, factory })` shape used by installed DSH
 * client packages. The final runtime format is maintained directly, so no
 * generated artifact or hidden build step is required.
 *
 * Externals are resolved through the loader's synchronous `require` against the
 * frozen platform module table, so only platform seed words may be required
 * here (`react`, `react-dom`, and `@deepseek-ai/dsh-client-ui-attachment` all
 * are).
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
    var ReactDOM = require("react-dom");
    var uiAttachment = require("@deepseek-ai/dsh-client-ui-attachment");
    var ImageGallery = uiAttachment.ImageGallery;
    var ImageLightbox = uiAttachment.ImageLightbox;
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
      // Session dock: a body portal, vertically centred against the
      // conversation column's left edge. z-index sits above the shipped image
      // lightbox (a body portal at 1000) so the strip stays usable — and lets
      // the user switch previews — while a preview is open.
      ".dsh-igr-dock{position:fixed;top:50%;transform:translateY(-50%);z-index:1200;",
      "display:flex;flex-direction:column;align-items:center;gap:8px;",
      "max-height:82vh;overflow-y:auto;overflow-x:hidden;padding:8px;pointer-events:auto;",
      "border:1px solid var(--dsw-alias-border-l2);border-radius:12px;",
      "background:var(--dsw-alias-bg-base);box-shadow:0 6px 20px rgba(0,0,0,.22);",
      "scrollbar-width:thin}",
      ".dsh-igr-dock::-webkit-scrollbar{width:6px}",
      ".dsh-igr-dock::-webkit-scrollbar-thumb{border-radius:3px;background:var(--dsw-alias-border-l3)}",
      // Half-size thumbnails: MessageImage's `single` box is 240px on its long
      // edge, so the dock's own tiles are capped at 120px.
      ".dsh-igr-thumb{flex:none;display:block;width:auto;max-width:120px;max-height:120px;",
      "padding:0;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;",
      "background:var(--dsw-alias-bg-base);cursor:pointer;overflow:hidden;line-height:0}",
      ".dsh-igr-thumb:hover{border-color:var(--dsw-alias-border-l3)}",
      ".dsh-igr-thumb[data-active]{border-color:var(--dsw-alias-label-secondary)}",
      ".dsh-igr-thumb>img{display:block;max-width:118px;max-height:118px;width:auto;height:auto;object-fit:contain}",
      ".dsh-igr-thumb-pending{display:flex;align-items:center;justify-content:center;",
      "width:64px;height:64px;font-size:10px;line-height:14px;text-align:center;",
      "color:var(--dsw-alias-label-caption)}",
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
    /**
     * Locale namespace and dictionaries for every user-facing string this
     * client renders (the tool row and the session dock). Chinese is the key
     * set source of truth, matching the shell's own packages; `en` must carry
     * exactly the same keys. Model-facing text (tool descriptions, result
     * summaries, errors) stays English in the Host half on purpose.
     */
    var NS = "dsh-image-generation-responses";
    var DICT_ZH = {
      "row.title": "图像",
      "row.running": "正在生成图像…",
      "row.failed": "图像生成失败",
      "row.emptySummary": "工具结果中没有图像",
      "row.emptyNote": "调用成功，但没有返回已保存的图像附件。",
      "row.inspect": "检查",
      "dock.aria": "会话图片",
      "label.image": "生成的图片",
      "label.open": "查看原图",
      "label.openNamed": "查看原图：{label}",
      "label.loading": "图片加载中…",
      "label.loadFailed": "加载失败，点击重试",
      "lightbox.dialog": "图片预览",
      "lightbox.close": "关闭",
    };
    var DICT_EN = {
      "row.title": "Image",
      "row.running": "Generating image…",
      "row.failed": "Image generation failed",
      "row.emptySummary": "No image in the tool result",
      "row.emptyNote": "The call succeeded but carried no saved image attachment.",
      "row.inspect": "Inspect",
      "dock.aria": "Session images",
      "label.image": "Generated image",
      "label.open": "Open the original image",
      "label.openNamed": "Open the original image: {label}",
      "label.loading": "Loading image…",
      "label.loadFailed": "Load failed — retry",
      "lightbox.dialog": "Generated image preview",
      "lightbox.close": "Close",
    };

    /**
     * English fallback translator, used when a component renders without the
     * framework `t` seat (unit tests, or a shell without the locale plugin).
     * Mirrors the locale runtime's `{name}` interpolation.
     */
    function defaultT(key, params) {
      var template = DICT_EN[key];
      if (typeof template !== "string") return key;
      if (params === undefined || params === null) return template;
      return template.replace(/\{(\w+)\}/g, function (match, name) {
        return Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match;
      });
    }

    /** The framework `t` seat when the registration's locale is live, else English. */
    function tOf(props) {
      return props !== null && typeof props === "object" && typeof props.t === "function" ? props.t : defaultT;
    }

    /** Strings the gallery atoms resolve through their owner, translated. */
    function galleryLabels(t) {
      return {
        image: t("label.image"),
        open: t("label.open"),
        openNamed: function (label) { return t("label.openNamed", { label: label }); },
        loading: t("label.loading"),
        loadFailed: t("label.loadFailed"),
        lightbox: { dialog: t("lightbox.dialog"), close: t("lightbox.close") },
      };
    }

    /** English labels, kept for the export contract. */
    var LABELS = galleryLabels(defaultT);

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
     * Collect every model-returned durable image in one conversation snapshot,
     * newest first and deduplicated by attachment id.
     *
     * Only assistant output and tool results count: user uploads, steering
     * messages, and context injections are deliberately excluded — the dock is
     * a gallery of what the model produced, not of what the human sent.
     * Reads only the leaf fields two node shapes expose: classified assistant
     * `blocks`, and a tool result's `content` blocks plus its presentation
     * `meta.attachment` fallback. Unknown node kinds contribute nothing rather
     * than throwing, so a newer host surface degrades quietly.
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
        if (node.kind === "assistant") {
          var blocks = Array.isArray(node.blocks) ? node.blocks : [];
          for (var k = 0; k < blocks.length; k += 1) {
            var block = blocks[k];
            if (block !== null && typeof block === "object" && block.kind === "image") push(block.attachment);
          }
        } else if (node.kind === "tool-result") {
          var content = Array.isArray(node.content) ? node.content : [];
          for (var j = 0; j < content.length; j += 1) {
            var entry = content[j];
            if (entry !== null && typeof entry === "object" && entry.type === "image") push(entry.attachment);
          }
        }
        // Presentation meta is a per-node fallback, exactly as in the tool row:
        // it only speaks for a tool result whose canonical blocks carried no
        // image.
        if (node.kind === "tool-result" && images.length === before
          && node.meta !== null && typeof node.meta === "object") {
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
     * view stays a function of what the turn already knows. Only DYNAMIC text
     * (provider error lines) is returned here; static strings are translated
     * by the row component through its `t` seat.
     * @param block - the frozen running-or-settled node.
     * @returns one of `running` | `error` | `ready` | `empty` with its data.
     */
    function describeState(block) {
      if (!isSettled(block)) return { state: "running" };
      if (block.isError === true) {
        var text = readText(block);
        return { state: "error", summary: text === "" ? undefined : firstLine(text) };
      }
      var images = selectImages(block);
      if (images.length === 0) {
        return { state: "empty", images: images };
      }
      return { state: "ready", images: images };
    }

    //#endregion

    //#region view
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

    /**
     * Resolve every image's URL through the session-authorized loader and keep
     * the results keyed by attachment id.
     *
     * The dock owns the URLs itself instead of delegating to `MessageImage`,
     * because a switchable preview needs the resolved `src` of the SELECTED
     * image at the dock level — `MessageImage` keeps that state private and
     * opens its own lightbox per thumbnail.
     * @param images - the collected gallery items.
     * @param load - the session-authorized loader.
     * @returns a map from attachment id to resolved URL (absent until settled).
     */
    function useResolvedImages(images, load) {
      var state = React.useState({});
      var urls = state[0];
      var setUrls = state[1];
      React.useEffect(function () {
        if (load === undefined || images.length === 0) return undefined;
        var live = true;
        images.forEach(function (item) {
          var id = item.attachment.attachmentId;
          load(item.attachment).then(function (url) {
            if (!live || typeof url !== "string" || url === "") return;
            setUrls(function (prev) {
              if (prev[id] === url) return prev;
              var next = Object.assign({}, prev);
              next[id] = url;
              return next;
            });
          }).catch(function () {
            // A failed load simply leaves the tile in its pending state.
          });
        });
        return function () { live = false; };
      }, [images, load]);
      return urls;
    }

    /**
     * Track the frame's left column width so the dock can sit exactly against
     * the conversation column's left edge.
     *
     * The dock is a body portal, so it cannot inherit the frame's grid geometry;
     * the sidebar column's rendered width IS its `left`. That width is owner
     * state of the `sidebar` slot, which this root-scoped seat cannot read, and
     * it changes on collapse and on drag. So it is measured from the live column
     * box, with a ResizeObserver when the platform provides one and a
     * window-resize fallback otherwise.
     * @param active - whether the dock is currently mounted and visible.
     * @returns the current sidebar width in px (0 before the first measurement).
     */
    function useSidebarOffset(active) {
      var state = React.useState(0);
      var offset = state[0];
      var setOffset = state[1];
      React.useEffect(function () {
        if (!active || typeof document === "undefined") return undefined;
        var layer = document.querySelector("[data-shell-overlay]");
        var frame = layer === null ? null : layer.parentElement;
        var column = frame === null ? null : frame.firstElementChild;
        if (column === null || typeof column.getBoundingClientRect !== "function") return undefined;
        var read = function () {
          var width = column.getBoundingClientRect().width;
          setOffset(function (prev) { return prev === width ? prev : width; });
        };
        read();
        if (typeof ResizeObserver === "function") {
          var observer = new ResizeObserver(read);
          observer.observe(column);
          return function () { observer.disconnect(); };
        }
        if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
          window.addEventListener("resize", read);
          return function () { window.removeEventListener("resize", read); };
        }
        return undefined;
      }, [active]);
      return offset;
    }

    /**
     * The `shell.overlay` entry: a vertically centred strip of the current
     * session's images beside the conversation column, plus the preview it
     * drives.
     *
     * Rendered through a `document.body` portal: the overlay layer establishes
     * its own stacking context, which would trap the strip beneath the shipped
     * lightbox. Portalling out and sitting above the lightbox's z-index is what
     * keeps the strip clickable over an open preview, so clicking another
     * thumbnail switches the preview in place.
     *
     * There is no toggle — the strip renders exactly when the session holds at
     * least one image, and `null` otherwise.
     */
    function makeGalleryPanel(loaderFor, sessionsOf) {
      return function SessionImagesDock(props) {
        var sessionId = typeof props.useSessions === "function"
          ? props.useSessions(function (state) { return state.current; })
          : undefined;
        var images = useSessionImages(sessionsOf(), sessionId);
        var load = sessionId === undefined ? undefined : loaderFor(sessionId);
        var urls = useResolvedImages(images, load);
        var offset = useSidebarOffset(images.length > 0);
        var previewState = React.useState(null);
        var preview = previewState[0];
        var setPreview = previewState[1];

        // Never strand a preview on an image the session no longer carries.
        var previewLive = preview !== null && images.some(function (item) {
          return item.attachment.attachmentId === preview;
        });
        React.useEffect(function () {
          if (preview !== null && !previewLive) setPreview(null);
        }, [preview, previewLive]);

        if (images.length === 0 || typeof ReactDOM.createPortal !== "function"
          || typeof document === "undefined" || document.body === undefined) {
          return null;
        }

        var t = tOf(props);
        var labels = galleryLabels(t);
        var tiles = images.map(function (item) {
          var id = item.attachment.attachmentId;
          var src = urls[id];
          var label = typeof item.attachment.name === "string" && item.attachment.name !== ""
            ? item.attachment.name
            : labels.image;
          return h("button", {
            type: "button",
            className: "dsh-igr-thumb",
            key: id,
            "data-active": previewLive && preview === id ? true : undefined,
            title: labels.open,
            "aria-label": labels.openNamed(label),
            disabled: src === undefined,
            onClick: function () { if (src !== undefined) setPreview(id); },
          }, src === undefined
            ? h("span", { className: "dsh-igr-thumb-pending" }, labels.loading)
            : h("img", { src: src, alt: label }));
        });

        var children = [h("div", {
          className: "dsh-igr-dock",
          key: "dock",
          role: "list",
          "aria-label": t("dock.aria"),
          style: { left: offset + 12 + "px" },
        }, tiles)];

        if (previewLive) {
          var active = images.filter(function (item) {
            return item.attachment.attachmentId === preview;
          })[0];
          var activeSrc = urls[preview];
          if (active !== undefined && activeSrc !== undefined) {
            children.push(h(ImageLightbox, {
              key: "preview",
              src: activeSrc,
              alt: typeof active.attachment.name === "string" && active.attachment.name !== ""
                ? active.attachment.name
                : labels.image,
              labels: labels.lightbox,
              onClose: function () { setPreview(null); },
            }));
          }
        }

        return ReactDOM.createPortal(children, document.body);
      };
    }

    /**
     * The `generate_image` atomic tool row: a compact head plus the durable
     * image gallery. Hook-free — the session-authorized loader is memoized
     * outside the component, so `MessageImage`'s effect does not refetch.
     */
    function makeImageRow(loaderFor) {
      return function GenerateImageRow(props) {
        var t = tOf(props);
        var block = props.block;
        var described = describeState(block);
        var prompt = readPrompt(block);
        var detail = readDetail(block);
        // Dynamic text (provider error line, the requested prompt) wins;
        // otherwise the state decides which translated string to show.
        var summary = described.summary !== undefined ? described.summary
          : described.state === "running" ? t("row.running")
            : described.state === "error" ? t("row.failed")
              : described.state === "empty" ? t("row.emptySummary")
                : prompt;

        var head = [
          h("span", { className: "dsh-igr-title", key: "title" }, t("row.title")),
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
              labels: galleryLabels(t),
            }),
          ));
        } else if (described.state === "empty") {
          children.push(h(
            "div",
            { className: "dsh-igr-body", key: "body" },
            h("div", { className: "dsh-igr-note" }, t("row.emptyNote")),
          ));
        }

        if (typeof props.inspect === "function") {
          children.push(h(
            "button",
            { type: "button", className: "dsh-igr-inspect", key: "inspect", onClick: props.inspect },
            t("row.inspect"),
          ));
        }

        return h("div", { className: "dsh-igr-card", "data-state": described.state }, children);
      };
    }
    //#endregion

    //#region plugin
    /**
     * Services this client plugin requires: the slot registry it registers
     * into, the conversation service that mints session-authorized image URLs,
     * the sessions service the root-scoped gallery observes for snapshots, and
     * the locale service its UI dictionaries register into.
     */
    var inject = ["slots", "conversation", "sessions", "locale"];

    /**
     * Mount the browser half: register the UI dictionaries, claim the
     * `generate_image` key of the keyed `tool.call.toolview` slot, and add the
     * session image dock as an additive `shell.overlay` entry. Every
     * registration is wrapped in `ctx.effect` / `ctx.slots.inject` and
     * therefore unwinds with the fiber.
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

      // UI dictionaries (zh key set is the source of truth; en mirrors it).
      ctx.effect(function () {
        return ctx.locale.register(NS, { zh: DICT_ZH, en: DICT_EN });
      }, "image-generation: dictionaries");

      var GenerateImageRow = makeImageRow(loaderFor);
      ctx.slots.inject("tool.call.toolview", function () {
        return ctx.slots.register({ name: "tool.call.toolview", key: "generate_image", locale: NS }, GenerateImageRow);
      });

      var sessionsOf = function () { return ctx.get("sessions"); };
      var SessionImagesDock = makeGalleryPanel(loaderFor, sessionsOf);

      ctx.slots.inject("shell.overlay", function () {
        return ctx.slots.register(
          { name: "shell.overlay", id: "dsh-image-generation-responses/gallery-panel", locale: NS },
          SessionImagesDock,
        );
      });
    }
    //#endregion

    exports.apply = apply;
    exports.inject = inject;
    // Pure helpers exported for focused tests; the runtime only reads apply/inject.
    exports.NS = NS;
    exports.DICT_ZH = DICT_ZH;
    exports.DICT_EN = DICT_EN;
    exports.defaultT = defaultT;
    exports.galleryLabels = galleryLabels;
    exports.describeState = describeState;
    exports.selectImages = selectImages;
    exports.collectSessionImages = collectSessionImages;
    exports.sameImages = sameImages;
    exports.readPrompt = readPrompt;
    exports.readDetail = readDetail;
    exports.readText = readText;
    exports.makeImageRow = makeImageRow;
    exports.makeGalleryPanel = makeGalleryPanel;
    exports.LABELS = LABELS;
    return module.exports;
  },
});
