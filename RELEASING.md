# Release Checklist

Use this checklist for every public release. Commands assume the repository root.

## Repository

- [ ] Confirm `git status --short` contains only intended changes.
- [ ] Confirm `README.md`, `README.zh-CN.md`, `LICENSE`, `SECURITY.md`, `CONTRIBUTING.md`, and `CHANGELOG.md` are current.
- [ ] Confirm no credentials, private endpoints, prompts, generated images, attachments, or DSH profile files are staged.
- [ ] Confirm the version in `package.json` and the release heading in `CHANGELOG.md` match.
- [ ] Confirm the GitHub repository URL is `https://github.com/Poepon/dsh-image-generation-responses`.

## Verification

- [ ] Run `npm install` with a supported Node.js version.
- [ ] Run `npm run check`.
- [ ] Run `npm pack --dry-run --json` and inspect every listed file.
- [ ] Verify the tarball contains only package metadata, license/readme files, and `lib/` runtime files.
- [ ] Verify the GitHub Actions CI matrix passes on Node.js 20 and 22.
- [ ] Verify `npm view dsh-image-generation-responses` and confirm package-name ownership before the first publish.

## DSH smoke test

- [ ] Install the packed tarball into a clean DSH web profile.
- [ ] Mount the plugin using the documented `cordis.patch.yml` example and a test credential.
- [ ] Restart DSH so the Client half is discovered.
- [ ] Generate PNG and WebP images and confirm both appear in the conversation gallery.
- [ ] Open the original-image preview and reload the conversation to confirm durable attachment access.
- [ ] Confirm missing credentials, provider rejection, redirect, timeout, and oversized responses produce bounded errors without endpoint or credential leakage.

## Publish

- [ ] Commit the release changes and create an annotated `v<version>` tag.
- [ ] Push the commit and tag only after CI succeeds.
- [ ] Publish from an authenticated npm environment with 2FA or trusted publishing.
- [ ] Verify the npm package page, package provenance when configured, GitHub release notes, and install instructions.
- [ ] Install the published version once in a clean profile and repeat the basic PNG conversation-rendering smoke test.

Do not publish from a dirty worktree or bypass a failed check. This repository intentionally does not contain credentials or paid live-generation tests.
