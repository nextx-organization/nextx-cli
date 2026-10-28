import type { Command } from "commander";
import { brand } from "../core/brand.js";
import { context } from "../core/context.js";
import { CliError, Exit } from "../core/errors.js";
import { tr } from "../core/i18n.js";
import { c, emit, info, ok, table, warn } from "../core/output.js";
import { get, del } from "../core/http.js";
import { getProfile, loadConfig, removeProfile } from "../core/config.js";
import { deleteSession, readSession, storageKind } from "../auth/credentials.js";
import { authSource, currentAuth, logoutServer, decodeJwt } from "../auth/session.js";
import { loginQr, loginWeb, type LoginResult } from "../auth/login.js";
import { loginDevice } from "../auth/device.js";
import { loginCi } from "../auth/ci.js";
import { VERSION } from "../core/version.js";

/** SSH sessions and Linux boxes without a display cannot open a browser. */
export function browserAvailable(): boolean {
  if (process.env.SSH_CONNECTION || process.env.SSH_TTY) return false;
  if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return false;
  return true;
}

export async function usage(): Promise<{ planName?: string; used?: number; limit?: number; remaining?: number; resetsAt?: string; enforced?: boolean } | undefined> {
  try {
    return await get("/operator/widget/support/usage");
  } catch {
    return undefined;
  }
}

function printLogin(r: LoginResult): void {
  const p = getProfile(context().profile);
  ok(tr(`Đã đăng nhập ${c.bold(r.userName ?? "")} (${r.userEmail ?? ""})`, `Logged in as ${c.bold(r.userName ?? "")} (${r.userEmail ?? ""})`));
  info(`  ${tr("Workspace", "Workspace")}  ${c.bold(r.workspaceName ?? p?.workspaceName ?? "")}  · ${context().env === "prod" ? "prod" : c.yellow("sandbox")}`);
  info(`  ${tr("Phiên", "Session")}      ${tr("tự gia hạn khi dùng, hết hạn nếu bỏ không 30 ngày", "renews while used, expires after 30 idle days")} · ${storageKind() === "keychain" ? "Keychain" : tr("tệp 0600", "0600 file")}`);
  info(c.dim(`  ${tr("Thử", "Try")}: ${brand().bin}  ·  ${brand().bin} -p "${tr("doanh thu hôm qua", "yesterday's revenue")}"  ·  ${brand().bin} help`));
}

export function registerAuth(program: Command): void {
  const b = brand();

  program
    .command("login")
    .description(tr("đăng nhập (tự chọn trình duyệt hoặc QR)", "log in (browser or QR, chosen automatically)"))
    .option("--web", tr("đăng nhập qua trình duyệt", "log in with the browser"))
    .option("--qr", tr(`quét mã bằng app ${b.mobileApp} (SSH, máy không có trình duyệt)`, `scan with the ${b.mobileApp} app (SSH, headless machines)`))
    .option("--device", tr("nhập mã trên máy khác (RFC 8628)", "enter a code on another device (RFC 8628)"))
    .option("--ci", tr("trong GitHub Actions/GitLab CI: đổi token OIDC lấy token ngắn hạn", "in GitHub Actions/GitLab CI: exchange the OIDC token for a short-lived token"))
    .option("--no-browser", tr("không tự mở trình duyệt, chỉ in link", "do not open the browser, print the link only"))
    .action(async (o: { web?: boolean; qr?: boolean; device?: boolean; ci?: boolean; browser?: boolean }) => {
      const ws = context().workspace;
      let r: LoginResult;
      if (o.ci) r = await loginCi({ workspace: ws });
      else if (o.device) r = await loginDevice({ workspace: ws });
      else if (o.qr || (!o.web && !browserAvailable())) r = await loginQr({ workspace: ws });
      else r = await loginWeb({ workspace: ws, noBrowser: o.browser === false });
      const u = await usage();
      emit({ user: { name: r.userName, email: r.userEmail }, workspace: r.workspaceName, env: context().env, via: r.session.via, ai: u ?? null }, () => {
        printLogin(r);
        if (u) info(`  ${tr("Gói AI", "AI plan")}     ${c.bold(u.planName ?? "-")}${u.limit ? ` · ${tr("còn", "left")} ${u.remaining}/${u.limit}` : ""}`);
      });
    });

  program
    .command("logout")
    .description(tr("đăng xuất hồ sơ này (thu hồi phiên trên máy chủ)", "log out this profile (revokes the server session)"))
    .option("--all", tr("đăng xuất mọi hồ sơ trên máy này", "log out every profile on this machine"))
    .action(async (o: { all?: boolean }) => {
      const profiles = o.all ? Object.keys(loadConfig().profiles) : [context().profile];
      for (const name of profiles) {
        const { setContext, initContext } = await import("../core/context.js");
        if (name !== context().profile) {
          initContext({ profile: name });
          setContext({ profile: name });
        }
        if (!readSession(name)) continue;
        const revoked = await logoutServer();
        deleteSession(name);
        removeProfile(name);
        if (revoked) ok(tr(`Đã đăng xuất (${name})`, `Logged out (${name})`));
        else
          warn(tr(
            `Đã xoá phiên trên máy (${name}), nhưng không tới được máy chủ: phiên còn sống tới khi hết hạn. Thu hồi tại ${context().endpoints.id} › Thiết bị`,
            `Removed the local session (${name}), but the server was unreachable: it stays valid until it expires. Revoke it at ${context().endpoints.id} › Devices`,
          ));
      }
    });

  program
    .command("status")
    .description(tr("tài khoản, workspace, môi trường, gói AI, phiên", "account, workspace, environment, AI plan, session"))
    .action(async () => {
      const src = authSource();
      const p = getProfile(context().profile);
      const base = { version: VERSION, profile: context().profile, env: context().env, api: context().endpoints.api, identity: src };
      if (src === "none") {
        emit({ ...base, loggedIn: false }, () => {
          info(`${b.name} CLI ${VERSION} · ${tr("hồ sơ", "profile")} ${context().profile} · ${context().env}`);
          warn(tr(`Chưa đăng nhập. Chạy \`${b.bin} login\``, `Not logged in. Run \`${b.bin} login\``));
        });
        process.exitCode = Exit.auth;
        return;
      }
      if (src === "apiKey") {
        emit({ ...base, loggedIn: true, kind: "apiKey" }, () => info(tr(`Đang dùng khoá API từ ${b.envPrefix}_API_KEY (danh tính agent).`, `Using the API key from ${b.envPrefix}_API_KEY (agent identity).`)));
        return;
      }
      const auth = await currentAuth({ required: true });
      const me = await get<{ email?: string; fullName?: string; workspace?: { name: string; code: string }; groups?: string[] }>("/iam/auth/me");
      const u = await usage();
      const s = readSession(context().profile);
      const claims = auth?.kind !== "apiKey" ? decodeJwt(auth!.token) : {};
      const data = {
        ...base,
        loggedIn: true,
        user: { name: me.fullName, email: me.email },
        workspace: me.workspace,
        groups: me.groups,
        ai: u ?? null,
        session: s ? { via: s.via, accessExpiresAt: new Date(s.expiresAt).toISOString(), storage: storageKind() } : null,
        tokenExp: claims.exp ? new Date(claims.exp * 1000).toISOString() : null,
      };
      emit(data, () => {
        info(`${c.bold(me.fullName ?? "")} ${c.dim(me.email ?? "")}`);
        info(`  ${tr("Workspace", "Workspace")}   ${c.bold(me.workspace?.name ?? "")} ${c.dim(me.workspace?.code ?? "")} · ${(me.groups ?? []).join(", ")}`);
        info(`  ${tr("Môi trường", "Environment")}  ${context().env === "prod" ? c.red("prod") : c.yellow("sandbox")} · ${context().endpoints.api}`);
        if (u) info(`  ${tr("Gói AI", "AI plan")}      ${u.planName ?? "-"}${u.limit ? ` · ${tr("đã dùng", "used")} ${u.used}/${u.limit}, ${tr("mở lại", "resets")} ${u.resetsAt?.slice(0, 10)}` : ""}`);
        info(`  ${tr("Danh tính", "Identity")}    ${src === "token" ? `${b.envPrefix}_TOKEN` : `${tr("phiên", "session")} (${s?.via}) · ${storageKind() === "keychain" ? "Keychain" : tr("tệp", "file")}`}`);
        info(`  ${tr("Hồ sơ", "Profile")}       ${context().profile}${p?.agent ? ` · agent ${p.agent}` : ""} · CLI ${VERSION}`);
      });
    });

  const sessions = program.command("sessions").description(tr("phiên đăng nhập của bạn trên mọi thiết bị", "your login sessions on all devices"));
  sessions
    .command("list", { isDefault: true })
    .description(tr("danh sách phiên", "list sessions"))
    .action(async () => {
      const list = await get<{ id: string; deviceName?: string | null; userAgent?: string | null; ipAddress?: string | null; lastActivity?: string; createdAt?: string; isCurrentSession?: boolean; osName?: string | null; browserName?: string | null; city?: string | null }[]>("/iam/sessions");
      const device = (s: (typeof list)[number]) => {
        const cli = /^([a-z]+)-cli\/(\S+) \(([^;)]+)/.exec(s.userAgent ?? "");
        if (cli) return `${s.browserName ?? `${brand().name} CLI ${cli[2]}`} · ${s.osName ?? cli[3]}`;
        return s.deviceName ?? ([s.osName, s.browserName].filter(Boolean).join(" · ") || s.userAgent || "");
      };
      emit(list, () =>
        info(table(
          ["", "ID", tr("Thiết bị", "Device"), tr("Nơi", "Where"), tr("Hoạt động", "Last active")],
          list.map((s) => [s.isCurrentSession ? c.green("●") : "", s.id.slice(0, 8), device(s).slice(0, 40), s.city ?? s.ipAddress ?? "", (s.lastActivity ?? s.createdAt ?? "").slice(0, 16).replace("T", " ")]),
        )),
      );
    });
  sessions
    .command("revoke [id]")
    .description(tr("thu hồi một phiên, hoặc --others để thu hồi mọi phiên khác", "revoke one session, or --others for all other sessions"))
    .option("--others", tr("mọi phiên trừ phiên này", "every session except this one"))
    .action(async (id: string | undefined, o: { others?: boolean }) => {
      if (o.others) {
        await del("/iam/sessions");
        ok(tr("Đã thu hồi mọi phiên khác.", "Revoked all other sessions."));
        return;
      }
      if (!id) throw new CliError(tr("Cần id phiên (xem `sessions list`) hoặc --others.", "Pass a session id (see `sessions list`) or --others."), Exit.usage);
      const list = await get<{ id: string }[]>("/iam/sessions");
      const hit = list.find((s) => s.id === id || s.id.startsWith(id));
      if (!hit) throw new CliError(tr("Không thấy phiên này.", "Session not found."), Exit.notFound);
      await del(`/iam/sessions/${hit.id}`);
      ok(tr(`Đã thu hồi phiên ${hit.id.slice(0, 8)}.`, `Revoked session ${hit.id.slice(0, 8)}.`));
    });
}
