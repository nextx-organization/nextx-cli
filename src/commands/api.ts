import type { Command } from "commander";
import { readFileSync } from "node:fs";
import { brand } from "../core/brand.js";
import { context } from "../core/context.js";
import { CliError, Exit } from "../core/errors.js";
import { tr } from "../core/i18n.js";
import { c, info, json } from "../core/output.js";
import { apiPath, request } from "../core/http.js";
import { confirm, hasTty } from "../core/prompt.js";
import { parseArgs } from "./tools.js";

/** `.items[0].name` style selection, enough for scripting without a jq dependency. */
export function select(value: unknown, path: string): unknown {
  const parts = path.replace(/^\./, "").match(/[^.[\]]+|\[\d+\]/g) ?? [];
  let v: unknown = value;
  for (const p of parts) {
    if (v === null || v === undefined) return undefined;
    if (p.startsWith("[")) v = (v as unknown[])[Number(p.slice(1, -1))];
    else if (Array.isArray(v)) v = v.map((x) => (x as Record<string, unknown>)?.[p]);
    else v = (v as Record<string, unknown>)[p];
  }
  return v;
}

interface Paged {
  items?: unknown[];
  pageNumber?: number;
  page?: number;
  totalPages?: number;
  hasNextPage?: boolean;
}

export function registerApi(program: Command): void {
  program
    .command("api <method> <path>")
    .description(tr(`gọi thẳng API (vd: api ${brand().apiExample})`, `call the API directly (e.g. api ${brand().apiExample})`))
    .option("-f, --raw-field <key=value>", tr("tham số dạng chuỗi: query với GET/DELETE, thân JSON với POST/PUT/PATCH (lặp được)", "string parameter: query for GET/DELETE, JSON body for POST/PUT/PATCH (repeatable)"), (v: string, p: string[] = []) => [...p, v])
    .option("-F, --field <key=value>", tr("như -f nhưng đoán kiểu: số, true/false, JSON", "like -f but typed: numbers, true/false, JSON"), (v: string, p: string[] = []) => [...p, v])
    .option("--input <file>", tr("thân request từ tệp JSON (- = stdin)", "request body from a JSON file (- = stdin)"))
    .option("-H, --header <K: V>", tr("thêm header (lặp được)", "extra header (repeatable)"), (v: string, p: string[] = []) => [...p, v])
    .option("--paginate", tr("đi hết các trang (kết quả dạng items/pageNumber)", "follow all pages (items/pageNumber results)"))
    .option("--select <path>", tr("chỉ in một phần, vd .items[0].name", "print only part of the result, e.g. .items[0].name"))
    .option("-i, --include", tr("in cả mã trạng thái và header", "print status and headers too"))
    .option("--idempotency-key <key>", tr("khoá chống trùng cho POST", "idempotency key for POST"))
    .action(async (methodRaw: string, path: string, o: { field?: string[]; rawField?: string[]; input?: string; header?: string[]; paginate?: boolean; select?: string; include?: boolean; idempotencyKey?: string }) => {
      const method = methodRaw.toUpperCase();
      if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) throw new CliError(tr(`Phương thức không hợp lệ: ${methodRaw}`, `Invalid method: ${methodRaw}`), Exit.usage);
      const fields = parseArgs({ raw: o.rawField, arg: o.field });
      const headers: Record<string, string> = {};
      for (const h of o.header ?? []) {
        const i = h.indexOf(":");
        if (i > 0) headers[h.slice(0, i).trim()] = h.slice(i + 1).trim();
      }
      const hasBody = method !== "GET" && method !== "DELETE";
      let body: unknown;
      if (o.input) body = JSON.parse(readFileSync(o.input === "-" ? 0 : o.input, "utf8"));
      if (hasBody && Object.keys(fields).length) body = { ...(body as object), ...fields };
      const query = hasBody ? undefined : (Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, typeof v === "object" ? JSON.stringify(v) : (v as string)])) as Record<string, string>);

      if (method !== "GET" && hasTty()) {
        const env = context().env === "prod" ? c.red("PROD") : c.yellow("SANDBOX");
        if (!(await confirm(`${method} ${apiPath(path)} · ${env}?`))) return;
      }

      const out: unknown[] = [];
      let page = Number(query?.pageNumber ?? query?.page ?? 1);
      for (;;) {
        const q = o.paginate ? { ...query, pageNumber: page } : query;
        const r = await request<unknown>(method, path, { query: q, body, headers, idempotencyKey: o.idempotencyKey, verbatim: true });
        if (o.include) {
          info(c.dim(`HTTP ${r.status}`));
          (r.headers as Headers).forEach?.((v, k) => info(c.dim(`${k}: ${v}`)));
        }
        const d = r.data as Paged;
        if (!o.paginate || !d || !Array.isArray(d.items)) {
          out.push(r.data);
          break;
        }
        out.push(...d.items);
        const more = d.hasNextPage ?? (d.totalPages !== undefined ? page < d.totalPages : d.items.length > 0);
        if (!more || d.items.length === 0) break;
        page++;
      }
      const value = o.paginate ? out : out[0];
      const shown = o.select ? select(value, o.select) : value;
      if (typeof shown === "string") info(shown);
      else if (shown !== undefined) json(shown);
    });
}
