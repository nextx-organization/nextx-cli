import { buildProgram } from "./program.js";
import { CliError, Exit, isCliError } from "./core/errors.js";
import { fail, isJson } from "./core/output.js";
import { maybeNotifyUpdate } from "./commands/util.js";
import { setLang } from "./core/i18n.js";
import { envVar } from "./core/brand.js";

export async function main(argv: string[]): Promise<void> {
  // Help text is built before flags are parsed, so honour --lang early.
  const li = argv.indexOf("--lang");
  const early = li > 0 ? argv[li + 1] : argv.find((a) => a.startsWith("--lang="))?.slice(7);
  if (early === "en" || early === "vi") setLang(early);
  const program = buildProgram();
  program.exitOverride();
  try {
    await program.parseAsync(argv);
    await maybeNotifyUpdate();
  } catch (e) {
    process.exitCode = report(e);
  }
}

function report(e: unknown): number {
  const err = e as { code?: string; exitCode?: number; message?: string };
  // commander: --help / --version / usage errors
  if (err?.code === "commander.helpDisplayed" || err?.code === "commander.version" || err?.code === "commander.help") return Exit.ok;
  if (typeof err?.code === "string" && err.code.startsWith("commander.")) return Exit.usage;
  const ce: CliError = isCliError(e) ? e : new CliError((e as Error)?.message ?? String(e), Exit.general);
  if (isJson()) process.stderr.write(`${JSON.stringify({ error: { message: ce.message, hint: ce.hint, exitCode: ce.exitCode, requestId: ce.requestId } })}\n`);
  else fail(ce.message + (ce.requestId && !ce.message.includes(ce.requestId) ? ` (${ce.requestId})` : ""), ce.hint);
  if (envVar("DEBUG") === "1" && !isCliError(e)) console.error(e);
  return ce.exitCode;
}
