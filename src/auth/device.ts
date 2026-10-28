// OAuth 2.0 Device Authorization Grant (RFC 8628) for machines with neither a browser nor the mobile app.
import { setTimeout as sleep } from "node:timers/promises";
import { fetch } from "undici";
import { brand } from "../core/brand.js";
import { context } from "../core/context.js";
import { CliError, Exit } from "../core/errors.js";
import { tr } from "../core/i18n.js";
import { c, info } from "../core/output.js";
import { errorFor, networkError, userAgent } from "../core/http.js";
import { sessionFrom, switchWorkspace, listWorkspaces, findWorkspace } from "./session.js";
import { writeSession } from "./credentials.js";
import { fetchMe, type LoginResult } from "./login.js";
import { updateProfile } from "../core/config.js";

interface DeviceStart {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval?: number;
}

async function form(url: string, body: Record<string, string>) {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": userAgent() },
      body: new URLSearchParams(body).toString(),
    });
    return { res, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  } catch (e) {
    throw networkError(e, url);
  }
}

export async function loginDevice(opts: { workspace?: string }): Promise<LoginResult> {
  const ep = context().endpoints;
  const start = await form(`${ep.auth}/device_authorization`, { client_id: brand().clientId, scope: "openid profile email" });
  if (start.res.status === 404)
    throw new CliError(tr("Máy chủ chưa hỗ trợ đăng nhập bằng mã thiết bị.", "The server does not support device login yet."), Exit.general, `${brand().bin} login --qr`);
  if (!start.res.ok) throw errorFor(start.res.status, start.json, start.res);
  const d = start.json as unknown as DeviceStart;

  info(tr("  Trên máy bất kỳ, mở", "  On any device, open") + ` ${c.yellow(d.verification_uri)} ` + tr("và nhập mã:", "and enter the code:"));
  info();
  info(`        ${c.bold(d.user_code)}          ${c.dim(tr(`hết hạn sau ${Math.round(d.expires_in / 60)} phút`, `expires in ${Math.round(d.expires_in / 60)} minutes`))}`);
  info();
  if (d.verification_uri_complete) info(c.dim(`  ${d.verification_uri_complete}`));

  let interval = Math.max(d.interval ?? 5, 1);
  const deadline = Date.now() + d.expires_in * 1000;
  while (Date.now() < deadline) {
    await sleep(interval * 1000);
    const r = await form(`${ep.auth}/token`, {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: d.device_code,
      client_id: brand().clientId,
    });
    if (r.res.ok) {
      const session = sessionFrom(r.json, "device");
      writeSession(context().profile, session);
      const me = await fetchMe(session.accessToken);
      updateProfile(context().profile, { env: context().env, workspaceId: me.workspace?.id, workspaceCode: me.workspace?.code, workspaceName: me.workspace?.name, userEmail: me.email, userName: me.fullName });
      if (opts.workspace) {
        const target = findWorkspace(await listWorkspaces(), opts.workspace);
        if (target && target.id !== me.workspace?.id) await switchWorkspace(target);
      }
      return { session, userName: me.fullName, userEmail: me.email, workspaceName: me.workspace?.name };
    }
    const err = String(r.json.error ?? "");
    if (err === "authorization_pending") continue;
    if (err === "slow_down") {
      interval += 5;
      continue;
    }
    if (err === "access_denied") throw new CliError(tr("Đăng nhập bị từ chối.", "Login was denied."), Exit.auth);
    if (err === "expired_token") break;
    throw errorFor(r.res.status, r.json, r.res);
  }
  throw new CliError(tr("Mã đã hết hạn. Chạy lại lệnh đăng nhập.", "The code expired. Run login again."), Exit.auth);
}
