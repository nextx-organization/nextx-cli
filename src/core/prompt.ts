// Minimal prompts for subcommands (the REPL has its own Ink components). All prompts refuse to run
// without a TTY so scripts never hang waiting for input.
import { emitKeypressEvents } from "node:readline";
import { createInterface } from "node:readline/promises";
import { stdin, stderr } from "node:process";
import { CliError, Exit } from "./errors.js";
import { c } from "./output.js";
import { t, tr } from "./i18n.js";

export const hasTty = () => stdin.isTTY === true && stderr.isTTY === true;

function needTty(): void {
  if (!hasTty()) throw new CliError(tr("Cần terminal tương tác cho bước này.", "This step needs an interactive terminal."), Exit.usage);
}

export async function ask(question: string, signal?: AbortSignal): Promise<string> {
  needTty();
  const rl = createInterface({ input: stdin, output: stderr });
  try {
    return (await rl.question(question, signal ? { signal } : {})).trim();
  } finally {
    rl.close();
  }
}

/** [y/N] — anything but y/yes/có/c is no. Ctrl+C = no. */
export async function confirm(question: string): Promise<boolean> {
  needTty();
  try {
    const a = (await ask(`${question} ${c.bold("[y/N]")} `)).toLowerCase();
    return a === "y" || a === "yes" || a === "c" || a === "có" || a === "co";
  } catch {
    return false;
  }
}

/** Typed confirmation for large writes: the user must type `expected` exactly. */
export async function confirmTyped(question: string, expected: string): Promise<boolean> {
  needTty();
  const a = await ask(`${question} ${tr("Gõ", "Type")} ${c.bold(expected)} ${tr("để xác nhận, Enter để huỷ", "to confirm, Enter to cancel")} › `);
  return a === expected;
}

export interface Choice<T> {
  label: string;
  hint?: string;
  value: T;
}

/** Arrow-key single select. Returns undefined on Esc / Ctrl+C. */
export async function select<T>(title: string, choices: Choice<T>[], initial = 0): Promise<T | undefined> {
  needTty();
  if (choices.length === 0) return undefined;
  let i = Math.min(initial, choices.length - 1);
  const out = stderr;
  emitKeypressEvents(stdin);
  const wasRaw = stdin.isRaw;
  stdin.setRawMode(true);
  stdin.resume();
  const draw = (first: boolean) => {
    if (!first) out.write(`\u001b[${choices.length}A`);
    choices.forEach((ch, k) => {
      const mark = k === i ? c.cyan("❯ ") : "  ";
      const label = k === i ? c.cyan(ch.label) : ch.label;
      out.write(`\u001b[2K${mark}${label}${ch.hint ? "  " + c.dim(ch.hint) : ""}\n`);
    });
  };
  out.write(`${title}\n`);
  draw(true);
  return new Promise<T | undefined>((resolve) => {
    const done = (v: T | undefined) => {
      stdin.off("keypress", onKey);
      stdin.setRawMode(wasRaw);
      stdin.pause();
      resolve(v);
    };
    const onKey = (_: string, key: { name?: string; ctrl?: boolean }) => {
      if (key.ctrl && key.name === "c") return done(undefined);
      if (key.name === "escape") return done(undefined);
      if (key.name === "up" || key.name === "k") i = (i - 1 + choices.length) % choices.length;
      else if (key.name === "down" || key.name === "j") i = (i + 1) % choices.length;
      else if (key.name === "return") return done(choices[i]!.value);
      else return;
      draw(false);
    };
    stdin.on("keypress", onKey);
  });
}

/** Multi select with space; Enter accepts. */
export async function multiSelect<T>(title: string, choices: Choice<T>[]): Promise<T[] | undefined> {
  needTty();
  let i = 0;
  const on = new Set<number>();
  const out = stderr;
  emitKeypressEvents(stdin);
  const wasRaw = stdin.isRaw;
  stdin.setRawMode(true);
  stdin.resume();
  const draw = (first: boolean) => {
    if (!first) out.write(`\u001b[${choices.length + 1}A`);
    choices.forEach((ch, k) => {
      const box = on.has(k) ? c.green("◼") : "◻";
      const label = k === i ? c.cyan(ch.label) : ch.label;
      out.write(`\u001b[2K${k === i ? c.cyan("❯ ") : "  "}${box} ${label}${ch.hint ? "  " + c.dim(ch.hint) : ""}\n`);
    });
    out.write(`\u001b[2K${c.dim(tr("  Space chọn · Enter xong · Esc huỷ", "  Space toggle · Enter accept · Esc cancel"))}\n`);
  };
  out.write(`${title}\n`);
  draw(true);
  return new Promise((resolve) => {
    const done = (v: T[] | undefined) => {
      stdin.off("keypress", onKey);
      stdin.setRawMode(wasRaw);
      stdin.pause();
      resolve(v);
    };
    const onKey = (_: string, key: { name?: string; ctrl?: boolean }) => {
      if ((key.ctrl && key.name === "c") || key.name === "escape") return done(undefined);
      if (key.name === "up") i = (i - 1 + choices.length) % choices.length;
      else if (key.name === "down") i = (i + 1) % choices.length;
      else if (key.name === "space") on.has(i) ? on.delete(i) : on.add(i);
      else if (key.name === "return") return done([...on].sort().map((k) => choices[k]!.value));
      else return;
      draw(false);
    };
    stdin.on("keypress", onKey);
  });
}

export function interrupted(): CliError {
  return new CliError(t("interrupted"), Exit.interrupted);
}
