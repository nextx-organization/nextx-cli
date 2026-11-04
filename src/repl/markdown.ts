// Small Markdown → ANSI renderer for answers: headings, bold, italics, inline code, lists, tables, links.
import { c, table } from "../core/output.js";

function inline(s: string): string {
  return s
    .replace(/`([^`]+)`/g, (_, x: string) => c.cyan(x))
    .replace(/\*\*([^*]+)\*\*/g, (_, x: string) => c.bold(x))
    .replace(/(^|[^*])\*([^*\n]+)\*/g, (_, p: string, x: string) => p + c.dim(x))
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, (_, t: string, u: string) => `${t} ${c.dim(u)}`);
}

function isTableRow(l: string): boolean {
  return /^\s*\|.*\|\s*$/.test(l);
}

export function markdown(src: string): string {
  const lines = src.replace(/\r/g, "").split("\n");
  const out: string[] = [];
  let inCode = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (/^```/.test(l)) {
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      out.push(c.cyan(`  ${l}`));
      continue;
    }
    if (isTableRow(l) && isTableRow(lines[i + 1] ?? "") && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1]!)) {
      const cells = (row: string) => row.trim().replace(/^\||\|$/g, "").split("|").map((x) => inline(x.trim()));
      const head = cells(l);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && isTableRow(lines[i]!)) rows.push(cells(lines[i++]!));
      i--;
      const numeric = head.map((_, k) => rows.length > 0 && rows.every((r) => /^[\d.,\s₫%+-]*$/.test((r[k] ?? "").replace(/\u001b\[[0-9;]*m/g, ""))));
      out.push(table(head, rows, numeric.map((n) => (n ? "r" : "l"))).replace(/^/gm, "  "));
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(l);
    if (h) {
      out.push(c.bold(inline(h[2]!)));
      continue;
    }
    const li = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(l);
    if (li) {
      const bullet = /\d/.test(li[2]!) ? li[2]! : "•";
      out.push(`${li[1]}${bullet} ${inline(li[3]!)}`);
      continue;
    }
    if (/^\s*>\s?/.test(l)) {
      out.push(c.dim(`│ ${inline(l.replace(/^\s*>\s?/, ""))}`));
      continue;
    }
    out.push(inline(l));
  }
  return out.join("\n");
}

/**
 * Renders a streamed answer as it arrives. Text is held until a blank line outside a code fence closes the block, so
 * bold markers and tables split across tokens still render whole.
 */
export function markdownStream(write: (text: string) => void): { push(text: string): void; end(): void } {
  let buf = "";
  const flush = (block: string) => {
    if (block.trim()) write(`${markdown(block)}\n\n`);
  };
  return {
    push(text) {
      buf += text.replace(/\r/g, "");
      for (;;) {
        let fence = false;
        let at = -1;
        let pos = 0;
        for (const line of buf.split("\n").slice(0, -1)) {
          if (/^```/.test(line)) fence = !fence;
          else if (!fence && line.trim() === "" && pos > 0) {
            at = pos;
            break;
          }
          pos += line.length + 1;
        }
        if (at < 0) return;
        flush(buf.slice(0, at));
        buf = buf.slice(at + 1);
      }
    },
    end() {
      flush(buf);
      buf = "";
    },
  };
}
