import type { Command } from "commander";
import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { fetch } from "undici";
import { brand } from "../core/brand.js";
import { context } from "../core/context.js";
import { CliError, Exit } from "../core/errors.js";
import { currentLang, tr } from "../core/i18n.js";
import { c, emit, info, json, ok, table, warn } from "../core/output.js";
import { get, post, del, requestRaw, errorFor } from "../core/http.js";
import { confirm, hasTty } from "../core/prompt.js";

interface EventType {
  event: string;
  service: string;
  title: string;
  description?: string;
  descriptionEn?: string;
  planRequired?: string;
  payloadSchema?: unknown;
  example?: unknown;
}

interface Endpoint {
  id: string;
  url: string;
  description?: string | null;
  events: string[];
  isActive: boolean;
  status: string;
  consecutiveFailures: number;
  service?: string | null;
  createdAt: string;
}

interface Delivery {
  id: string;
  eventType: string;
  payload?: unknown;
  responseStatus?: number | null;
  responseBody?: string | null;
  status: string;
  retryCount: number;
  maxRetries: number;
  durationMs?: number | null;
  deliveredAt?: string | null;
  createdAt: string;
}

const when = (iso?: string | null) => (iso ? iso.slice(0, 19).replace("T", " ") : "");

/** Platforms whose webhook contract differs (event list shape, endpoints with many events, per-endpoint deliveries, test call). */
let farm = (): boolean => false;

/** Signature headers per platform: `…-Signature-256` by default (sha256=HMAC(ts.body)). */
function sigHeader(): string {
  return "x-nextx-signature-256";
}
function tsHeader(): string {
  return "x-nextx-timestamp";
}
function sigScheme(): string {
  return "Signature-256";
}

export async function eventTypes(): Promise<EventType[]> {
  return get<EventType[]>("/webhook/public/event-types", { anonymous: true });
}


/** Some platforms send `eventTypes` per endpoint and no single module. */
async function listEndpoints(): Promise<Endpoint[]> {
  const list = await get<(Endpoint & { eventTypes?: string[] })[]>("/webhook/endpoints");
  return farm() ? list.map((e) => ({ ...e, events: e.eventTypes ?? [], status: e.isActive ? "active" : "disabled" })) : list;
}

/** Some platforms keep deliveries per endpoint only; the CLI merges them. */
async function listDeliveries(o: { endpoint?: string; status?: string; limit: number }): Promise<Delivery[]> {
  if (!farm()) {
    const path = o.endpoint ? `/webhook/endpoints/${(await findEndpoint(o.endpoint)).id}/deliveries` : "/webhook/deliveries";
    const r = await get<Delivery[] | { items: Delivery[] }>(path, { query: { status: o.status, pageSize: o.limit } });
    return Array.isArray(r) ? r : r.items;
  }
  const eps = o.endpoint ? [await findEndpoint(o.endpoint)] : await listEndpoints();
  type FarmDelivery = { id: string; eventType: string; status: string; attemptCount: number; lastStatusCode?: number | null; lastDurationMs?: number | null; deliveredAt?: string | null; createdAt: string };
  const all = (await Promise.all(eps.map((e) => get<FarmDelivery[]>(`/webhook/endpoints/${e.id}/deliveries`, { query: { limit: o.limit } })))).flat();
  return all
    .map((d) => ({ id: d.id, eventType: d.eventType, status: d.status === "delivered" ? "success" : d.status, responseStatus: d.lastStatusCode, durationMs: d.lastDurationMs, retryCount: d.attemptCount, maxRetries: 8, deliveredAt: d.deliveredAt, createdAt: d.createdAt }))
    .filter((d) => !o.status || d.status === o.status)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, o.limit);
}

/** Checks both the NextX header (sha256=HMAC(ts.body)) and Standard Webhooks (v1,base64 HMAC(id.ts.body)). */
export function verifySignature(secret: string, body: string, headers: Record<string, string>, toleranceSec = 300): { ok: boolean; scheme?: string; reason?: string } {
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const eq = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
  const ts = h[tsHeader()] ?? h["webhook-timestamp"];
  if (ts && Math.abs(Date.now() / 1000 - Number(ts)) > toleranceSec) return { ok: false, reason: tr("dấu thời gian quá cũ", "timestamp too old") };
  if (h[sigHeader()] && ts) {
    const expected = "sha256=" + createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
    const got = [h[sigHeader()], h[`${sigHeader()}-previous`]].filter(Boolean) as string[];
    if (got.some((g) => eq(g, expected))) return { ok: true, scheme: sigScheme() };
  }
  if (h["webhook-signature"] && h["webhook-id"] && ts) {
    const key = secret.startsWith("whsec_") ? Buffer.from(secret.slice(6), "base64") : Buffer.from(secret);
    const expected = createHmac("sha256", key).update(`${h["webhook-id"]}.${ts}.${body}`).digest("base64");
    if (h["webhook-signature"].split(" ").some((s) => eq(s.replace(/^v1,/, ""), expected))) return { ok: true, scheme: "webhook-signature" };
  }
  return { ok: false, reason: tr("chữ ký không khớp", "signature mismatch") };
}

async function findEndpoint(id: string): Promise<Endpoint> {
  const e = (await listEndpoints()).find((x) => x.id.startsWith(id) || x.url === id);
  if (!e) throw new CliError(tr("Không thấy endpoint này.", "Endpoint not found."), Exit.notFound);
  return e;
}

export function registerWebhooks(program: Command): void {
  const wh = program.command("webhooks").alias("webhook").description(tr("sự kiện webhook: xem, bắn thử, nghe về máy", "webhook events: browse, trigger, listen locally"));

  wh.command("events").description(tr("danh sách sự kiện", "list events")).option("--module <m>")
    .action(async (o: { module?: string }) => {
      let list = await eventTypes();
      if (o.module) list = list.filter((e) => e.service.toLowerCase() === o.module!.toLowerCase());
      emit(list, () => info(table([tr("Sự kiện", "Event"), tr("Phân hệ", "Module"), tr("Mô tả", "Description"), farm() ? tr("Quyền", "Permission") : tr("Gói", "Plan")], list.map((e) => [e.event, e.service, (currentLang() === "en" ? e.descriptionEn ?? e.title : e.title), e.planRequired ?? ""]))));
    });

  wh.command("schema <event>").description(tr("schema và ví dụ payload", "payload schema and example"))
    .action(async (event: string) => {
      const e = (await eventTypes()).find((x) => x.event === event);
      if (!e) throw new CliError(tr("Không có sự kiện này.", "No such event."), Exit.notFound, `${brand().bin} webhooks events`);
      emit(e, () => {
        info(`${c.bold(e.event)} — ${e.title}`);
        if (e.description) info(currentLang() === "en" ? e.descriptionEn ?? e.description : e.description);
        info(c.dim(tr("\nVí dụ:", "\nExample:")));
        json(e.example);
      });
    });

  const ep = wh.command("endpoints").description(tr("endpoint nhận webhook của workspace", "your webhook endpoints"));
  ep.command("list", { isDefault: true }).action(async () => {
    const list = await listEndpoints();
    emit(list, () => info(table(["ID", "URL", tr("Sự kiện", "Events"), tr("Trạng thái", "Status"), tr("Lỗi liên tiếp", "Failures")], list.map((e) => [e.id.slice(0, 8), e.url, e.events.length > 3 ? `${e.events.slice(0, 3).join(", ")} +${e.events.length - 3}` : e.events.join(", "), e.isActive ? c.green(e.status) : c.dim(e.status), e.consecutiveFailures || ""]))));
  });
  ep.command("create <url>")
    .requiredOption("--events <list>", tr("sự kiện, phẩy ngăn cách", "events, comma separated"))
    .option("--description <text>")
    .action(async (url: string, o: { events: string; description?: string }) => {
      const events = o.events.split(",").map((s) => s.trim()).filter(Boolean);
      if (farm()) {
        const known = new Set((await eventTypes()).map((t) => t.event));
        const unknown = events.filter((e) => !known.has(e));
        if (unknown.length) throw new CliError(tr(`Không có sự kiện: ${unknown.join(", ")}`, `Unknown events: ${unknown.join(", ")}`), Exit.usage, `${brand().bin} webhooks events`);
        const r = await post<Record<string, unknown>>("/webhook/endpoints", { url, description: o.description, eventTypes: events });
        emit(r, () => {
          ok(tr("Đã tạo endpoint.", "Endpoint created."));
          if (r.secret) info(`  ${tr("Khoá ký", "Signing secret")}: ${c.bold(String(r.secret))} ${c.dim(tr("(chỉ hiện một lần)", "(shown once)"))}`);
        });
        return;
      }
      const types = await eventTypes();
      const services = [...new Set(events.map((e) => types.find((t) => t.event === e)?.service).filter(Boolean))];
      if (services.length !== 1) throw new CliError(tr("Mỗi endpoint nhận sự kiện của MỘT phân hệ.", "Each endpoint receives events of ONE module."), Exit.usage);
      const r = await post<Record<string, unknown>>("/webhook/endpoints", { url, description: o.description, events, service: services[0] });
      emit(r, () => {
        ok(tr("Đã tạo endpoint.", "Endpoint created."));
        if (r.secret) info(`  ${tr("Khoá ký", "Signing secret")}: ${c.bold(String(r.secret))} ${c.dim(tr("(chỉ hiện một lần)", "(shown once)"))}`);
      });
    });
  ep.command("delete <id>").action(async (id: string) => {
    const e = await findEndpoint(id);
    if (hasTty() && !(await confirm(tr(`Xoá endpoint ${e.url}?`, `Delete endpoint ${e.url}?`)))) return;
    await del(`/webhook/endpoints/${e.id}`);
    ok(tr("Đã xoá.", "Deleted."));
  });
  ep.command("rotate-secret <id>").description(tr("đổi khoá ký (khoá cũ còn hiệu lực một thời gian)", "rotate the signing secret (old one stays valid for a while)"))
    .action(async (id: string) => {
      const e = await findEndpoint(id);
      const r = await post<Record<string, unknown>>(`/webhook/endpoints/${e.id}/rotate-secret`, {});
      emit(r, () => ok(`${tr("Khoá ký mới", "New secret")}: ${c.bold(String(r.secret ?? ""))}`));
    });

  wh.command("trigger <event>").description(tr("bắn một sự kiện mẫu tới endpoint", "send a sample event to an endpoint"))
    .option("--endpoint <id>", tr("endpoint đích (mặc định: endpoint đầu tiên nhận sự kiện này)", "target endpoint (default: first one subscribed)"))
    .action(async (event: string, o: { endpoint?: string }) => {
      const list = await listEndpoints();
      const target = o.endpoint ? await findEndpoint(o.endpoint) : list.find((e) => e.events.includes(event));
      if (!target) throw new CliError(tr("Chưa có endpoint nào nhận sự kiện này.", "No endpoint subscribes to this event."), Exit.notFound, tr(`Dùng \`${brand().bin} webhooks listen --events ${event}\` để nghe về máy.`, `Use \`${brand().bin} webhooks listen --events ${event}\` to receive it locally.`));
      if (farm()) {
        // This platform sends a signed `webhook.test` and answers with the receiver's status straight away.
        const t = await post<{ ok: boolean; statusCode?: number | null; error?: string | null; durationMs: number }>(`/webhook/endpoints/${target.id}/test`, {});
        emit(t, () => (t.ok ? ok : warn)(tr(`Đã gửi webhook.test → ${target.url}`, `Sent webhook.test → ${target.url}`) + ` · ${t.statusCode ? `HTTP ${t.statusCode}` : t.error ?? ""} · ${t.durationMs}ms`));
        if (!t.ok) process.exitCode = Exit.general;
        return;
      }
      const r = await post<Record<string, unknown>>(`/webhook/endpoints/${target.id}/test`, { eventType: event });
      emit(r, () => ok(tr(`Đã gửi ${event} → ${target.url}`, `Sent ${event} → ${target.url}`) + (r.responseStatus ? ` · HTTP ${r.responseStatus}` : "")));
    });

  wh.command("deliveries").description(tr("lượt giao gần đây", "recent deliveries"))
    .option("--status <s>", "success | failed | pending")
    .option("--endpoint <id>")
    .option("--limit <n>", "", "30")
    .action(async (o: { status?: string; endpoint?: string; limit: string }) => {
      const list = await listDeliveries({ endpoint: o.endpoint, status: o.status, limit: Number(o.limit) });
      emit(list, () => info(table(["ID", tr("Sự kiện", "Event"), tr("Kết quả", "Result"), "HTTP", "ms", tr("Thử lại", "Retries"), tr("Lúc", "At")], list.map((d) => [
        d.id.slice(0, 8), d.eventType, d.status === "success" ? c.green(d.status) : d.status === "failed" ? c.red(d.status) : d.status, d.responseStatus ?? "", d.durationMs ?? "", `${d.retryCount}/${d.maxRetries}`, when(d.createdAt),
      ]))));
    });

  wh.command("retry <deliveryId>").description(tr("gửi lại một lượt giao", "retry a delivery")).action(async (id: string) => {
    const full = id.length >= 32 ? id : (await listDeliveries({ limit: 100 })).find((d) => d.id.startsWith(id))?.id;
    if (!full) throw new CliError(tr("Không thấy lượt giao này.", "Delivery not found."), Exit.notFound);
    const r = await post(`/webhook/deliveries/${full}/retry`, {});
    emit(r, () => ok(tr("Đã xếp gửi lại.", "Retry queued.")));
  });

  wh.command("verify").description(tr("kiểm chữ ký webhook tại máy (không gọi máy chủ)", "verify a webhook signature locally (no server call)"))
    .requiredOption("--secret <secret>")
    .requiredOption("--payload <file>", tr("thân thô đã nhận (- = stdin)", "raw received body (- = stdin)"))
    .option("-H, --header <K: V>", tr("header đã nhận (lặp được)", "received header (repeatable)"), (v: string, p: string[] = []) => [...p, v])
    .option("--signature <sig>", tr("chữ ký trong header *-Signature-256", "signature from the *-Signature-256 header"))
    .option("--timestamp <ts>", tr("dấu thời gian trong header *-Timestamp", "timestamp from the *-Timestamp header"))
    .action((o: { secret: string; payload: string; header?: string[]; signature?: string; timestamp?: string }) => {
      const body = readFileSync(o.payload === "-" ? 0 : o.payload, "utf8");
      const headers: Record<string, string> = {};
      for (const h of o.header ?? []) {
        const i = h.indexOf(":");
        if (i > 0) headers[h.slice(0, i).trim()] = h.slice(i + 1).trim();
      }
      if (o.signature) headers[sigHeader()] = o.signature;
      if (o.timestamp) headers[tsHeader()] = o.timestamp;
      const r = verifySignature(o.secret, body, headers);
      emit(r, () => (r.ok ? ok(tr(`Chữ ký hợp lệ (${r.scheme})`, `Valid signature (${r.scheme})`)) : warn(tr(`Không hợp lệ: ${r.reason}`, `Invalid: ${r.reason}`))));
      if (!r.ok) process.exitCode = Exit.general;
    });

  wh.command("listen")
    .description(tr("nhận sự kiện thật về máy và chuyển tới địa chỉ local", "receive real events on this machine and forward them locally"))
    .option("--forward-to <url>", tr("vd localhost:3000/hook", "e.g. localhost:3000/hook"))
    .option("--events <list>", tr("sự kiện, phẩy ngăn cách (mặc định: tất cả)", "events, comma separated (default: all)"))
    .option("--print-secret", tr("in đủ khoá ký", "print the full signing secret"))
    .option("--print-json", tr("in thân sự kiện", "print event bodies"))
    .action(async (o: { forwardTo?: string; events?: string; printSecret?: boolean; printJson?: boolean }) => listen(o));
}

/**
 * Dev listen protocol (webhook service, permission webhook.endpoints.manage):
 *   GET /api/v1/webhook/dev-listen?events=a,b   (SSE)
 *       data: {"type":"ready","listenerId","secret","idleTimeoutSec","events"}
 *       data: {"type":"delivery","deliveryId","eventType","headers":{…},"body":"<raw>"}
 *       ": ping" comments every 15 s
 * Best effort: no delivery records, no retries. The listener expires idleTimeoutSec after the stream closes.
 */
async function listen(o: { forwardTo?: string; events?: string; printSecret?: boolean; printJson?: boolean }): Promise<void> {
  const target = o.forwardTo ? (/^https?:\/\//.test(o.forwardTo) ? o.forwardTo : `http://${o.forwardTo}`) : undefined;
  if (target && !["localhost", "127.0.0.1", "[::1]"].includes(new URL(target).hostname))
    throw new CliError(tr("--forward-to chỉ nhận địa chỉ trên máy này (localhost).", "--forward-to only accepts local addresses (localhost)."), Exit.usage);
  if (context().env === "prod") warn(c.red(tr("PROD: dữ liệu thật của khách sẽ chảy về máy này.", "PROD: real customer data will flow to this machine.")));
  const stop = new AbortController();
  process.once("SIGINT", () => stop.abort());
  let backoff = 1000;
  while (!stop.signal.aborted) {
    let res;
    try {
      res = await requestRaw("GET", "/webhook/dev-listen", { query: { events: o.events }, signal: stop.signal, headers: { Accept: "text/event-stream" } });
    } catch (e) {
      if (stop.signal.aborted) break;
      warn(tr(`Mất kết nối, thử lại sau ${backoff / 1000}s…`, `Disconnected, retrying in ${backoff / 1000}s…`));
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 30_000);
      void e;
      continue;
    }
    if (res.status === 404) throw new CliError(tr("Máy chủ chưa hỗ trợ nghe webhook về máy.", "The server does not support local webhook listening yet."), Exit.general);
    if (!res.ok) throw errorFor(res.status, await res.json().catch(() => undefined), res);
    backoff = 1000;
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for await (const part of res.body!) {
        buf += decoder.decode(part as Uint8Array, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const data = frame.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
          if (!data) continue;
          const msg = JSON.parse(data) as { type: string; listenerId?: string; secret?: string; deliveryId?: string; eventType?: string; headers?: Record<string, string>; body?: string };
          if (msg.type === "ready") {
            const sec = msg.secret ?? "";
            ok(tr(`Đang nghe trên ${c.bold(context().env)} · khoá ký ${c.yellow(o.printSecret ? sec : `${sec.slice(0, 6)}…${sec.slice(-3)}`)}`, `Listening on ${c.bold(context().env)} · signing secret ${c.yellow(o.printSecret ? sec : `${sec.slice(0, 6)}…${sec.slice(-3)}`)}`));
            info(c.dim(tr("  Ctrl+C dừng · sự kiện thật của workspace, đã ký như lượt giao thật", "  Ctrl+C to stop · real workspace events, signed like real deliveries")));
            continue;
          }
          if (msg.type !== "delivery") continue;
          const at = new Date().toTimeString().slice(0, 8);
          if (o.printJson) info(msg.body ?? "");
          if (!target) {
            info(`  ${at}  ${(msg.eventType ?? "").padEnd(22)} ${c.dim(msg.deliveryId?.slice(0, 12) ?? "")}`);
            if (o.printJson) continue;
            continue;
          }
          const started = Date.now();
          let status = 0;
          let respBody = "";
          try {
            const r = await fetch(target, { method: "POST", headers: { "Content-Type": "application/json", ...msg.headers }, body: msg.body });
            status = r.status;
            respBody = (await r.text()).slice(0, 2000);
          } catch (e) {
            respBody = String((e as Error).message);
          }
          const ms = Date.now() - started;
          const code = status ? (status < 300 ? c.green(String(status)) : c.red(String(status))) : c.red(tr("lỗi", "error"));
          info(`  ${at}  ${(msg.eventType ?? "").padEnd(22)} → ${code} ${String(ms).padStart(4)}ms  ${c.dim(msg.deliveryId?.slice(0, 12) ?? "")}`);
          if (status >= 300 && respBody) info(c.dim(`      ${respBody.slice(0, 200).replace(/\s+/g, " ")}`));
        }
      }
    } catch (e) {
      if (stop.signal.aborted) break;
      void e;
    }
  }
}
