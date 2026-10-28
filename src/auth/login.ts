// Login flows. Web: OAuth 2.1 authorization code + PKCE with a loopback redirect (RFC 8252) — the CLI is a
// public client, no secret. QR: the mobile app approves this machine (cross-device login), then the CLI
// picks a workspace with the short-lived pre-auth token.
import { setTimeout as sleep } from "node:timers/promises";
import { fetch } from "undici";
import QRCode from "qrcode";
import { brand } from "../core/brand.js";
import { context } from "../core/context.js";
import { CliError, Exit } from "../core/errors.js";
import { t, tr } from "../core/i18n.js";
import { c, info, warn } from "../core/output.js";
import { hasTty, select } from "../core/prompt.js";
import { request, userAgent, errorFor, networkError } from "../core/http.js";
import { pkce, waitForCode, obtainCode } from "./loopback.js";
import { saveLogin, sessionFrom, findWorkspace, type WorkspaceSummary } from "./session.js";
import { writeSession, type Session } from "./credentials.js";
import { updateProfile } from "../core/config.js";

export interface LoginResult {
  session: Session;
  userName?: string;
  userEmail?: string;
  workspaceName?: string;
}

// ── Web ──────────────────────────────────────────────────────────────────────────────────────────────

export async function loginWeb(opts: { workspace?: string; noBrowser?: boolean; manual?: boolean }): Promise<LoginResult> {
  const ep = context().endpoints;
  const p = pkce();
  const waiter = await waitForCode(p.state);
  const url = new URL(`${ep.auth}/authorize`);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: brand().clientId,
    redirect_uri: waiter.redirectUri,
    scope: "openid profile email",
    state: p.state,
    nonce: p.nonce,
    code_challenge: p.challenge,
    code_challenge_method: "S256",
    prompt: "select_account",
  }).toString();

  info(`${c.cyan("◆")} ${brand().name}  ${tr("Mở trình duyệt để đăng nhập…", "Opening your browser to log in…")}`);
  info(`  ${tr("Trình duyệt không mở? Dán link này:", "Browser did not open? Paste this link:")} ${c.yellow(url.toString())}`);
  info(`  ${tr("Hoặc đăng nhập bằng điện thoại:", "Or log in with your phone:")} ${c.dim(`${brand().bin} login --qr`)}`);
  info(c.dim(`  ${tr("Đang chờ… (Ctrl+C để huỷ, tự huỷ sau 5 phút)", "Waiting… (Ctrl+C to cancel, times out in 5 minutes)")}`));
  const authCode = await obtainCode(url.toString(), waiter, p.state, { openBrowser: !opts.noBrowser, manual: opts.manual === true || opts.noBrowser === true });

  let res;
  const tokenUrl = `${ep.auth}/token`;
  try {
    res = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": userAgent() },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: authCode,
        redirect_uri: waiter.redirectUri,
        client_id: brand().clientId,
        code_verifier: p.verifier,
      }).toString(),
    });
  } catch (e) {
    throw networkError(e, tokenUrl);
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    if (body.error === "invalid_client")
      throw new CliError(tr("Máy chủ chưa nhận đăng nhập trình duyệt cho CLI.", "The server does not accept browser login for the CLI yet."), Exit.auth, `${brand().bin} login --qr`);
    throw errorFor(res.status, body, res);
  }

  const session = sessionFrom(body, "web");
  writeSession(context().profile, session);
  const me = await fetchMe(session.accessToken);
  updateProfile(context().profile, {
    env: context().env,
    workspaceId: me.workspace?.id ?? session.workspaceId,
    workspaceCode: me.workspace?.code,
    workspaceName: me.workspace?.name,
    userEmail: me.email,
    userName: me.fullName,
  });
  // A --workspace flag wins over the one chosen in the browser.
  if (opts.workspace && me.workspace?.code !== opts.workspace && me.workspace?.id !== opts.workspace) {
    const { listWorkspaces, switchWorkspace } = await import("./session.js");
    const target = findWorkspace(await listWorkspaces(), opts.workspace);
    if (target) await switchWorkspace(target);
  }
  return { session, userName: me.fullName, userEmail: me.email, workspaceName: me.workspace?.name };
}

interface MeBody {
  userId: string;
  email?: string;
  fullName?: string;
  workspace?: { id: string; name: string; code: string; status?: string };
  permissions?: string[];
  groups?: string[];
}

export async function fetchMe(bearer?: string): Promise<MeBody> {
  const r = await request<MeBody>("GET", "/iam/auth/me", bearer ? { bearer } : {});
  return r.data;
}

// ── QR ───────────────────────────────────────────────────────────────────────────────────────────────

interface QrCreate {
  token: string;
  pollKey: string;
  expiresIn: number;
  qrPayload: string;
}

interface QrStatus {
  status: "PENDING" | "SCANNED" | "APPROVED" | "REJECTED" | "EXPIRED" | string;
  preAuthToken?: string;
  workspaces?: WorkspaceSummary[];
}

export async function loginQr(opts: { workspace?: string; maxRounds?: number }): Promise<LoginResult> {
  const rounds = opts.maxRounds ?? 3;
  for (let round = 1; round <= rounds; round++) {
    const q = (await request<QrCreate>("POST", "/iam/auth/qr/create", { anonymous: true })).data;
    info(tr(
      `  Mở app ${c.bold(brand().mobileApp)} trên điện thoại › biểu tượng quét › quét mã:`,
      `  Open the ${c.bold(brand().mobileApp)} app on your phone › scan icon › scan this code:`,
    ));
    info();
    info((await QRCode.toString(q.qrPayload, { type: "terminal", small: true })).replace(/^/gm, "      "));
    const deadline = Date.now() + q.expiresIn * 1000;
    let scannedShown = false;
    while (Date.now() < deadline) {
      await sleep(2000);
      const s = (await request<QrStatus>("GET", "/iam/auth/qr/status", {
        anonymous: true,
        query: { token: q.token },
        headers: { "X-QR-Poll-Key": q.pollKey },
        allow: [401, 404, 410],
      })).data;
      const status = (s?.status ?? "").toUpperCase();
      if (status === "SCANNED" && !scannedShown) {
        scannedShown = true;
        info(c.dim(tr("  ⏺ Đã quét — chờ bấm Duyệt trên điện thoại…", "  ⏺ Scanned — waiting for Approve on the phone…")));
      }
      if (status === "REJECTED") throw new CliError(tr("Đăng nhập bị từ chối trên điện thoại.", "Login was rejected on the phone."), Exit.auth);
      if (status === "APPROVED" && s.preAuthToken) return finishPreAuth(s.preAuthToken, s.workspaces ?? [], opts.workspace, "qr");
      if (status === "EXPIRED") break;
    }
    if (round < rounds) info(c.dim(tr("  Mã đã hết hạn, tạo mã mới…", "  Code expired, creating a new one…")));
  }
  throw new CliError(tr("Hết thời gian chờ quét mã.", "Timed out waiting for the scan."), Exit.auth);
}

/**
 * Pre-auth token lives 5 minutes: choose the workspace right away and exchange it for a full session.
 * Used by QR login (and by internal QA scripts that log in with a password).
 */
export async function finishPreAuth(preAuth: string, workspaces: WorkspaceSummary[], wanted: string | undefined, via: Session["via"]): Promise<LoginResult> {
  if (workspaces.length === 0)
    throw new CliError(t("ws.none"), Exit.auth, t("ws.none.hint", { app: context().endpoints.app }));
  let target = wanted ? findWorkspace(workspaces, wanted) : undefined;
  if (wanted && !target) warn(tr(`Không thấy workspace "${wanted}", chọn trong danh sách.`, `Workspace "${wanted}" not found, pick one below.`));
  if (!target) {
    if (workspaces.length === 1 || !hasTty()) target = workspaces.find((w) => w.isDefault) ?? workspaces[0];
    else {
      target = await select(
        c.green("✓ ") + tr(`Đã duyệt. Bạn có ${workspaces.length} workspace:`, `Approved. You have ${workspaces.length} workspaces:`),
        workspaces.map((w) => ({ label: w.name, hint: [w.code, w.primaryGroupName].filter(Boolean).join(" · "), value: w })),
      );
      if (!target) throw new CliError(t("interrupted"), Exit.interrupted);
    }
  }
  const r = await request<Record<string, unknown>>("POST", "/iam/auth/select-workspace", { bearer: preAuth, body: { workspaceId: target!.id } });
  const body = r.data as Parameters<typeof saveLogin>[0];
  const session = saveLogin(body, via);
  return { session, userName: body.user?.fullName, userEmail: body.user?.email, workspaceName: body.workspace?.name ?? target!.name };
}
