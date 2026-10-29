import { Command, Option } from "commander";
import { brand } from "./core/brand.js";
import { initContext, type GlobalFlags } from "./core/context.js";
import { setOutput, type OutputFormat } from "./core/output.js";
import { setLang } from "./core/i18n.js";
import { VERSION } from "./core/version.js";
import { tr } from "./core/i18n.js";
import { registerAuth } from "./commands/auth.js";
import { registerWorkspace } from "./commands/workspace.js";
import { registerAi, runRoot } from "./commands/ai.js";
import { registerModel } from "./commands/model.js";
import { registerTools } from "./commands/tools.js";
import { registerApi } from "./commands/api.js";
import { registerKeys } from "./commands/keys.js";
import { registerWebhooks } from "./commands/webhooks.js";
import { registerDocs } from "./commands/docs.js";
import { registerMcp } from "./commands/mcp.js";
import { registerUtil } from "./commands/util.js";
import { registerHelp } from "./commands/help.js";
import { registerCi } from "./commands/ci.js";

export interface RootFlags extends GlobalFlags {
  print?: string | boolean;
  continue?: boolean;
  resume?: string | boolean;
  file?: string[];
  outputFormat?: OutputFormat;
  json?: boolean;
  lang?: "vi" | "en";
  color?: boolean;
  quiet?: boolean;
  model?: string;
}

const collect = (v: string, prev: string[] = []) => [...prev, v];

export function buildProgram(): Command {
  const b = brand();
  const program = new Command(b.bin)
    .description(tr(`${b.aiName} và công cụ nhà phát triển trong terminal`, `${b.aiName} and developer tools in your terminal`))
    .version(VERSION, "-v, --version", tr("in phiên bản", "print the version"))
    .helpOption("-h, --help", tr("trợ giúp", "show help"))
    .argument("[question...]", tr("câu hỏi gửi ngay khi mở chat", "question to send when chat opens"))
    .option("-p, --print [question]", tr("không tương tác: in câu trả lời rồi thoát (đọc thêm từ stdin)", "non-interactive: print the answer and exit (reads stdin too)"))
    .option("-c, --continue", tr("nối hội thoại gần nhất", "continue the last conversation"))
    .option("-r, --resume [id]", tr("mở lại hội thoại cũ (không id = chọn trong danh sách)", "resume a conversation (no id = pick from a list)"))
    .option("-f, --file <path>", tr("đính kèm tệp Excel/CSV, ảnh hoặc tệp chữ (lặp được, tối đa 3)", "attach an Excel/CSV, image or text file (repeatable, max 3)"), collect)
    .addOption(new Option("--profile <name>", tr("hồ sơ đăng nhập", "login profile")))
    .option("--sandbox", tr("dùng sandbox", "use the sandbox environment"))
    .option("-w, --workspace <code>", tr("chạy lệnh này trên workspace khác", "run this command on another workspace"))
    .option("--agent <code>", tr("chọn Agent thay cho Trợ lý chung", "choose an Agent instead of the general assistant"))
    .option("--model <provider/name>", tr("dùng model của bạn qua MCP: claude, gemini, gpt, grok, ollama/<name>", "use your own model over MCP: claude, gemini, gpt, grok, ollama/<name>"))
    .addOption(new Option("--mode <mode>", tr("permission mode", "permission mode")).choices(["read", "propose", "auto"]))
    .addOption(new Option("--output-format <format>", tr("output format", "output format")).choices(["text", "json", "stream-json"]))
    .option("--json", tr("viết tắt của --output-format json", "shorthand for --output-format json"))
    .addOption(new Option("--lang <lang>", tr("ngôn ngữ", "language")).choices(["vi", "en"]))
    .option("--no-color", tr("tắt màu", "disable colors"))
    .option("--quiet", tr("chỉ in kết quả", "print results only"))
    .option("--verbose", tr("in chi tiết", "verbose output"))
    .option("--debug", tr("in request-id và thời gian từng cửa (không in token)", "print request ids and timings (never tokens)"))
    .enablePositionalOptions()
    .showSuggestionAfterError(true)
    .configureHelp({ sortSubcommands: false, showGlobalOptions: true });

  program.hook("preAction", (_this, action) => {
    // Global flags work before or after the subcommand: `nextx --sandbox login` and `nextx login --sandbox`.
    const o = { ...program.opts<RootFlags>(), ...pickGlobals(action.opts()) } as RootFlags;
    setLang(o.lang);
    setOutput({ color: o.color, quiet: o.quiet, format: o.json ? "json" : o.outputFormat });
    initContext(o);
  });

  program.action(async (question: string[]) => runRoot(program.opts<RootFlags>(), question));

  registerAuth(program);
  registerWorkspace(program);
  registerAi(program);
  registerModel(program);
  registerTools(program);
  registerApi(program);
  registerKeys(program);
  registerWebhooks(program);
  registerDocs(program);
  registerMcp(program);
  registerCi(program);
  registerUtil(program);
  registerHelp(program);
  for (const sub of program.commands) addGlobals(sub);
  return program;
}

/** Flags every subcommand accepts too (hidden in its help; listed once under the root). `-f` stays root-only: `api -f` means a field. */
const GLOBALS: [string, string, string[]?][] = [
  ["--profile <name>", "profile"],
  ["--sandbox", "sandbox"],
  ["-w, --workspace <code>", "workspace"],
  ["--agent <code>", "agent"],
  ["--mode <mode>", "mode", ["read", "propose", "auto"]],
  ["--output-format <format>", "outputFormat", ["text", "json", "stream-json"]],
  ["--json", "json"],
  ["--lang <lang>", "lang", ["vi", "en"]],
  ["--no-color", "color"],
  ["--quiet", "quiet"],
  ["--verbose", "verbose"],
  ["--debug", "debug"],
];

function addGlobals(cmd: Command): void {
  for (const [flags, , choices] of GLOBALS) {
    const o = new Option(flags).hideHelp();
    if (choices) o.choices(choices);
    const taken = cmd.options.some((x) => x.long === o.long || (o.short && x.short === o.short));
    if (!taken) cmd.addOption(o);
  }
  for (const sub of cmd.commands) addGlobals(sub);
}

function pickGlobals(o: Record<string, unknown>): Partial<RootFlags> {
  const out: Record<string, unknown> = {};
  for (const [, key] of GLOBALS) if (o[key] !== undefined && !(key === "color" && o[key] === true)) out[key] = o[key];
  return out as Partial<RootFlags>;
}
