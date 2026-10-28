import type { Command, Option } from "commander";
import { brand } from "../core/brand.js";
import { tr } from "../core/i18n.js";
import { json } from "../core/output.js";
import { VERSION } from "../core/version.js";
import { Exit } from "../core/errors.js";
import { SHORTCUTS, slashCommands } from "../repl/slash.js";

interface CmdDoc {
  name: string;
  aliases: string[];
  usage: string;
  description: string;
  arguments: { name: string; required: boolean; variadic: boolean; description: string }[];
  options: { flags: string; description: string; default?: unknown; choices?: string[] }[];
  commands: CmdDoc[];
}

const opt = (o: Option) => ({ flags: o.flags, description: o.description, ...(o.defaultValue !== undefined ? { default: o.defaultValue } : {}), ...(o.argChoices ? { choices: o.argChoices } : {}) });

function walk(cmd: Command): CmdDoc {
  return {
    name: cmd.name(),
    aliases: cmd.aliases(),
    usage: cmd.usage(),
    description: cmd.description(),
    arguments: cmd.registeredArguments.map((a) => ({ name: a.name(), required: a.required, variadic: a.variadic, description: a.description })),
    options: cmd.options.filter((o) => !o.hidden).map(opt),
    commands: cmd.commands.filter((c) => !(c as unknown as { _hidden?: boolean })._hidden && !c.name().startsWith("__")).map(walk),
  };
}

/** Machine-readable command tree; the developer portal renders /docs/cli from this. */
export function helpTree(program: Command) {
  const b = brand();
  return {
    bin: b.bin,
    package: b.pkg,
    version: VERSION,
    brand: b.id,
    root: walk(program),
    slashCommands: slashCommands().map((s) => ({ name: `/${s.name}`, args: s.args ?? null, description: s.description() })),
    shortcuts: SHORTCUTS.map((s) => ({ keys: s.keys, description: s.description() })),
    exitCodes: Object.entries(Exit).map(([name, code]) => ({ name, code })),
    environment: ["API_KEY", "TOKEN", "PROFILE", "ENV", "WORKSPACE", "LANG", "DEBUG", "NO_UPDATE_CHECK", "NO_KEYCHAIN", "ID_TOKEN"].map((v) => `${b.envPrefix}_${v}`),
  };
}

export function registerHelp(program: Command): void {
  program
    .command("help [command...]")
    .description(tr("trợ giúp (--json: toàn bộ cây lệnh cho máy đọc)", "help (--json: full command tree, machine readable)"))
    .option("--json", tr("in cây lệnh dạng JSON", "print the command tree as JSON"))
    .action((path: string[] = [], o: { json?: boolean }) => {
      if (o.json || program.opts().json) return json(helpTree(program));
      let cmd: Command = program;
      for (const p of path) cmd = cmd.commands.find((c) => c.name() === p || c.aliases().includes(p)) ?? cmd;
      cmd.outputHelp();
    });
  program.addHelpCommand(false);
}
