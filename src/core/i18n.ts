// User-facing strings. Vietnamese first; English for --lang en / LANG=en_*.
import { brand, envVar } from "./brand.js";
import { loadConfig, type Lang } from "./config.js";

let lang: Lang | undefined;

export function setLang(l: Lang | undefined): void {
  lang = l;
}

export function currentLang(): Lang {
  if (lang) return lang;
  const fromEnv = envVar("LANG");
  if (fromEnv === "en" || fromEnv === "vi") return fromEnv;
  try {
    const c = loadConfig().lang;
    if (c) return c;
  } catch {
    // unreadable config falls back to the system locale
  }
  const sys = process.env.LC_ALL ?? process.env.LC_MESSAGES ?? process.env.LANG ?? "";
  return sys.toLowerCase().startsWith("en") ? "en" : "vi";
}

type Dict = Record<string, string>;

const vi: Dict = {
  "auth.notLoggedIn": "Chưa đăng nhập.",
  "auth.notLoggedIn.hint": "Chạy `{bin} login` (hoặc đặt {prefix}_API_KEY cho CI).",
  "auth.expired": "Phiên trên máy này đã hết.",
  "auth.expired.hint": "Đăng nhập lại: `{bin} login`",
  "auth.revoked": "Phiên trên máy này đã bị đăng xuất (từ web hoặc quản trị).",
  "auth.clock": "Đồng hồ máy lệch {min} phút so với máy chủ, token bị coi là sai.",
  "auth.clock.hint": "Bật đồng bộ giờ rồi thử lại (`{bin} doctor`).",
  "auth.apiKeyNoChat": "Khoá API không dùng được chế độ chat AI (đó là danh tính agent, không phải người).",
  "auth.apiKeyNoChat.hint": "Dùng `{bin} tools call …`, hoặc `{bin} login --ci` trong CI.",
  "net.failed": "Không kết nối được tới {host}.",
  "net.failed.hint": "Kiểm mạng, proxy (HTTPS_PROXY) hoặc chạy `{bin} doctor`.",
  "net.tls": "Không tin được chứng chỉ của máy chủ (có thể do proxy công ty).",
  "net.tls.hint": "Đặt NODE_EXTRA_CA_CERTS=<tệp CA> hoặc HTTPS_PROXY=…",
  "http.forbidden": "Không đủ quyền.",
  "http.notFound": "Không tìm thấy.",
  "http.rateLimited": "Hỏi nhanh quá, thử lại sau {sec} giây.",
  "http.server": "{name} đang lỗi (mã yêu cầu {rid}).",
  "http.server.hint": "Thử lại sau, hoặc `/support` kèm mã này.",
  "http.tooOld": "Bản {cur} đã cũ, máy chủ cần ≥ {min}.",
  "http.tooOld.hint": "Chạy `{bin} update`.",
  "ws.gone": "Bạn không còn ở workspace này, hoặc workspace đang tạm khoá.",
  "ws.gone.hint": "`{bin} workspace list`",
  "ws.none": "Tài khoản chưa có công ty nào.",
  "ws.none.hint": "Tạo tại {app} rồi chạy lại `{bin} login`.",
  "keychain.fallback": "Không có Keychain. Token lưu tại {file} (chỉ bạn đọc được).",
  "interrupted": "Đã huỷ.",
};

const en: Dict = {
  "auth.notLoggedIn": "Not logged in.",
  "auth.notLoggedIn.hint": "Run `{bin} login` (or set {prefix}_API_KEY in CI).",
  "auth.expired": "Your session on this machine has expired.",
  "auth.expired.hint": "Log in again: `{bin} login`",
  "auth.revoked": "This machine was signed out (from the web or by an admin).",
  "auth.clock": "Your clock is {min} minutes off from the server, so tokens look invalid.",
  "auth.clock.hint": "Turn on automatic time sync and retry (`{bin} doctor`).",
  "auth.apiKeyNoChat": "API keys cannot use AI chat (an API key is an agent identity, not a person).",
  "auth.apiKeyNoChat.hint": "Use `{bin} tools call …`, or `{bin} login --ci` in CI.",
  "net.failed": "Cannot reach {host}.",
  "net.failed.hint": "Check your network, proxy (HTTPS_PROXY) or run `{bin} doctor`.",
  "net.tls": "The server certificate is not trusted (often a corporate proxy).",
  "net.tls.hint": "Set NODE_EXTRA_CA_CERTS=<ca file> or HTTPS_PROXY=…",
  "http.forbidden": "Permission denied.",
  "http.notFound": "Not found.",
  "http.rateLimited": "Too many requests, retry in {sec} seconds.",
  "http.server": "{name} returned an error (request id {rid}).",
  "http.server.hint": "Try again later, or `/support` with this id.",
  "http.tooOld": "Version {cur} is too old, the server needs ≥ {min}.",
  "http.tooOld.hint": "Run `{bin} update`.",
  "ws.gone": "You are no longer in this workspace, or it is suspended.",
  "ws.gone.hint": "`{bin} workspace list`",
  "ws.none": "Your account has no company yet.",
  "ws.none.hint": "Create one at {app}, then run `{bin} login` again.",
  "keychain.fallback": "No system keychain. Tokens are stored in {file} (readable only by you).",
  "interrupted": "Cancelled.",
};

export function t(key: string, vars: Record<string, string | number> = {}): string {
  const dict = currentLang() === "en" ? en : vi;
  const b = brand();
  const all: Record<string, string | number> = { bin: b.bin, prefix: b.envPrefix, name: b.name, ...vars };
  return (dict[key] ?? vi[key] ?? key).replace(/\{(\w+)\}/g, (_, k: string) => String(all[k] ?? `{${k}}`));
}

/** Inline bilingual helper for one-off strings: tr(vietnamese, english). */
export function tr(viText: string, enText: string): string {
  return currentLang() === "en" ? enText : viText;
}
