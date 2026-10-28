// Authorization-code + PKCE over a loopback redirect (RFC 8252). Shared by browser login and MCP consent.
// Over SSH the browser runs elsewhere and cannot reach 127.0.0.1 here; the user pastes the address the
// browser stopped on (it carries the code) and we read the code from it.
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { brand } from "../core/brand.js";
import { CliError, Exit } from "../core/errors.js";
import { tr } from "../core/i18n.js";
import { c, info } from "../core/output.js";
import { ask, hasTty } from "../core/prompt.js";

export interface Pkce {
  verifier: string;
  challenge: string;
  state: string;
  nonce: string;
}

export function pkce(): Pkce {
  const verifier = randomBytes(32).toString("base64url");
  return {
    verifier,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
    state: randomBytes(16).toString("base64url"),
    nonce: randomBytes(16).toString("base64url"),
  };
}

export interface CodeWaiter {
  redirectUri: string;
  /** Resolves with the authorization code. */
  code: Promise<string>;
  close(): void;
}

const page = (title: string, text: string) =>
  `<!doctype html><meta charset="utf-8"><title>${brand().name} CLI</title><body style="font:16px system-ui;margin:15vh auto;max-width:520px;text-align:center;padding:0 16px"><h2>${title}</h2><p>${text}</p></body>`;

function codeFromParams(p: URLSearchParams, state: string): string {
  const err = p.get("error");
  if (err)
    throw new CliError(err === "access_denied" ? tr("Bạn đã từ chối cấp quyền.", "You declined.") : (p.get("error_description") ?? err), Exit.auth);
  if (p.get("state") !== state)
    throw new CliError(tr("state không khớp, có thể bị chặn giữa đường. Chạy lại lệnh.", "State mismatch; the redirect may have been tampered with. Run the command again."), Exit.auth);
  const code = p.get("code");
  if (!code) throw new CliError(tr("Không thấy mã trong địa chỉ.", "No code in that address."), Exit.auth);
  return code;
}

export async function waitForCode(state: string, opts: { timeoutMs?: number; path?: string } = {}): Promise<CodeWaiter> {
  const path = opts.path ?? "/callback";
  let resolve!: (v: string) => void;
  let reject!: (e: unknown) => void;
  const code = new Promise<string>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://127.0.0.1");
    if (u.pathname !== path) return void res.writeHead(404).end();
    // Connection: close — otherwise the browser keeps the socket alive and the CLI never exits after login.
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", Connection: "close" });
    try {
      const got = codeFromParams(u.searchParams, state);
      res.end(page(tr("Xong", "Done"), tr("Quay lại terminal để tiếp tục. Có thể đóng tab này.", "Return to your terminal. You can close this tab.")));
      resolve(got);
    } catch (e) {
      res.end(page(tr("Chưa xong", "Not completed"), (e as Error).message));
      reject(e);
    }
  });
  await new Promise<void>((ok, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => ok());
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const timer = setTimeout(() => reject(new CliError(tr("Hết thời gian chờ.", "Timed out."), Exit.auth)), opts.timeoutMs ?? 5 * 60_000);
  code.finally(() => clearTimeout(timer)).catch(() => undefined);
  const close = () => {
    server.close();
    server.closeAllConnections();
  };
  return { redirectUri: `http://127.0.0.1:${port}${path}`, code, close };
}

/**
 * Opens (or prints) the authorize URL and returns the code. With `manual`, also accepts the pasted
 * address from the browser — whichever arrives first wins.
 */
export async function obtainCode(authorizeUrl: string, waiter: CodeWaiter, state: string, opts: { openBrowser: boolean; manual: boolean }): Promise<string> {
  if (opts.openBrowser) {
    const open = (await import("open")).default;
    await open(authorizeUrl).catch(() => undefined);
  }
  if (!opts.manual || !hasTty()) {
    try {
      return await waiter.code;
    } finally {
      waiter.close();
    }
  }
  info(c.dim(tr(
    "  Trình duyệt ở máy khác? Sau khi đồng ý, trang sẽ báo lỗi kết nối — dán địa chỉ trên thanh địa chỉ vào đây:",
    "  Browser on another machine? After you approve, the page fails to load — paste its address here:",
  )));
  const stop = new AbortController();
  const pasted = ask("  › ", stop.signal).then((line) => codeFromParams(new URL(line.trim()).searchParams, state));
  pasted.catch(() => undefined);
  try {
    return await Promise.race([waiter.code, pasted]);
  } finally {
    stop.abort();
    waiter.close();
  }
}
