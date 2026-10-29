# Changelog

## 0.3.5

- Vietnamese help keeps technical terms in English (API key, session, scope, signature, secret, retry, exit code, permission mode, output format, sandbox), and argument placeholders are English everywhere (`/rename <name>`, `/attach <file>`, `/config [key value]`).

## 0.3.4

- Every file in a GitHub release now has a signed build provenance attestation: `gh attestation verify <file> --repo <owner/repo>`. Release notes list the install commands and how to verify a download.
- Security reports go through GitHub's private vulnerability reporting on this repository.

## 0.3.3

- Maintenance release: tidier source comments, no change in behaviour.

## 0.3.2

- `tools list`, the MCP sign-in and help examples follow the modules your product offers.

## 0.3.1

- Help examples (`keys create --scopes`, `ci policy`) show permission codes of your own product.
- Release: a version already on npm is skipped instead of failing the release.

## 0.3.0

- `ci policy request|list|show|revoke|kinds`: pre-approval policies let a CI repository write on its own — chosen write permissions, a total row ceiling (up to 1000), at most 30 days. Anyone requests; an API-key manager approves (or `--approve` if you are one). A CI session cannot request, approve or revoke a policy.
- In CI (`login --ci`, no terminal) with `--mode auto`, proposals are sent for confirmation and the server applies them only within an active policy; otherwise they stay a proposal (exit code 7). `-p --json` reports `proposals[0].applied` and exits 0 when written.
- A CI session calls the API directly with the permissions of the person who added the repository; it cannot create API keys, CI trusts, policies, sessions or other long-lived access.
- `ci trust add` no longer takes write options — use `ci policy request`. Policy ids are shown by their last 8 characters.

## 0.2.0

- `--model`: answer with your own model on your machine — Claude, Gemini, GPT, Grok or Ollama — using your workspace tools over MCP. Writes still only create a proposal you confirm. `model add|list|remove|default`, and `/model` switches inside the chat.
- AI tool access (`tools`, `--model`) now works in workspaces that allow verified AI apps only (the default): the CLI identifies itself with a client metadata document on the developer portal instead of registering a new client.
- `login --ci`: GitHub Actions / GitLab CI sign in with their OIDC token, no secret. Admins allow a repository with `ci trust add`.

## 0.1.1

- x64 builds (Intel Mac, Linux, Windows) now target every x64 CPU, including older Intel Macs without AVX2.
- Browser login exits as soon as the browser returns; `login --device` works with the new device-code sign-in page.

## 0.1.0

First release.

- Chat with the assistant in the terminal, with slash commands, file attachments, permission modes and confirmed writes.
- Login: browser (PKCE), QR via the mobile app, device code, API key, CI OIDC.
- `-p` / `--json` / `--output-format stream-json` for scripts and agents.
- `tools`, `api`, `keys`, `webhooks` (including `listen --forward-to` and `verify`), `mcp install|serve`, `doctor`, `completion`, `update`, `init`.
