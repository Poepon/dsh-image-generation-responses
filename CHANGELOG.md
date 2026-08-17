# Changelog

All notable changes to this project are documented here. This project follows Semantic Versioning.

## [Unreleased]

### Added

- Image-to-image editing: `generate_image` accepts `images` (attachment ids from the calling conversation) and the edit-only `input_fidelity`, sending `action: "edit"` with `input_image` blocks. Reference bytes are read back through `attachments.readImage` against the full reference recovered from the session log, so editing is confined to images that session can already see. The text-to-image request shape is unchanged.
- Session image dock in the web client: a vertically centred strip beside the conversation column, shown automatically whenever the conversation holds an image. Thumbnails are half the chat-history `single` size, newest first and deduplicated by attachment id; the strip stacks above the original-image preview so clicking another thumbnail switches the preview in place.

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
