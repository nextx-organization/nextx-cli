import type { Command } from "commander";
import { brand } from "../core/brand.js";
import { CliError, Exit } from "../core/errors.js";
import { tr } from "../core/i18n.js";
import { c, emit, info, ok, table } from "../core/output.js";
import { hasTty } from "../core/prompt.js";
import { PROVIDERS, addModel, defaultModel, isProvider, listModels, removeModel, resolveModel, setDefaultModel } from "../ai/models.js";

async function readAll(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const ch of process.stdin) chunks.push(ch as Buffer);
  return Buffer.concat(chunks).toString("utf8").trim();
}

/** Reads a key from the terminal without echoing it. */
async function readHidden(question: string): Promise<string> {
  process.stderr.write(question);
  const stdin = process.stdin;
  stdin.setRawMode?.(true);
  stdin.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const onData = (d: Buffer) => {
      for (const ch of d.toString("utf8")) {
        if (ch === "\r" || ch === "\n") {
          done();
          return resolve(value.trim());
        }
        if (ch === "\u0003") {
          done();
          return reject(new CliError(tr("Đã huỷ.", "Cancelled."), Exit.interrupted));
        }
        if (ch === "\u007f") value = value.slice(0, -1);
        else value += ch;
      }
    };
    const done = () => {
      stdin.off("data", onData);
      stdin.setRawMode?.(false);
      stdin.pause();
      process.stderr.write("\n");
    };
    stdin.on("data", onData);
  });
}

export function registerModel(program: Command): void {
  const b = brand();
  const model = program
    .command("model")
    .description(tr(`model của bạn cho --model (khoá lưu keychain, không gửi về ${b.name})`, `your own models for --model (keys stay in the keychain, never sent to ${b.name})`));

  model
    .command("list")
    .description(tr("các model đã thêm", "models you added"))
    .action(() => {
      const rows = listModels();
      const def = defaultModel();
      emit(
        { default: def ?? b.bin, models: rows.map((r) => ({ name: r.name, provider: r.entry.provider, model: r.entry.model ?? PROVIDERS[r.entry.provider].defaultModel ?? null, url: r.entry.url ?? null, hasKey: r.hasKey })) },
        () => {
          info(table(
            [tr("Tên", "Name"), tr("Nhà", "Provider"), "Model", tr("Khoá", "Key"), ""],
            [
              [b.bin, b.name, b.aiName, "—", def ? "" : c.green(tr("mặc định", "default"))],
              ...rows.map((r) => [r.name, PROVIDERS[r.entry.provider].label, r.entry.model ?? PROVIDERS[r.entry.provider].defaultModel ?? c.dim(tr("(nêu khi dùng)", "(name it when used)")), PROVIDERS[r.entry.provider].needsKey ? (r.hasKey ? c.green("✓") : c.yellow(tr("chưa có", "missing"))) : "—", r.isDefault ? c.green(tr("mặc định", "default")) : ""]),
            ],
          ));
          if (!rows.length) info(c.dim(`\n  ${b.bin} model add claude --key-from-stdin < key.txt  ·  ${b.bin} model add ollama --url http://localhost:11434 --name qwen3:32b`));
        },
      );
    });

  model
    .command("add <provider>")
    .description(tr(`thêm nhà model: ${Object.keys(PROVIDERS).join(", ")}`, `add a provider: ${Object.keys(PROVIDERS).join(", ")}`))
    .option("--key-from-stdin", tr("đọc khoá API từ stdin (không bao giờ đưa khoá lên dòng lệnh)", "read the API key from stdin (never put keys on the command line)"))
    .option("--name <model>", tr("model dùng khi chỉ ghi tên nhà, vd gpt → --name <tên model>", "model used when only the provider is given"))
    .option("--url <url>", tr("địa chỉ máy chủ (Ollama hoặc cổng tương thích)", "server address (Ollama or a compatible endpoint)"))
    .action(async (provider: string, o: { keyFromStdin?: boolean; name?: string; url?: string }) => {
      if (!isProvider(provider)) throw new CliError(tr(`Không biết nhà "${provider}".`, `Unknown provider "${provider}".`), Exit.usage, Object.keys(PROVIDERS).join(", "));
      const info0 = PROVIDERS[provider];
      let key: string | undefined;
      if (info0.needsKey) {
        if (o.keyFromStdin) key = await readAll();
        else if (hasTty()) key = await readHidden(tr(`Khoá API ${info0.label}: `, `${info0.label} API key: `));
        else throw new CliError(tr("Không có terminal: dùng --key-from-stdin.", "No terminal: use --key-from-stdin."), Exit.usage);
        if (!key) throw new CliError(tr("Khoá rỗng.", "Empty key."), Exit.usage);
      }
      addModel(provider, { key, model: o.name, url: o.url });
      ok(tr(`Đã thêm ${info0.label}. Dùng: ${b.bin} --model ${provider}${o.name || info0.defaultModel ? "" : "/<model>"}`, `Added ${info0.label}. Use: ${b.bin} --model ${provider}${o.name || info0.defaultModel ? "" : "/<model>"}`));
    });

  model
    .command("remove <name>")
    .description(tr("gỡ model và xoá khoá khỏi keychain", "remove a model and delete its key"))
    .action((name: string) => {
      if (!removeModel(name)) throw new CliError(tr(`Chưa có model "${name}".`, `No model "${name}".`), Exit.notFound);
      ok(tr(`Đã gỡ ${name}.`, `Removed ${name}.`));
    });

  model
    .command("default <name>")
    .description(tr(`model mặc định khi mở chat (${b.bin} = ${b.aiName})`, `model used by default (${b.bin} = ${b.aiName})`))
    .action((name: string) => {
      const m = resolveModel(name);
      setDefaultModel(m ? name : undefined);
      ok(tr(`Mặc định: ${m ? m.label : b.aiName}`, `Default: ${m ? m.label : b.aiName}`));
    });
}
