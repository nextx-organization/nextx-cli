// Plain (non-Ink) output for subcommands. Colors follow NO_COLOR / --no-color / non-TTY.
import { stdout, stderr } from "node:process";

let colorOn = stdout.isTTY === true && !process.env.NO_COLOR;
let quiet = false;
let format: OutputFormat = "text";

export type OutputFormat = "text" | "json" | "stream-json";

export function setOutput(opts: { color?: boolean; quiet?: boolean; format?: OutputFormat }): void {
  if (opts.color === false) colorOn = false;
  if (opts.quiet !== undefined) quiet = opts.quiet;
  if (opts.format) format = opts.format;
}

export const outputFormat = () => format;
export const isJson = () => format !== "text";

const wrap = (open: number, close: number) => (s: string) => (colorOn ? `\u001b[${open}m${s}\u001b[${close}m` : s);
export const c = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  cyan: wrap(36, 39),
};

export function info(line = ""): void {
  if (!quiet && !isJson()) stdout.write(`${line}\n`);
}

export function ok(line: string): void {
  if (!quiet && !isJson()) stdout.write(`${c.green("✓")} ${line}\n`);
}

export function warn(line: string): void {
  stderr.write(`${c.yellow("⚠")} ${line}\n`);
}

export function fail(line: string, hint?: string): void {
  stderr.write(`${c.red("✗")} ${line}\n`);
  if (hint) stderr.write(`  ${c.dim(hint)}\n`);
}

/** Drops null/undefined fields so JSON output stays readable; arrays keep their length. */
export function compact<T>(v: T): T {
  if (Array.isArray(v)) return v.map(compact) as T;
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== null && x !== undefined).map(([k, x]) => [k, compact(x)])) as T;
  return v;
}

export function json(value: unknown): void {
  stdout.write(`${JSON.stringify(compact(value), null, format === "json" ? 2 : 0)}\n`);
}

/** Prints `value` as JSON in json mode, otherwise calls `text`. */
export function emit(value: unknown, text: () => void): void {
  if (isJson()) json(value);
  else text();
}

const width = (s: string) => [...s.replace(/\u001b\[[0-9;]*m/g, "")].length;

/** Simple aligned table with box borders, used for list commands. */
export function table(headers: string[], rows: (string | number | null | undefined)[][], align: ("l" | "r")[] = []): string {
  const cells = rows.map((r) => r.map((v) => (v === null || v === undefined ? "" : String(v))));
  const w = headers.map((h, i) => Math.max(width(h), ...cells.map((r) => width(r[i] ?? ""))));
  const pad = (s: string, i: number) => {
    const n = (w[i] ?? 0) - width(s);
    return align[i] === "r" ? " ".repeat(n) + s : s + " ".repeat(n);
  };
  const line = (l: string, m: string, r: string) => l + w.map((n) => "─".repeat(n + 2)).join(m) + r;
  const row = (r: string[]) => "│" + r.map((s, i) => ` ${pad(s, i)} `).join("│") + "│";
  return [line("┌", "┬", "┐"), row(headers.map((h) => c.bold(h))), line("├", "┼", "┤"), ...cells.map(row), line("└", "┴", "┘")].join("\n");
}

export function money(n: number): string {
  return new Intl.NumberFormat("vi-VN").format(n);
}
