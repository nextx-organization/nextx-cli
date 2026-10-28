// Every call to the platform goes through here: identity headers, retry on expired token, error → exit code.
import { randomUUID } from "node:crypto";
import { arch, platform } from "node:os";
import { fetch, FormData, EnvHttpProxyAgent, setGlobalDispatcher, type Response } from "undici";
import { brand } from "./brand.js";
import { context } from "./context.js";
import { CliError, Exit } from "./errors.js";
import { t, currentLang } from "./i18n.js";
import { VERSION } from "./version.js";
import { snakeOnWire, snakeKeys, camelKeys } from "./case.js";
import { currentAuth, refreshSession, type Auth } from "../auth/session.js";

setGlobalDispatcher(new EnvHttpProxyAgent());

export const userAgent = () => `${brand().bin}-cli/${VERSION} (${platform()}; ${arch()}; node ${process.versions.node})`;

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
  /** Send without credentials (public endpoints, login). */
  anonymous?: boolean;
  /** Use this bearer instead of the resolved identity (pre-auth token during login). */
  bearer?: string;
  idempotencyKey?: string | true;
  /** Return the raw response (streams, downloads) instead of parsed JSON. */
  raw?: boolean;
  /** Base URL other than the API gateway (auth server, docs). */
  baseUrl?: string;
  /** Do not throw on these statuses; caller inspects the response. */
  allow?: number[];
  signal?: AbortSignal;
  /** Send and return keys exactly as given (the raw `api` command). Otherwise NextFarm snake services are converted. */
  verbatim?: boolean;
}

export interface HttpResult<T> {
  status: number;
  data: T;
  headers: Headers | Record<string, string>;
  requestId?: string;
}

export function apiPath(path: string): string {
  if (/^https?:\/\//.test(path)) return path;
  const p = path.startsWith("/") ? path : `/${path}`;
  return p.startsWith("/api/") ? p : `/api/v1${p}`;
}

function buildUrl(path: string, opts: RequestOptions): string {
  const base = opts.baseUrl ?? context().endpoints.api;
  const url = new URL(/^https?:\/\//.test(path) ? path : base + (opts.baseUrl ? path : apiPath(path)));
  for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
  return url.toString();
}

function authHeaders(auth: Auth | undefined): Record<string, string> {
  if (!auth) return {};
  if (auth.kind === "apiKey") return { "X-Api-Key": auth.key };
  return { Authorization: `Bearer ${auth.token}` };
}

function debug(line: string): void {
  if (context().debug) process.stderr.write(`\u001b[2m[debug] ${line}\u001b[22m\n`);
}

async function send(method: string, url: string, opts: RequestOptions, auth: Auth | undefined): Promise<Response> {
  const headers: Record<string, string> = {
    "User-Agent": userAgent(),
    "X-Client-Type": "cli",
    "Accept-Language": currentLang(),
    Accept: "application/json, text/event-stream",
    ...(opts.bearer ? { Authorization: `Bearer ${opts.bearer}` } : opts.anonymous ? {} : authHeaders(auth)),
    ...opts.headers,
  };
  let body: string | FormData | undefined;
  if (opts.body !== undefined) {
    // Multipart: undici sets the boundary itself, so no Content-Type here.
    if (opts.body instanceof FormData || typeof opts.body === "string") body = opts.body;
    else {
      body = JSON.stringify(!opts.verbatim && snakeOnWire(url) ? snakeKeys(opts.body) : opts.body);
      headers["Content-Type"] ??= "application/json";
    }
  }
  if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey === true ? randomUUID() : opts.idempotencyKey;
  const started = Date.now();
  try {
    const res = await fetch(url, { method, headers, body, signal: opts.signal });
    debug(`${method} ${url.replace(/([?&](token|key)=)[^&]+/gi, "$1…")} → ${res.status} ${Date.now() - started}ms rid=${res.headers.get("x-request-id") ?? "-"}`);
    return res;
  } catch (e) {
    throw networkError(e, url);
  }
}

export function networkError(e: unknown, url: string): CliError {
  if ((e as Error)?.name === "AbortError") return new CliError(t("interrupted"), Exit.interrupted);
  const cause = (e as { cause?: { code?: string } })?.cause?.code ?? (e as { code?: string })?.code ?? "";
  if (/CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(cause)) return new CliError(t("net.tls"), Exit.network, t("net.tls.hint"));
  return new CliError(t("net.failed", { host: new URL(url).host }) + (cause ? ` (${cause})` : ""), Exit.network, t("net.failed.hint"));
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Human message from ProblemDetails / {code,message} / plain text bodies. */
export function serverMessage(body: unknown): { code?: string; message?: string } {
  if (!body || typeof body !== "object") return { message: typeof body === "string" ? body.slice(0, 300) : undefined };
  const b = body as Record<string, unknown>;
  // ProblemDetails: errors is either a list of messages or { field: [messages] }.
  const errors = Array.isArray(b.errors)
    ? (b.errors as unknown[]).map(String).join("; ")
    : b.errors && typeof b.errors === "object"
      ? Object.entries(b.errors as Record<string, unknown>).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : String(v)}`).join("; ")
      : undefined;
  const code = (b.code ?? b.errorCode ?? b.error ?? b.type) as string | undefined;
  const generic = typeof b.title === "string" && /validation errors occurred/i.test(b.title);
  const message = (b.message ?? b.detail ?? b.error_description ?? (generic && errors ? errors : (b.title ?? errors))) as string | undefined;
  return { code: typeof code === "string" ? code : undefined, message: typeof message === "string" ? message : undefined };
}

export function errorFor(status: number, body: unknown, res: { headers: { get(n: string): string | null } }): CliError {
  const { code, message } = serverMessage(body);
  const rid = (res.headers.get("x-request-id") ?? res.headers.get("x-correlation-id") ?? (body as { traceId?: string })?.traceId ?? undefined)?.split(",")[0]?.trim();
  const minVersion = res.headers.get("x-min-cli-version");
  if (status === 426 || (minVersion && isOlder(VERSION, minVersion)))
    return new CliError(t("http.tooOld", { cur: VERSION, min: minVersion ?? "?" }), Exit.general, t("http.tooOld.hint"));
  if (status === 401) {
    if (code && /revoked|blacklist/i.test(code)) return new CliError(t("auth.revoked"), Exit.auth, t("auth.expired.hint"));
    return new CliError(message ?? t("auth.expired"), Exit.auth, t("auth.expired.hint"));
  }
  if (status === 403) return new CliError(message ?? t("http.forbidden"), Exit.forbidden, undefined, rid);
  if (status === 404) return new CliError(message ?? t("http.notFound"), Exit.notFound, undefined, rid);
  if (status === 429) {
    const sec = Number(res.headers.get("retry-after") ?? (body as { retryAfterSeconds?: number })?.retryAfterSeconds ?? 0);
    return new CliError(message ?? t("http.rateLimited", { sec }), Exit.quota, undefined, rid);
  }
  if (status >= 500) return new CliError(t("http.server", { rid: rid ?? "-" }), Exit.general, t("http.server.hint"), rid);
  return new CliError(message ?? `HTTP ${status}${code ? ` ${code}` : ""}`, status === 409 || status === 410 ? Exit.notConfirmed : Exit.general, undefined, rid);
}

export function isOlder(a: string, b: string): boolean {
  const pa = a.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = b.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0);
  return false;
}

/** Raw response with the shared identity + one refresh-and-retry on 401. */
export async function requestRaw(method: string, path: string, opts: RequestOptions = {}): Promise<Response> {
  const url = buildUrl(path, opts);
  const auth = opts.anonymous || opts.bearer ? undefined : await currentAuth();
  let res = await send(method, url, opts, auth);
  if (res.status === 401 && auth?.kind === "session") {
    await res.body?.cancel();
    const fresh = await refreshSession(auth.token);
    res = await send(method, url, opts, fresh);
  }
  return res;
}

export async function request<T = unknown>(method: string, path: string, opts: RequestOptions = {}): Promise<HttpResult<T>> {
  let res = await requestRaw(method, path, opts);
  // Short rate limits are waited out once; long ones surface to the user.
  if (res.status === 429 && !opts.allow?.includes(429)) {
    const sec = Number(res.headers.get("retry-after") ?? 0);
    if (sec > 0 && sec <= 30) {
      await res.body?.cancel();
      process.stderr.write(`${t("http.rateLimited", { sec })}\n`);
      await new Promise((r) => setTimeout(r, sec * 1000));
      res = await requestRaw(method, path, opts);
    }
  }
  const requestId = res.headers.get("x-request-id") ?? undefined;
  if (opts.raw) return { status: res.status, data: res as unknown as T, headers: res.headers as unknown as Headers, requestId };
  const body = await readBody(res);
  const data = !opts.verbatim && snakeOnWire(res.url || path) ? camelKeys(body) : body;
  if (!res.ok && !opts.allow?.includes(res.status)) throw errorFor(res.status, data, res);
  return { status: res.status, data: data as T, headers: res.headers as unknown as Headers, requestId };
}

export const get = <T>(path: string, opts?: RequestOptions) => request<T>("GET", path, opts).then((r) => r.data);
export const post = <T>(path: string, body?: unknown, opts?: RequestOptions) => request<T>("POST", path, { ...opts, body }).then((r) => r.data);
export const put = <T>(path: string, body?: unknown, opts?: RequestOptions) => request<T>("PUT", path, { ...opts, body }).then((r) => r.data);
export const patch = <T>(path: string, body?: unknown, opts?: RequestOptions) => request<T>("PATCH", path, { ...opts, body }).then((r) => r.data);
export const del = <T>(path: string, opts?: RequestOptions) => request<T>("DELETE", path, opts).then((r) => r.data);
