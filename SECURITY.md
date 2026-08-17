# Security Policy

## Supported versions

Security fixes are applied to the latest published release. Before the first stable release, compatibility may change between minor versions.

## Reporting a vulnerability

Report vulnerabilities privately through GitHub Security Advisories:

https://github.com/Poepon/dsh-image-generation-responses/security/advisories/new

Do not open a public issue containing API keys, credential files, private endpoint names, private prompts, generated private images, or exploit details. Include the affected version, impact, reproduction steps using synthetic data, and any proposed mitigation.

## Trust boundaries

- `baseURL`, model names, and credential references are trusted deployment configuration. They must never come from model or end-user input.
- The plugin sends the resolved Bearer credential only to the configured `/responses` endpoint and rejects HTTP redirects.
- Production endpoints should use HTTPS. Plain HTTP is intended only for trusted local development.
- Provider responses are size-bounded. Base64 is strictly decoded, and DSH's attachment service validates persisted image bytes and metadata.
- Remote image URLs are rejected; this plugin does not fetch provider-supplied URLs.
- Generated images and prompts are processed under the configured provider's policies.

## Credential handling

Use the DSH credentials service or environment variables. Never commit `.credentials.yaml`, `.env`, secret-bearing profile patches, or copied authorization headers. Rotate a key immediately if it is exposed.
