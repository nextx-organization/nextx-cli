import { Option, type Command } from "commander";
import { readFileSync } from "node:fs";
import { context } from "../core/context.js";
import { brand, envVar } from "../core/brand.js";
import { CliError, Exit } from "../core/errors.js";
import { currentLang, tr } from "../core/i18n.js";
import { c, emit, info, json, ok, table } from "../core/output.js";
import { get, post } from "../core/http.js";
import { hasTty } from "../core/prompt.js";
import { McpClient, resultValue, type McpTool } from "../mcp/client.js";
import { authorizeMcp, readGrant, revokeGrant } from "../auth/mcp-oauth.js";
import { browserAvailable } from "./auth.js";

export interface PublicTool {
  name: string;
  module: string;
  title?: string;
  summary?: string;
  summaryEn?: string;
  scope?: string;
  kind?: "read" | "write" | "export" | string;
  parameters?: { type?: string; properties?: Record<string, { type?: string; description?: string; enum?: string[]; "x-description-en"?: string }>; required?: string[] };
  exampleArgs?: Record<string, unknown>;
}

let publicCache: PublicTool[] | undefined;

export async function publicTools(): Promise<PublicTool[]> {
  publicCache ??= (brand().platform === "nextfarm" ? await nextFarmPublicTools() : await get<PublicTool[]>("/ai/public/tools", { anonymous: true }))
    .filter((t) => !brand().modules || brand().modules!.includes(t.module));
  return publicCache;
}

/** NextFarm: `{ version, tools: [{ name, service, scope, title, title_en, summary, summary_en, parameters, example_args }] }`, read verbatim so schema property names stay as the tool expects them. */
async function nextFarmPublicTools(): Promise<PublicTool[]> {
  type Raw = { name: string; service: string; scope?: string; title?: string; summary?: string; summary_en?: string; parameters?: PublicTool["parameters"]; example_args?: Record<string, unknown> };
  const r = await get<{ tools: Raw[] }>("/ai/public/tools", { anonymous: true, verbatim: true });
  return r.tools.map((t) => ({
    name: t.name, module: t.service, title: t.title, summary: t.summary, summaryEn: t.summary_en, scope: t.scope,
    kind: t.scope?.endsWith(":write") ? "write" : "read", parameters: t.parameters, exampleArgs: t.example_args,
  }));
}

/** MCP names may differ from catalog names (module prefix, dots); match loosely. */
export function sameTool(a: string, b: string): boolean {
  const n = (s: string) => s.toLowerCase().replace(/[.\-]/g, "_");
  return n(a) === n(b) || n(a).endsWith(`_${n(b)}`) || n(b).endsWith(`_${n(a)}`);
}

/** `raw` keeps every value a string (api -f); otherwise numbers/booleans/JSON are inferred, but never for values with a leading zero (phone numbers, codes). */
export function parseArgs(o: { args?: string; argsFile?: string; arg?: string[]; raw?: string[] }): Record<string, unknown> {
  let base: Record<string, unknown> = {};
  try {
    if (o.argsFile) base = JSON.parse(readFileSync(o.argsFile === "-" ? 0 : o.argsFile, "utf8")) as Record<string, unknown>;
    if (o.args) base = { ...base, ...(JSON.parse(o.args) as Record<string, unknown>) };
  } catch (e) {
    throw new CliError(tr(`Tham số không phải JSON hợp lệ: ${(e as Error).message}`, `Arguments are not valid JSON: ${(e as Error).message}`), Exit.usage);
  }
  for (const kv of o.raw ?? []) {
    const i = kv.indexOf("=");
    if (i < 1) throw new CliError(tr(`-f cần dạng khoá=giá_trị: ${kv}`, `-f needs key=value: ${kv}`), Exit.usage);
    base[kv.slice(0, i)] = kv.slice(i + 1);
  }
  for (const kv of o.arg ?? []) {
    const i = kv.indexOf("=");
    if (i < 1) throw new CliError(tr(`-a cần dạng khoá=giá_trị: ${kv}`, `-a needs key=value: ${kv}`), Exit.usage);
    const k = kv.slice(0, i);
    const raw = kv.slice(i + 1);
    let v: unknown = raw;
    if (/^-?(0|[1-9]\d*)(\.\d+)?$/.test(raw) && raw.length < 16) v = Number(raw);
    else if (raw === "true" || raw === "false") v = raw === "true";
    else if (/^[[{]/.test(raw)) {
      try {
        v = JSON.parse(raw);
      } catch {
        // keep as string
      }
    }
    base[k] = v;
  }
  return base;
}

const summaryOf = (t?: PublicTool) => (t ? (currentLang() === "en" ? t.summaryEn ?? t.summary : t.summary) ?? "" : "");

function mergeList(mcp: McpTool[], pub: PublicTool[]) {
  return mcp.map((m) => {
    const p = pub.find((x) => sameTool(x.name, m.name));
    return {
      name: m.name,
      module: p?.module ?? m.name.split(/[_.]/)[0] ?? "",
      title: p?.title ?? m.title ?? m.annotations?.title ?? m.name,
      kind: p?.kind ?? (m.annotations?.readOnlyHint ? "read" : "proposal"),
      summary: summaryOf(p) || (m.description ?? "").split("\n")[0]!,
    };
  });
}

export function registerTools(program: Command): void {
  const tools = program.command("tools").description(tr("công cụ AI bạn được dùng (theo quyền thật)", "AI tools you can use (by your real permissions)"));

  tools.command("login")
    .description(tr("cấp quyền công cụ AI cho CLI trên máy này (một lần)", "grant AI tool access to the CLI on this machine (once)"))
    .option("--no-browser", tr("không tự mở trình duyệt", "do not open the browser"))
    .action(async (o: { browser?: boolean }) => {
      const g = await authorizeMcp({ openBrowser: o.browser !== false && browserAvailable(), manual: o.browser === false || !browserAvailable() });
      emit({ scope: g.scope.split(" ") }, () => ok(tr(`Đã cấp quyền: ${g.scope}`, `Granted: ${g.scope}`)));
    });
  tools.command("logout").description(tr("thu hồi quyền công cụ AI của CLI", "revoke the CLI's AI tool access"))
    .action(async () => {
      await revokeGrant();
      ok(tr("Đã thu hồi.", "Revoked."));
    });

  tools.command("list", { isDefault: true })
    .description(tr("danh sách công cụ", "list tools"))
    .option("--module <m>", tr("lọc theo phân hệ (crm, sales, gym…)", "filter by module (crm, sales, gym…)"))
    .addOption(new Option("--kind <k>", tr("lọc theo loại", "filter by kind")).choices(["read", "proposal", "export"]))
    .option("--public", tr("danh mục công khai (không cần đăng nhập)", "public catalog (no login)"))
    .action(async (o: { module?: string; kind?: string; public?: boolean }) => {
      const pub = await publicTools();
      let rows: { name: string; module: string; title: string; kind: string; summary: string }[];
      if (o.public || envVar("API_KEY")) {
        rows = pub.map((p) => ({ name: p.name, module: p.module, title: p.title ?? p.name, kind: p.kind ?? "", summary: summaryOf(p) }));
        if (envVar("API_KEY")) rows = rows.filter((r) => r.kind === "read");
      } else {
        const mcp = await new McpClient(hasTty()).listTools();
        rows = mergeList(mcp, pub);
      }
      if (o.module) rows = rows.filter((r) => r.module === o.module);
      if (o.kind) rows = rows.filter((r) => r.kind === o.kind);
      emit(rows, () => {
        info(table([tr("Công cụ", "Tool"), tr("Phân hệ", "Module"), tr("Loại", "Kind"), tr("Mô tả", "Summary")], rows.map((r) => [r.name, r.module, r.kind === "read" ? r.kind : c.yellow(r.kind), r.summary.slice(0, 70)])));
        info(c.dim(`  ${rows.length} ${tr("công cụ", "tools")} · ${brand().bin} tools describe <${tr("tên", "name")}>`));
      });
    });

  tools.command("describe <name>")
    .description(tr("tham số và ví dụ của một công cụ", "parameters and an example for a tool"))
    .action(async (name: string) => {
      const pub = (await publicTools()).find((p) => sameTool(p.name, name));
      let schema = pub?.parameters as Record<string, unknown> | undefined;
      if (!pub && !envVar("API_KEY") && readGrant()) {
        const m = (await new McpClient(false).listTools()).find((t) => sameTool(t.name, name));
        schema = m?.inputSchema;
        if (!m) throw new CliError(tr("Không thấy công cụ này.", "Tool not found."), Exit.notFound);
      } else if (!pub) throw new CliError(tr("Không thấy công cụ này.", "Tool not found."), Exit.notFound);
      emit({ ...pub, parameters: schema }, () => {
        info(`${c.bold(pub?.title ?? name)} ${c.dim(`${pub?.module ?? ""} · ${pub?.kind ?? ""} · ${pub?.scope ?? ""}`)}`);
        if (pub) info(summaryOf(pub));
        const props = (schema?.properties ?? {}) as Record<string, { type?: string; description?: string; enum?: string[]; "x-description-en"?: string }>;
        const req = new Set((schema?.required as string[] | undefined) ?? []);
        if (Object.keys(props).length) {
          info();
          info(table([tr("Tham số", "Param"), tr("Kiểu", "Type"), "", tr("Mô tả", "Description")], Object.entries(props).map(([k, v]) => [
            k, v.enum ? v.enum.join("|") : (v.type ?? ""), req.has(k) ? tr("bắt buộc", "required") : "", (currentLang() === "en" ? v["x-description-en"] ?? v.description : v.description) ?? "",
          ])));
        }
        const ex = pub?.exampleArgs ?? Object.fromEntries([...req].map((k) => [k, `<${k}>`]));
        info();
        info(c.dim(`  ${brand().bin} tools call ${name} --args '${JSON.stringify(ex)}'`));
      });
    });

  tools.command("call <name>")
    .description(tr("gọi một công cụ. Công cụ ghi chỉ tạo đề xuất để xác nhận", "call a tool. Write tools only create a proposal to confirm"))
    .option("--args <json>", tr("tham số JSON", "JSON arguments"))
    .option("--args-file <file>", tr("tham số từ tệp JSON (- = stdin)", "arguments from a JSON file (- = stdin)"))
    .option("-a, --arg <key=value>", tr("một tham số (lặp được)", "one argument (repeatable)"), (v: string, p: string[] = []) => [...p, v])
    .action(async (name: string, o: { args?: string; argsFile?: string; arg?: string[] }) => {
      const args = parseArgs(o);
      let value: unknown;
      if (envVar("API_KEY") && brand().platform === "nextfarm") {
        // NextFarm has no REST door for tools: the API key speaks MCP through the gateway, which keeps its read-only route rules.
        const client = new McpClient(false, envVar("API_KEY"), `${context().endpoints.api}/api/v1/mcp`);
        const tool = (await client.listTools()).find((t) => sameTool(t.name, name));
        if (!tool) throw new CliError(tr("Khoá này không thấy công cụ đó (thiếu phạm vi?).", "This key cannot see that tool (missing scope?)."), Exit.notFound, `${brand().bin} tools list`);
        const r = await client.callTool(tool.name, args);
        value = resultValue(r);
        if (r.isError) {
          emit({ error: value }, () => info(c.red(typeof value === "string" ? value : JSON.stringify(value, null, 2))));
          process.exitCode = Exit.general;
          return;
        }
      } else if (envVar("API_KEY")) {
        const pub = (await publicTools()).find((p) => sameTool(p.name, name));
        if (!pub) throw new CliError(tr("Không thấy công cụ công khai này.", "Public tool not found."), Exit.notFound);
        if (pub.kind !== "read") throw new CliError(tr("Khoá API chỉ gọi được công cụ đọc.", "API keys can only call read tools."), Exit.forbidden);
        value = await post(`/ai/tools/${pub.module}/${pub.name}/read`, args);
      } else {
        const client = new McpClient(hasTty());
        const tool = (await client.listTools()).find((t) => sameTool(t.name, name));
        if (!tool) throw new CliError(tr("Không thấy công cụ này trong quyền của bạn.", "This tool is not in your permissions."), Exit.notFound, `${brand().bin} tools list`);
        const props = Object.keys((tool.inputSchema?.properties as object | undefined) ?? {});
        const wrapped = props.length === 1 && props[0] === "args" && !("args" in args) ? { args } : args;
        const r = await client.callTool(tool.name, wrapped);
        value = resultValue(r);
        if (r.isError) {
          emit({ error: value }, () => info(c.red(typeof value === "string" ? value : JSON.stringify(value, null, 2))));
          process.exitCode = Exit.general;
          return;
        }
      }
      const text = typeof value === "string" ? value : "";
      const proposal = /xác nhận|confirm/i.test(text) && /https?:\/\//.test(text);
      if (proposal) process.exitCode = Exit.notConfirmed;
      if (typeof value === "string") emit({ result: value }, () => info(value as string));
      else json(value);
    });

}
