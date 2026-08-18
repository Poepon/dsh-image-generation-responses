# Changelog

All notable changes to this project are documented here. This project follows Semantic Versioning.

## [Unreleased]

### Fixed

- The model-facing tool result no longer crashes text-only conversation models: the `image` ContentBlock is included only when the route declares image input (resolved per call from the session's request header through `llm.resolveModelInfo`), which previously aborted the whole turn with `UNSUPPORTED_CONTENT` on adapters such as pi-ai. The text summary now always names the saved attachment id, and the UI still renders the image from the presentation meta.

### Added

- Localization: every user-facing client string (tool row, session dock, gallery and lightbox affordances) is registered as `zh`/`en` dictionaries through the shell locale service and follows the language switcher; English is the fallback when the locale seat is absent. Model-facing text intentionally stays English.
- Image understanding: a new `analyze_image` tool answers natural-language questions about conversation images through the same Responses endpoint (plain completion with `input_text` + `input_image` blocks), completing the generate → review → edit loop for text-only conversation models. Model defaults to `responseModel`, overridable with the new `visionModel` config; the text-only result is safe on every route.
- Image-to-image editing: `generate_image` accepts `images` (attachment ids from the calling conversation) and the edit-only `input_fidelity`, sending `action: "edit"` with `input_image` blocks. Reference bytes are read back through `attachments.readImage` against the full reference recovered from the session log, so editing is confined to images that session can already see. The text-to-image request shape is unchanged.
- Session image dock in the web client: a vertically centred strip beside the conversation column, shown automatically whenever the conversation holds a model-returned image. Only assistant output and tool results are collected — user uploads, steering messages, and context injections are excluded. Thumbnails are half the chat-history `single` size, newest first and deduplicated by attachment id; the strip stacks above the original-image preview so clicking another thumbnail switches the preview in place.

## [0.1.0] - 2025-08-17

### Added

- `generate_image` over the Responses API `image_generation` tool.
- Per-call credential resolution and bounded non-streaming response handling.
- Strict base64 extraction for official and compatible legacy response shapes.
- Durable DSH attachment storage and canonical metadata output.
- Dedicated DSH web tool view with inline gallery rendering and original-image preview.
- Unit coverage for protocol parsing, Host execution, and Client presentation.

### Changed

- Prepared public documentation, package metadata, security guidance, and CI.
- Reject HTTP redirects for credential-bearing generation requests.
- Sanitize and bound provider-controlled error details.

### Fixed

- Corrected WebP RIFF magic-byte detection.

[Unreleased]: https://github.com/Poepon/dsh-image-generation-responses/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Poepon/dsh-image-generation-responses/releases/tag/v0.1.0
