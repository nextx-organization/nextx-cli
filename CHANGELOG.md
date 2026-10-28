# Changelog

## 0.1.1

- x64 builds (Intel Mac, Linux, Windows) now target every x64 CPU, including older Intel Macs without AVX2.
- Browser login exits as soon as the browser returns; `login --device` works with the new device-code sign-in page.

## 0.1.0

First release.

- Chat with the assistant in the terminal (`nextx`), with slash commands, file attachments, permission modes and confirmed writes.
- Login: browser (PKCE), QR via the mobile app, device code, API key, CI OIDC.
- `-p` / `--json` / `--output-format stream-json` for scripts and agents.
- `tools`, `api`, `keys`, `webhooks` (including `listen --forward-to` and `verify`), `mcp install|serve`, `doctor`, `completion`, `update`, `init`.
