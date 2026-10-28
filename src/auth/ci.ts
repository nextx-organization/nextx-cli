// Secretless CI login: exchange the CI provider's OIDC token (GitHub Actions, GitLab CI) for a short-lived
// platform token (RFC 8693). The workspace admin declares which repository/branch may act as whom.
import { fetch } from "undici";
import { brand, envVar } from "../core/brand.js";
import { context } from "../core/context.js";
import { CliError, Exit } from "../core/errors.js";
import { tr } from "../core/i18n.js";
import { errorFor, networkError, userAgent } from "../core/http.js";
import { sessionFrom } from "./session.js";
import { writeSession } from "./credentials.js";
import { fetchMe, type LoginResult } from "./login.js";
import { updateProfile } from "../core/config.js";

export function inCi(): boolean {
  return Boolean(process.env.ACTIONS_ID_TOKEN_REQUEST_URL || process.env.GITLAB_CI || envVar("ID_TOKEN"));
}

/** Gets the provider's OIDC token with our authorization server as audience. */
async function providerToken(audience: string): Promise<{ token: string; provider: string }> {
  const own = envVar("ID_TOKEN");
  if (own) return { token: own, provider: process.env.GITLAB_CI ? "gitlab" : "custom" };
  const url = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const bearer = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (url && bearer) {
    const u = new URL(url);
    u.searchParams.set("audience", audience);
    const res = await fetch(u, { headers: { Authorization: `Bearer ${bearer}`, Accept: "application/json" } });
    if (!res.ok) throw new CliError(tr("Không lấy được token OIDC của GitHub Actions. Thêm `permissions: id-token: write` vào workflow.", "Could not get the GitHub Actions OIDC token. Add `permissions: id-token: write` to the workflow."), Exit.auth);
    return { token: ((await res.json()) as { value: string }).value, provider: "github" };
  }
  throw new CliError(
    tr(`Không thấy token OIDC. GitHub: cần \`permissions: id-token: write\`. GitLab: khai \`id_tokens: ${brand().envPrefix}_ID_TOKEN: { aud: ${audience} }\`.`,
      `No OIDC token found. GitHub: needs \`permissions: id-token: write\`. GitLab: declare \`id_tokens: ${brand().envPrefix}_ID_TOKEN: { aud: ${audience} }\`.`),
    Exit.auth,
  );
}

export async function loginCi(opts: { workspace?: string }): Promise<LoginResult> {
  const ep = context().endpoints;
  const { token, provider } = await providerToken(ep.auth);
  const body: Record<string, string> = {
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    client_id: brand().clientId,
    subject_token: token,
    subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
    audience: ep.api,
  };
  if (opts.workspace) body.workspace = opts.workspace;
  const url = `${ep.auth}/token`;
  let res;
  try {
    res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": userAgent() }, body: new URLSearchParams(body).toString() });
  } catch (e) {
    throw networkError(e, url);
  }
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    if (json.error === "invalid_grant" || json.error === "unauthorized_client")
      throw new CliError(
        tr(`Kho/nhánh này chưa được phép đăng nhập (${provider}). Quản trị khai báo ở ${ep.app} › ${brand().ciSettings.vi}.`, `This repository/branch is not allowed to log in (${provider}). An admin can allow it at ${ep.app} › ${brand().ciSettings.en}.`),
        Exit.auth,
        String(json.error_description ?? ""),
      );
    throw errorFor(res.status, json, res);
  }
  const session = sessionFrom({ ...json, refresh_token: "ci" }, "ci");
  writeSession(context().profile, session);
  const me = await fetchMe(session.accessToken);
  updateProfile(context().profile, { env: context().env, workspaceId: me.workspace?.id, workspaceCode: me.workspace?.code, workspaceName: me.workspace?.name, userEmail: me.email, userName: me.fullName });
  return { session, userName: me.fullName, userEmail: me.email, workspaceName: me.workspace?.name };
}
