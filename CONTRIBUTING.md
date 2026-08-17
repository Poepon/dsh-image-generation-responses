# Contributing

Contributions are welcome through GitHub issues and pull requests.

## Before opening an issue

- Remove API keys, credential files, private endpoint names, private prompts, and generated private images.
- Confirm the provider implements the exact `/responses` + Bearer + `image_generation` contract documented in README.
- Include the plugin, Node.js, and DSH versions, the stable error code, and a minimal redacted configuration.

## Development

1. Fork and clone the repository.
2. Install dependencies with `npm install`.
3. Make a focused change with tests.
4. Run `npm run check` and `npm pack --dry-run`.
5. Open a pull request describing behavior, compatibility impact, and verification.

Tests must not use real credentials or make paid provider calls. Keep protocol parsing tests dependency-free where practical. Client changes must preserve the DSH module-loader bundle contract and include focused bundle tests.

Do not commit `node_modules`, coverage output, package archives, DSH profiles, credentials, attachments, or generated user images. Document user-visible changes in README and CHANGELOG.

By contributing, you agree that your contributions are licensed under the MIT License.
