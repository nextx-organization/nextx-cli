// NextFarm services speak two JSON key styles: snake_case (iam, gis, iot, harvest, ai, report, hrm, connect, sales, einvoice)
// and camelCase (office, notification, operator, finance). The CLI works in camelCase like the NextFarm web app, so keys
// are converted on the wire for snake services only. Converting a camel service breaks writes silently: `task_id` does not
// bind to `TaskId`, the field takes its default and the server still answers 200.
import { brand } from "./brand.js";

const SNAKE_SERVICES = ["iam", "gis", "iot", "harvest", "ai", "report", "hrm", "connect", "sales", "einvoice", "webhook"];
const SNAKE_URL = new RegExp(`/v\\d+/(${SNAKE_SERVICES.join("|")})(/|$|\\?)`);
/** Snake services with camelCase routes: Excel import keyed by column titles, consent with [JsonPropertyName], billing forwarded to operator. */
const EXEMPT = [/\/v\d+\/gis\/import(\/|$|\?)/, /\/v\d+\/iam\/automation-rules(\/|$|\?)/, /\/v\d+\/iam\/billing(\/|$|\?)/];

export function snakeOnWire(url: string): boolean {
  return brand().platform === "nextfarm" && SNAKE_URL.test(url) && !EXEMPT.some((r) => r.test(url));
}

const toSnake = (k: string) => k.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/([A-Z])([A-Z][a-z])/g, "$1_$2").toLowerCase();
const toCamel = (k: string) => k.replace(/_([a-z0-9])/g, (_, ch: string) => ch.toUpperCase());

function convert(v: unknown, key: (k: string) => string): unknown {
  if (Array.isArray(v)) return v.map((x) => convert(x, key));
  if (v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype)
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [key(k), convert(x, key)]));
  return v;
}

export const snakeKeys = (v: unknown) => convert(v, toSnake);
export const camelKeys = (v: unknown) => convert(v, toCamel);
