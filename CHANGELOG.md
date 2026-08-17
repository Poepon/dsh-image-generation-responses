# Changelog

All notable changes to this project are documented here. This project follows Semantic Versioning.

## [Unreleased]

### Added

- Session image gallery in the web client: a `sidebar.footer.action` toggle and a `shell.overlay` panel listing the current session's durable images, newest first and deduplicated by attachment id.

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
