import type { Command } from "commander";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fetch } from "undici";
import { brand, envVar } from "../core/brand.js";
import { context } from "../core/context.js";
import { CliError, Exit } from "../core/errors.js";
import { tr } from "../core/i18n.js";
import { c, emit, info, isJson, ok } from "../core/output.js";
import { loadConfig, saveConfig, SETTABLE, getProfile } from "../core/config.js";
import { updateCheckFile } from "../core/paths.js";
import { userAgent, isOlder } from "../core/http.js";
import { VERSION } from "../core/version.js";
import { storageKind } from "../auth/credentials.js";
import { authSource, currentAuth } from "../auth/session.js";
import { readGrant } from "../auth/mcp-oauth.js";
import { notesFileName } from "./ai.js";

// ── doctor ─────────────────────────────────────────────────────────────────────────────────────────

interface Check {
  name: string;
  ok: boolean | "warn";
  detail: string;
}

async function timed(url: string, init?: Parameters<typeof fetch>[1]) {
  const t = Date.now();
  const res = await fetch(url, { ...init, headers: { "User-Agent": userAgent(), ...(init?.headers as Record<string, string>) } });
  return { res, ms: Date.now() - t };
}

export async function doctor(): Promise<Check[]> {
  const ep = context().endpoints;
  const checks: Check[] = [];
  const add = (name: string, ok: Check["ok"], detail: string) => checks.push({ name, ok, detail });

  for (const [label, url] of [["API", `${ep.api}/api/v1/iam/auth/me`], [tr("Đăng nhập", "Auth"), `${ep.auth}/.well-known/oauth-authorization-server`], ["MCP", `${new URL(ep.mcp).origin}/.well-known/oauth-protected-resource`]] as const) {
    try {
      const { res, ms } = await timed(url);
      await res.body?.cancel();
      add(label, res.status < 500, `${new URL(url).host} · HTTP ${res.status} · ${ms}ms`);
      if (label === "API") {
        const server = Date.parse(res.headers.get("date") ?? "");
        if (server) {
          const skew = Math.round((Date.now() - server) / 1000);
          add(tr("Đồng hồ", "Clock"), Math.abs(skew) > 120 ? false : Math.abs(skew) > 30 ? "warn" : true, tr(`lệch ${skew}s so với máy chủ`, `${skew}s off from the server`));
        }
      }
    } catch (e) {
      const code = (e as { cause?: { code?: string } }).cause?.code ?? (e as Error).message;
      add(label, false, `${new URL(url).host} · ${code}`);
    }
  }
  const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy;
  if (proxy) add("Proxy", true, proxy.replace(/\/\/[^@]*@/, "//***@"));
  if (process.env.NODE_EXTRA_CA_CERTS) add("CA", true, process.env.NODE_EXTRA_CA_CERTS);

  const src = authSource();
  if (src === "none") add(tr("Danh tính", "Identity"), false, tr(`chưa đăng nhập · ${brand().bin} login`, `not logged in · ${brand().bin} login`));
  else {
    try {
      await currentAuth({ required: true });
      const { get } = await import("../core/http.js");
      const me = await get<{ email?: string; permissions?: string[]; workspace?: { name: string } }>("/iam/auth/me");
      add(tr("Danh tính", "Identity"), true, `${src} · ${me.email ?? ""} · ${me.workspace?.name ?? ""} · ${me.permissions?.length ?? 0} ${tr("quyền", "permissions")}`);
      try {
        const u = await (await import("../ai/client.js")).usage();
        add(tr("Gói AI", "AI plan"), u.limit === 0 ? "warn" : true, `${u.planName ?? "-"}${u.limit ? ` · ${tr("còn", "left")} ${u.remaining}/${u.limit}` : ""}`);
      } catch {
        // API keys cannot read usage
      }
    } catch (e) {
      add(tr("Danh tính", "Identity"), false, (e as Error).message);
    }
  }
  add(tr("Lưu token", "Token storage"), storageKind() === "keychain" ? true : "warn", storageKind() === "keychain" ? "Keychain" : tr("tệp 0600 (không có Keychain)", "0600 file (no keychain)"));
  add(tr("Công cụ AI", "AI tools"), readGrant() ? true : "warn", readGrant() ? tr("đã cấp quyền", "granted") : tr(`chưa cấp · ${brand().bin} tools login`, `not granted · ${brand().bin} tools login`));
  const latest = await latestVersion().catch(() => undefined);
  add(tr("Phiên bản", "Version"), latest && isOlder(VERSION, latest) ? "warn" : true, latest && isOlder(VERSION, latest) ? `${VERSION} → ${latest} · ${brand().bin} update` : `${VERSION}${latest ? ` (${tr("mới nhất", "latest")})` : ""}`);
  add("Node", Number(process.versions.node.split(".")[0]) >= 20, process.versions.node);
  return checks;
}

// ── updates ────────────────────────────────────────────────────────────────────────────────────────

async function latestVersion(channel = loadConfig().updateChannel ?? "latest"): Promise<string | undefined> {
  const res = await fetch(`https://registry.npmjs.org/${brand().pkg.replace("/", "%2f")}`, { headers: { Accept: "application/vnd.npm.install-v1+json" }, signal: AbortSignal.timeout(3000) });
  if (!res.ok) return undefined;
  const body = (await res.json()) as { "dist-tags"?: Record<string, string> };
  return body["dist-tags"]?.[channel === "next" ? "next" : "latest"];
}

export function installMethod(): "npm" | "brew" | "standalone" | "dev" {
  const script = process.argv[1] ?? "";
  if (/Cellar|homebrew/i.test(script) || /Cellar|homebrew/i.test(process.execPath)) return "brew";
  if (!/node(\.exe)?$/i.test(process.execPath) && !/bun/i.test(process.execPath)) return "standalone";
  if (script.includes("node_modules")) return "npm";
  return "dev";
}

export async function maybeNotifyUpdate(): Promise<void> {
  if (isJson() || !process.stderr.isTTY || envVar("NO_UPDATE_CHECK") === "1" || loadConfig().updateCheck === false) return;
  const f = updateCheckFile();
  let last = 0;
  let latest: string | undefined;
  try {
    const s = JSON.parse(readFileSync(f, "utf8")) as { at: number; latest?: string };
    last = s.at;
    latest = s.latest;
  } catch {
    // first run
  }
  if (Date.now() - last > 24 * 3600e3) {
    latest = await latestVersion().catch(() => undefined);
    writeFileSync(f, JSON.stringify({ at: Date.now(), latest }));
  }
  if (latest && isOlder(VERSION, latest)) process.stderr.write(c.dim(`\n${tr("Có bản mới", "Update available")} ${VERSION} → ${latest} · ${brand().bin} update\n`));
}

// ── completion ─────────────────────────────────────────────────────────────────────────────────────

/** Candidates for the word being completed, walking the command tree. */
export function completions(program: Command, words: string[]): string[] {
  let cmd = program;
  const done = words.slice(0, -1);
  const cur = words[words.length - 1] ?? "";
  for (const w of done) {
    const sub = cmd.commands.find((s) => s.name() === w || s.aliases().includes(w));
    if (sub) cmd = sub;
  }
  const opts = [...cmd.options, ...(cmd === program ? [] : program.options)].flatMap((o) => [o.long, o.short]).filter(Boolean) as string[];
  const subs = cmd.commands.filter((s) => !s.name().startsWith("__")).map((s) => s.name());
  return (cur.startsWith("-") ? opts : subs).filter((x) => x.startsWith(cur));
}

function completionScript(shell: string): string {
  const b = brand().bin;
  switch (shell) {
    case "bash":
      return `_${b}_complete() {\n  local IFS=$'\\n'\n  COMPREPLY=( $(${b} __complete "\${COMP_WORDS[@]:1:COMP_CWORD}") )\n}\ncomplete -o default -F _${b}_complete ${b}\n`;
    case "zsh":
      return `#compdef ${b}\n_${b}() {\n  local -a items\n  items=("\${(@f)$(${b} __complete "\${words[@]:1:CURRENT-1}")}")\n  compadd -a items\n}\ncompdef _${b} ${b}\n`;
    case "fish":
      return `complete -c ${b} -f -a '(${b} __complete (commandline -opc)[2..-1] (commandline -ct))'\n`;
    case "powershell":
      return `Register-ArgumentCompleter -Native -CommandName ${b} -ScriptBlock {\n  param($wordToComplete, $commandAst)\n  $words = $commandAst.CommandElements | Select-Object -Skip 1 | ForEach-Object { $_.ToString() }\n  if ($wordToComplete -eq '') { $words += '' }\n  & ${b} __complete @words | ForEach-Object { [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_) }\n}\n`;
    default:
      throw new CliError(tr("Shell: bash | zsh | fish | powershell", "Shell: bash | zsh | fish | powershell"), Exit.usage);
  }
}

// ── register ───────────────────────────────────────────────────────────────────────────────────────

export function registerUtil(program: Command): void {
  const b = brand();

  program.command("doctor").description(tr("kiểm kết nối, đồng hồ, token, gói, phiên bản", "check connectivity, clock, token, plan, version"))
    .action(async () => {
      const checks = await doctor();
      emit(checks, () => {
        for (const ch of checks) info(`${ch.ok === true ? c.green("✓") : ch.ok === "warn" ? c.yellow("⚠") : c.red("✗")} ${ch.name.padEnd(14)} ${ch.detail}`);
      });
      if (checks.some((ch) => ch.ok === false)) process.exitCode = Exit.general;
    });

  const cfg = program.command("config").description(tr("cài đặt", "settings"));
  cfg.command("list", { isDefault: true }).action(() => {
    const c0 = loadConfig();
    emit(c0, () => {
      for (const k of Object.keys(SETTABLE)) info(`${k.padEnd(16)} ${String((c0 as unknown as Record<string, unknown>)[k] ?? c.dim("—"))}`);
      info(c.dim(`${tr("hồ sơ", "profiles")}: ${Object.keys(c0.profiles).join(", ") || "—"}`));
    });
  });
  cfg.command("get <key>").action((key: string) => info(String((loadConfig() as unknown as Record<string, unknown>)[key] ?? "")));
  cfg.command("set <key> <value>").description(Object.keys(SETTABLE).join(" · ")).action((key: string, value: string) => {
    const parse = SETTABLE[key];
    if (!parse) throw new CliError(tr(`Không có cài đặt "${key}". Có: ${Object.keys(SETTABLE).join(", ")}`, `No setting "${key}". Available: ${Object.keys(SETTABLE).join(", ")}`), Exit.usage);
    const c0 = loadConfig() as unknown as Record<string, unknown>;
    try {
      c0[key] = parse(value);
    } catch (e) {
      throw new CliError((e as Error).message, Exit.usage);
    }
    saveConfig(c0 as never);
    ok(`${key} = ${String(c0[key])}`);
  });

  program.command("completion <shell>").description(tr("gợi ý Tab cho bash | zsh | fish | powershell", "Tab completion for bash | zsh | fish | powershell"))
    .addHelpText("after", tr(`\nVí dụ: ${b.bin} completion zsh > ~/.zfunc/_${b.bin}`, `\nExample: ${b.bin} completion zsh > ~/.zfunc/_${b.bin}`))
    .action((shell: string) => void process.stdout.write(completionScript(shell)));
  program.command("__complete", { hidden: true }).argument("[words...]").allowUnknownOption(true).helpOption(false)
    .action((words: string[] = []) => void process.stdout.write(completions(program, words.length ? words : [""]).join("\n")));

  program.command("update").description(tr("nâng lên bản mới", "upgrade to the latest version"))
    .option("--channel <c>", "latest | next")
    .action(async (o: { channel?: "latest" | "next" }) => {
      const channel = o.channel ?? loadConfig().updateChannel ?? "latest";
      const latest = await latestVersion(channel).catch(() => undefined);
      if (latest && !isOlder(VERSION, latest)) return ok(tr(`Đang dùng bản mới nhất (${VERSION}).`, `Already up to date (${VERSION}).`));
      const how = installMethod();
      const cmds: Record<string, [string, string[]]> = {
        npm: ["npm", ["install", "-g", `${b.pkg}@${channel}`]],
        brew: ["brew", ["upgrade", b.bin]],
      };
      if (how === "standalone") {
        info(tr(`Tải bản mới: curl -fsSL ${context().endpoints.docs}/install.sh | sh`, `Get the new build: curl -fsSL ${context().endpoints.docs}/install.sh | sh`));
        return;
      }
      if (how === "dev") return info(tr("Bản chạy từ mã nguồn, cập nhật bằng git pull.", "Running from source, update with git pull."));
      const [cmd, args] = cmds[how]!;
      info(c.dim(`$ ${cmd} ${args.join(" ")}`));
      const r = spawnSync(cmd, args, { stdio: "inherit" });
      if (r.status === 0) ok(tr(`Đã nâng lên ${latest ?? channel}.`, `Updated to ${latest ?? channel}.`));
      else throw new CliError(tr("Nâng cấp không thành công.", "Update failed."), Exit.general);
    });

  program.command("init").description(tr(`tạo ${notesFileName()}: chỉ dẫn riêng cho thư mục này`, `create ${notesFileName()}: instructions for this folder`))
    .action(() => {
      const f = join(process.cwd(), notesFileName());
      if (existsSync(f)) throw new CliError(tr(`${notesFileName()} đã có.`, `${notesFileName()} already exists.`), Exit.usage);
      const p = getProfile(context().profile);
      writeFileSync(f, tr(
        `# Chỉ dẫn cho ${b.aiName}\n\n${b.aiName} đọc tệp này kèm mỗi câu hỏi khi bạn chạy \`${b.bin}\` trong thư mục này (tối đa 4 KB).\n\n## Bối cảnh\n- Workspace: ${p?.workspaceName ?? ""}\n- Dự án: …\n\n## Quy ước\n- Tiền tệ: VND, làm tròn nghìn.\n- "Khách VIP" = …\n\n## Đừng\n- …\n`,
        `# Instructions for ${b.aiName}\n\n${b.aiName} reads this file with every question when you run \`${b.bin}\` in this folder (max 4 KB).\n\n## Context\n- Workspace: ${p?.workspaceName ?? ""}\n- Project: …\n\n## Conventions\n- Currency: VND.\n\n## Don't\n- …\n`,
      ));
      ok(tr(`Đã tạo ${f}`, `Created ${f}`));
    });

}
