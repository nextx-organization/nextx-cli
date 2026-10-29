// Identity resolution and session lifecycle.
// Order: <PREFIX>_API_KEY → <PREFIX>_TOKEN → stored session of the profile. `status` prints which one is used.
import { fetch } from "undici";
import { brand, envVar } from "../core/brand.js";
import { context } from "../core/context.js";
import { CliError, Exit } from "../core/errors.js";
import { t } from "../core/i18n.js";
import { withFileLock } from "../core/lock.js";
import { lockFile } from "../core/paths.js";
import { getProfile, updateProfile } from "../core/config.js";
import { readSession, writeSession, deleteSession, type Session } from "./credentials.js";

export type Auth =
  | { kind: "apiKey"; key: string }
  | { kind: "token"; token: string }
  | { kind: "session"; token: string; session: Session };

export type AuthSource = "apiKey" | "token" | "session" | "none";

/** Refresh this long before expiry so a request never leaves with a token about to die. */
const EARLY_MS = 60_000;

export interface JwtClaims {
  sub?: string;
  wid?: string;
  exp?: number;
  iat?: number;
  jti?: string;
  [k: string]: unknown;
}

export function decodeJwt(token: string): JwtClaims {
  const part = token.split(".")[1];
  if (!part) return {};
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as JwtClaims;
  } catch {
    return {};
  }
}

export function authSource(): AuthSource {
  if (envVar("API_KEY")) return "apiKey";
  if (envVar("TOKEN")) return "token";
  return readSession(context().profile) ? "session" : "none";
}

export async function currentAuth(opts: { required?: boolean } = {}): Promise<Auth | undefined> {
  const key = envVar("API_KEY");
  if (key) return { kind: "apiKey", key };
  const token = envVar("TOKEN");
  if (token) return { kind: "token", token };
  const s = readSession(context().profile);
  if (!s) {
    if (opts.required) throw notLoggedIn();
    return undefined;
  }
  if (s.expiresAt - Date.now() < EARLY_MS) return refreshSession(s.accessToken);
  return { kind: "session", token: s.accessToken, session: s };
}

export function notLoggedIn(): CliError {
  return new CliError(t("auth.notLoggedIn"), Exit.auth, t("auth.notLoggedIn.hint"));
}

/** Throws unless the identity is a person (chat, workspace switch, write confirmation need one). */
export async function requirePerson(): Promise<Auth> {
  const a = await currentAuth({ required: true });
  if (a!.kind === "apiKey") throw new CliError(t("auth.apiKeyNoChat"), Exit.forbidden, t("auth.apiKeyNoChat.hint"));
  return a!;
}

interface TokenPairBody {
  accessToken?: string;
  refreshToken?: string;
  expiresIn?: number;
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
}

export function sessionFrom(body: TokenPairBody, via: Session["via"], prev?: Session): Session {
  const accessToken = body.accessToken ?? body.access_token;
  const refreshToken = body.refreshToken ?? body.refresh_token ?? prev?.refreshToken;
  if (!accessToken || !refreshToken) throw new CliError(t("auth.expired"), Exit.auth, t("auth.expired.hint"));
  const claims = decodeJwt(accessToken);
  const expiresIn = body.expiresIn ?? body.expires_in ?? 900;
  // Trust our own clock for expiry; the server clock only matters for skew detection (doctor).
  return {
    kind: "session",
    accessToken,
    refreshToken,
    expiresAt: Date.now() + expiresIn * 1000,
    userId: String(claims.sub ?? prev?.userId ?? ""),
    workspaceId: String(claims.wid ?? claims.workspace_id ?? prev?.workspaceId ?? ""),
    via,
    sessionId: prev?.sessionId,
  };
}

/**
 * Refreshes the stored session. `staleAccess` is the token the caller saw: if another process already
 * replaced it while we waited for the lock, its result is reused instead of refreshing again.
 */
/** Body for `/iam/auth/refresh-token`. An IAM that speaks snake_case ignores a camelCase key and answers 401 "required". */
export function refreshBody(url: string, refreshToken: string): string {
  const body = { refreshToken };
  void url;
  return JSON.stringify(body);
}

export async function refreshSession(staleAccess?: string): Promise<Auth> {
  const profile = context().profile;
  return withFileLock(lockFile(profile), async () => {
    const s = readSession(profile);
    if (!s) throw notLoggedIn();
    if (staleAccess && s.accessToken !== staleAccess && s.expiresAt - Date.now() > EARLY_MS)
      return { kind: "session", token: s.accessToken, session: s } as Auth;
    if (s.via === "ci") {
      // CI tokens have no refresh token: exchange the provider's OIDC token again.
      const { loginCi } = await import("./ci.js");
      const r = await loginCi({});
      return { kind: "session", token: r.session.accessToken, session: r.session } as Auth;
    }
    const url = `${context().endpoints.api}/api/v1/iam/auth/refresh-token`;
    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Client-Type": "cli", "User-Agent": `${brand().bin}-cli` },
        body: refreshBody(url, s.refreshToken),
      });
    } catch (e) {
      const { networkError } = await import("../core/http.js");
      throw networkError(e, url);
    }
    const body = (await res.json().catch(() => ({}))) as TokenPairBody & { code?: string };
    if (res.status === 401 || res.status === 403) {
      // A parallel process may have rotated meanwhile; only give up if the store still holds our token.
      const again = readSession(profile);
      if (again && again.refreshToken !== s.refreshToken) return { kind: "session", token: again.accessToken, session: again } as Auth;
      deleteSession(profile);
      throw new CliError(res.status === 403 ? t("ws.gone") : t("auth.expired"), res.status === 403 ? Exit.forbidden : Exit.auth, t("auth.expired.hint"));
    }
    if (!res.ok) {
      const { errorFor } = await import("../core/http.js");
      throw errorFor(res.status, body, res);
    }
    const next = sessionFrom(body, s.via, s);
    writeSession(profile, next);
    return { kind: "session", token: next.accessToken, session: next } as Auth;
  });
}

export function saveLogin(
  body: TokenPairBody & { user?: { email?: string; fullName?: string }; workspace?: { id?: string; code?: string; name?: string } },
  via: Session["via"],
): Session {
  const profile = context().profile;
  const s = sessionFrom(body, via);
  writeSession(profile, s);
  updateProfile(profile, {
    env: context().env,
    workspaceId: body.workspace?.id ?? s.workspaceId,
    workspaceCode: body.workspace?.code,
    workspaceName: body.workspace?.name,
    userEmail: body.user?.email,
    userName: body.user?.fullName,
  });
  return s;
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  code: string;
  status?: string;
  isDefault?: boolean;
  primaryGroupName?: string;
}

/** Switches the stored session to another workspace. The server ends the old session and opens a new one. */
export async function switchWorkspace(target: WorkspaceSummary): Promise<Session> {
  const { request } = await import("../core/http.js");
  const r = await request<TokenPairBody & { workspace?: WorkspaceSummary; user?: { email?: string; fullName?: string } }>(
    "POST",
    "/iam/workspaces/switch",
    { body: { workspaceId: target.id } },
  );
  const profile = context().profile;
  const prev = readSession(profile);
  const s = sessionFrom(r.data, prev?.via ?? "password", prev);
  s.workspaceId = target.id;
  writeSession(profile, s);
  updateProfile(profile, {
    workspaceId: target.id,
    workspaceCode: r.data.workspace?.code ?? target.code,
    workspaceName: r.data.workspace?.name ?? target.name,
    lastConversation: undefined,
  });
  return s;
}

export async function listWorkspaces(): Promise<WorkspaceSummary[]> {
  const { get } = await import("../core/http.js");
  return get<WorkspaceSummary[]>("/iam/workspaces");
}

export function findWorkspace(list: WorkspaceSummary[], key: string): WorkspaceSummary | undefined {
  const k = key.toLowerCase();
  return list.find((w) => w.id === key || w.code?.toLowerCase() === k) ?? list.find((w) => w.name.toLowerCase() === k);
}

/**
 * -w for a single command: switch, run, switch back. Each step stores the new tokens, so a crash in the
 * middle leaves a valid session (on the other workspace) rather than a dead one.
 */
export async function withWorkspace<T>(key: string | undefined, fn: () => Promise<T>): Promise<T> {
  if (!key || authSource() !== "session") return fn();
  const profile = context().profile;
  const current = getProfile(profile);
  const list = await listWorkspaces();
  const target = findWorkspace(list, key);
  if (!target) throw new CliError(t("ws.gone"), Exit.notFound, t("ws.gone.hint"));
  if (target.id === current?.workspaceId) return fn();
  const original = list.find((w) => w.id === current?.workspaceId);
  await switchWorkspace(target);
  try {
    return await fn();
  } finally {
    if (original) await switchWorkspace(original).catch(() => undefined);
  }
}

export async function logoutServer(): Promise<boolean> {
  const s = readSession(context().profile);
  if (!s) return false;
  const { request } = await import("../core/http.js");
  try {
    // Logout finds the server session by the access token's jti, so make sure it is still valid.
    const auth = await currentAuth();
    await request("POST", "/iam/auth/logout", { bearer: auth?.kind === "session" ? auth.token : s.accessToken, body: {}, allow: [401] });
    return true;
  } catch {
    return false;
  }
}
