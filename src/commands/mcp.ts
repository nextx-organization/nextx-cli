import type { Command } from "commander";
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { fetch } from "undici";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { brand, envVar } from "../core/brand.js";
import { context } from "../core/context.js";
import { CliError, Exit } from "../core/errors.js";
import { tr } from "../core/i18n.js";
import { c, info, ok, warn } from "../core/output.js";
import { hasTty, multiSelect } from "../core/prompt.js";
import { userAgent } from "../core/http.js";
import { mcpToken } from "../auth/mcp-oauth.js";

type Kind = "file-json" | "file-toml" | "command" | "manual";

interface Target {
  id: string;
  name: string;
  kind: Kind;
  /** For file targets. */
  file?: () => string;
  /** Writes our entry into the parsed config. */
  apply?: (cfg: Record<string, unknown>, key: string, url: string, stdio: { command: string; args: string[] }) => void;
  remove?: (cfg: Record<string, unknown>, key: string) => void;
}

const home = homedir();
const appSupport = () =>
  platform() === "darwin" ? join(home, "Library", "Application Support") : platform() === "win32" ? process.env.APPDATA ?? join(home, "AppData", "Roaming") : join(home, ".config");

const obj = (cfg: Record<string, unknown>, k: string) => ((cfg[k] ??= {}) as Record<string, unknown>);

/** Clients in A→Z order: no assistant vendor is favoured. */
const TARGETS: Target[] = [
  { id: "chatgpt", name: "ChatGPT", kind: "manual" },
  { id: "claude", name: "Claude Code", kind: "command" },
  {
    id: "claude-desktop", name: "Claude Desktop", kind: "file-json",
    file: () => join(appSupport(), "Claude", "claude_desktop_config.json"),
    apply: (cfg, key, _u, stdio) => void (obj(cfg, "mcpServers")[key] = stdio),
    remove: (cfg, key) => void delete obj(cfg, "mcpServers")[key],
  },
  {
    id: "codex", name: "Codex", kind: "file-toml",
    file: () => join(process.env.CODEX_HOME ?? join(home, ".codex"), "config.toml"),
    apply: (cfg, key, _u, stdio) => void (obj(cfg, "mcp_servers")[key] = stdio),
    remove: (cfg, key) => void delete obj(cfg, "mcp_servers")[key],
  },
  { id: "copilot", name: "Copilot", kind: "manual" },
  {
    id: "cursor", name: "Cursor", kind: "file-json",
    file: () => join(home, ".cursor", "mcp.json"),
    apply: (cfg, key, url) => void (obj(cfg, "mcpServers")[key] = { url }),
    remove: (cfg, key) => void delete obj(cfg, "mcpServers")[key],
  },
  {
    id: "gemini", name: "Gemini CLI", kind: "file-json",
    file: () => join(home, ".gemini", "settings.json"),
    apply: (cfg, key, url) => void (obj(cfg, "mcpServers")[key] = { httpUrl: url }),
    remove: (cfg, key) => void delete obj(cfg, "mcpServers")[key],
  },
  { id: "grok", name: "Grok", kind: "manual" },
  {
    id: "vscode", name: "VS Code", kind: "file-json",
    file: () => join(appSupport(), "Code", "User", "mcp.json"),
    apply: (cfg, key, url) => void (obj(cfg, "servers")[key] = { type: "http", url }),
    remove: (cfg, key) => void delete obj(cfg, "servers")[key],
  },
  {
    id: "windsurf", name: "Windsurf", kind: "file-json",
    file: () => join(home, ".codeium", "windsurf", "mcp_config.json"),
    apply: (cfg, key, url) => void (obj(cfg, "mcpServers")[key] = { serverUrl: url }),
    remove: (cfg, key) => void delete obj(cfg, "mcpServers")[key],
  },
];

function readCfg(t: Target): Record<string, unknown> {
  const f = t.file!();
  if (!existsSync(f)) return {};
  const raw = readFileSync(f, "utf8");
  if (!raw.trim()) return {};
  return t.kind === "file-toml" ? (parseToml(raw) as Record<string, unknown>) : (JSON.parse(raw) as Record<string, unknown>);
}

function writeCfg(t: Target, cfg: Record<string, unknown>): void {
  const f = t.file!();
  mkdirSync(dirname(f), { recursive: true });
  if (existsSync(f)) copyFileSync(f, `${f}.bak`);
  writeFileSync(f, t.kind === "file-toml" ? stringifyToml(cfg) : `${JSON.stringify(cfg, null, 2)}\n`);
}

function installOne(t: Target, url: string): void {
  const key = brand().bin;
  const stdio = { command: brand().bin, args: ["mcp", "serve", "--stdio", ...(context().env === "sandbox" ? ["--sandbox"] : [])] };
  if (t.kind === "manual") {
    info(`${c.cyan("•")} ${t.name}: ${tr("vào Cài đặt › Kết nối (Connectors) › Thêm, dán", "open Settings › Connectors › Add, paste")} ${c.bold(url)}`);
    return;
  }
  if (t.kind === "command") {
    const r = spawnSync("claude", ["mcp", "add", "--transport", "http", "--scope", "user", key, url], { stdio: "pipe", encoding: "utf8" });
    if (r.error) return info(`${c.cyan("•")} ${t.name}: ${tr("chạy", "run")} ${c.bold(`claude mcp add --transport http ${key} ${url}`)}`);
    if (r.status === 0) return ok(`${t.name}: ${tr(`đã thêm "${key}" → ${url}`, `added "${key}" → ${url}`)}`);
    return warn(`${t.name}: ${(r.stderr || r.stdout).trim()}`);
  }
  const cfg = readCfg(t);
  t.apply!(cfg, key, url, stdio);
  writeCfg(t, cfg);
  ok(`${t.name}: ${tr(`đã thêm "${key}" vào`, `added "${key}" to`)} ${c.dim(t.file!())}`);
}

export function registerMcp(program: Command): void {
  const mcp = program.command("mcp").description(tr("kết nối máy chủ MCP vào trợ lý AI khác", "connect the MCP server to other AI assistants"));

  mcp.command("url").description(tr("in địa chỉ máy chủ MCP", "print the MCP server URL")).action(() => info(context().endpoints.mcp));

  mcp.command("install [clients...]")
    .description(tr(`cài vào: ${TARGETS.map((t) => t.id).join(", ")}`, `install into: ${TARGETS.map((t) => t.id).join(", ")}`))
    .action(async (ids: string[]) => {
      const url = context().endpoints.mcp;
      let chosen = TARGETS.filter((t) => ids.includes(t.id));
      const unknown = ids.filter((i) => !TARGETS.some((t) => t.id === i));
      if (unknown.length) throw new CliError(tr(`Không biết client: ${unknown.join(", ")}`, `Unknown client: ${unknown.join(", ")}`), Exit.usage);
      if (!chosen.length) {
        if (!hasTty()) {
          info(url);
          return;
        }
        chosen = (await multiSelect(tr("Cài máy chủ MCP vào client nào? (mặc định: mọi client MCP)", "Install the MCP server into which clients? (default: any MCP client)"), TARGETS.map((t) => ({ label: t.name, value: t })))) ?? [];
      }
      for (const t of chosen) installOne(t, url);
      if (chosen.length) info(c.dim(tr("  Lần đầu mỗi client sẽ mở trình duyệt để bạn đồng ý quyền.", "  Each client opens the browser once so you can approve access.")));
    });

  mcp.command("uninstall <client>").action((id: string) => {
    const t = TARGETS.find((x) => x.id === id);
    if (!t) throw new CliError(tr("Không biết client này.", "Unknown client."), Exit.usage);
    if (t.kind === "command") return void spawnSync("claude", ["mcp", "remove", brand().bin], { stdio: "inherit" });
    if (t.kind === "manual") return info(tr(`${t.name}: gỡ trong Cài đặt › Kết nối.`, `${t.name}: remove it in Settings › Connectors.`));
    const cfg = readCfg(t);
    t.remove!(cfg, brand().bin);
    writeCfg(t, cfg);
    ok(tr(`Đã gỡ khỏi ${t.name}.`, `Removed from ${t.name}.`));
  });

  mcp.command("serve")
    .description(tr("chạy MCP qua stdio bằng quyền của CLI (cho client không hỗ trợ OAuth)", "serve MCP over stdio with the CLI's grant (for clients without OAuth)"))
    .option("--stdio", tr("dùng stdin/stdout (mặc định)", "use stdin/stdout (default)"))
    .action(async () => serveStdio());
}

/** Line-delimited JSON-RPC on stdio ⇄ Streamable HTTP to the hosted server. Logs go to stderr only. */
async function serveStdio(): Promise<void> {
  // On some platforms an API key speaks MCP through the gateway (same read-only route rules as the key everywhere else).
  let apiKey: string | undefined = undefined;
  const url = apiKey ? `${context().endpoints.api}/api/v1/mcp` : context().endpoints.mcp;
  let token = apiKey ?? (await mcpToken({ interactive: false }));
  let sessionId: string | undefined;
  const rl = createInterface({ input: process.stdin });
  const write = (m: unknown) => process.stdout.write(`${JSON.stringify(m)}\n`);
  for await (const line of rl) {
    if (!line.trim()) continue;
    let msg: { id?: number | string; method?: string };
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    const send = async () =>
      fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${token}`,
          "User-Agent": userAgent(),
          ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
        },
        body: line,
      });
    try {
      let res = await send();
      if (res.status === 401 && !apiKey) {
        token = await mcpToken({ interactive: false });
        res = await send();
      }
      const sid = res.headers.get("mcp-session-id");
      if (sid) sessionId = sid;
      if (msg.id === undefined) {
        await res.body?.cancel();
        continue;
      }
      const ct = res.headers.get("content-type") ?? "";
      if (ct.includes("text/event-stream")) {
        const text = await res.text();
        for (const frame of text.split("\n\n")) {
          const data = frame.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n");
          if (data) process.stdout.write(`${data}\n`);
        }
      } else {
        const body = await res.text();
        if (body) process.stdout.write(`${body.trim()}\n`);
        else write({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: `HTTP ${res.status}` } });
      }
    } catch (e) {
      process.stderr.write(`${(e as Error).message}\n`);
      write({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: (e as Error).message } });
    }
  }
}
