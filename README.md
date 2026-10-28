# NextX CLI

`nextx` brings NextX AI and the NextX developer platform to your terminal.

- **Chat** with NextX AI on your real workspace data: type `nextx`.
- **Script it**: `nextx -p "question" --json`, stream with `--output-format stream-json`.
- **Developer tools**: call the API, AI tools, API keys, webhooks (`nextx webhooks listen --forward-to localhost:3000`), MCP setup for other assistants.

Documentation: https://developers.nextx.vn/docs/cli

## Install

macOS / Linux:

```bash
curl -fsSL https://developers.nextx.vn/install.sh | sh
```

Windows (PowerShell):

```powershell
irm https://developers.nextx.vn/install.ps1 | iex
```

Homebrew:

```bash
brew install nextx-organization/tap/nextx
```

npm (Node 20+):

```bash
npm install -g @nextxai/cli
```

## Quick start

```bash
nextx login          # browser, or --qr over SSH
nextx                # open the chat
nextx -p "yesterday's revenue by branch"
nextx doctor
```

In CI, use an API key (`NEXTX_API_KEY`) or `nextx login --ci` with GitHub Actions OIDC.

## Security

Tokens are kept in the operating system keychain when available. Writes proposed by the assistant are never applied without your confirmation in an interactive terminal. Report vulnerabilities as described in [SECURITY.md](SECURITY.md).

## License

MIT
