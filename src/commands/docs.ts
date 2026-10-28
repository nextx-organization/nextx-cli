import type { Command } from "commander";
import { writeFileSync } from "node:fs";
import { context } from "../core/context.js";
import { tr } from "../core/i18n.js";
import { c, info, json, ok } from "../core/output.js";
import { get } from "../core/http.js";

const TOPICS: Record<string, string> = {
  cli: "/docs/cli",
  quickstart: "/docs/quickstart",
  "api-keys": "/docs/api-keys",
  oauth: "/docs/oauth",
  mcp: "/docs/mcp",
  "ai-tools": "/docs/ai-tools",
  webhooks: "/docs/webhooks",
  sdk: "/docs/sdk",
  errors: "/docs/errors",
  "rate-limit": "/docs/rate-limit",
  sandbox: "/docs/sandbox",
  changelog: "/docs/changelog",
  versioning: "/docs/versioning",
  security: "/docs/security",
};

export function registerDocs(program: Command): void {
  program
    .command("openapi")
    .description(tr("tải đặc tả OpenAPI công khai", "download the public OpenAPI spec"))
    .command("pull")
    .option("--module <m>", tr("chỉ một phân hệ", "one module only"))
    .option("-o, --out <file>", "", "openapi.json")
    .action(async (o: { module?: string; out: string }) => {
      const spec = await get<Record<string, unknown>>(`${context().endpoints.docs}/openapi.json`, { anonymous: true, baseUrl: "", query: { module: o.module } });
      writeFileSync(o.out, JSON.stringify(spec, null, 2));
      const paths = Object.keys((spec.paths as object) ?? {}).length;
      ok(tr(`Đã lưu ${o.out} · ${paths} đường`, `Saved ${o.out} · ${paths} paths`));
    });

  program
    .command("docs [topic]")
    .description(tr(`mở tài liệu (${Object.keys(TOPICS).join(", ")})`, `open the docs (${Object.keys(TOPICS).join(", ")})`))
    .action(async (topic?: string) => {
      const url = `${context().endpoints.docs}${topic ? TOPICS[topic] ?? `/docs/${topic}` : "/docs"}`;
      info(c.dim(url));
      const open = (await import("open")).default;
      await open(url).catch(() => undefined);
    });

  program
    .command("changelog")
    .description(tr("thay đổi API gần đây", "recent API changes"))
    .action(async () => {
      const spec = await get<{ info?: { version?: string; "x-changelog"?: unknown } }>(`${context().endpoints.docs}/openapi.json`, { anonymous: true, baseUrl: "" });
      const log = spec.info?.["x-changelog"];
      if (log) json(log);
      else info(`${tr("Phiên bản API", "API version")} ${spec.info?.version ?? "?"} · ${context().endpoints.docs}/docs/changelog`);
    });
}
