// Delegated OAuth for the hosted MCP server. Tool catalog and tool calls only accept tokens issued for the
// MCP resource (RFC 8707), so the CLI registers itself like any MCP client: dynamic client registration
// (public, PKCE, loopback), one consent in the browser, then refresh tokens.
import { hostname } from "node:os";
import { fetch } from "undici";
import { brand } from "../core/brand.js";
import { context } from "../core/context.js";
import { CliError, Exit } from "../core/errors.js";
import { tr } from "../core/i18n.js";
import { c, info } from "../core/output.js";
import { errorFor, networkError, userAgent } from "../core/http.js";
import { withFileLock } from "../core/lock.js";
import { lockFile } from "../core/paths.js";
import { readSecret, writeSecret, deleteSecret } from "./credentials.js";
import { pkce, waitForCode, obtainCode } from "./loopback.js";

export interface McpGrant {
  clientId: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  scope: string;
  resource: string;
  authServer: string;
}

const account = () => `mcp:${context().profile}:${context().env}`;

export function readGrant(): McpGrant | undefined {
  const raw = readSecret(account());
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as McpGrant;
  } catch {
    return undefined;
  }
}

export const deleteGrant = () => deleteSecret(account());

async function json<T>(url: string, init?: Parameters<typeof fetch>[1]): Promise<{ res: Awaited<ReturnType<typeof fetch>>; body: T }> {
  try {
    const res = await fetch(url, { ...init, headers: { "User-Agent": userAgent(), ...(init?.headers as Record<string, string>) } });
    return { res, body: (await res.json().catch(() => ({}))) as T };
  } catch (e) {
    throw networkError(e, url);
  }
}

interface ResourceMeta {
  resource: string;
  authorization_servers: string[];
  scopes_supported?: string[];
}

interface AsMeta {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  revocation_endpoint?: string;
}

async function discover(): Promise<{ resource: ResourceMeta; as: AsMeta; asUrl: string }> {
  const mcp = new URL(context().endpoints.mcp);
  const r = await json<ResourceMeta>(`${mcp.origin}/.well-known/oauth-protected-resource${mcp.pathname}`);
  if (!r.res.ok || !r.body.authorization_servers?.length) throw errorFor(r.res.status, r.body, r.res);
  const asUrl = r.body.authorization_servers[0]!;
  const a = await json<AsMeta>(`${asUrl}/.well-known/oauth-authorization-server`);
  if (!a.res.ok) throw errorFor(a.res.status, a.body, a.res);
  return { resource: r.body, as: a.body, asUrl };
}

/** Scopes to ask for: everything the server offers, limited to the brand's modules. */
function wantedScopes(offered: string[]): string {
  const mods = brand().modules;
  return offered.filter((s) => !mods || mods.includes(s.split(":")[0]!)).join(" ");
}

export async function authorizeMcp(opts: { openBrowser?: boolean; manual?: boolean } = {}): Promise<McpGrant> {
  const { resource, as, asUrl } = await discover();
  if (!as.registration_endpoint) throw new CliError(tr("Máy chủ không cho đăng ký client.", "The server does not allow client registration."), Exit.general);
  const p = pkce();
  const waiter = await waitForCode(p.state);
  const prev = readGrant();
  let clientId = prev?.authServer === asUrl ? prev.clientId : undefined;
  if (!clientId) {
    const reg = await json<{ client_id: string }>(as.registration_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: `${brand().name} CLI (${hostname()})`,
        client_uri: context().endpoints.docs + "/docs/cli",
        redirect_uris: ["http://127.0.0.1/callback"],
        grant_types: ["authorization_code", "refresh_token"],
        token_endpoint_auth_method: "none",
      }),
    });
    if (!reg.res.ok) throw errorFor(reg.res.status, reg.body, reg.res);
    clientId = reg.body.client_id;
  }
  const scope = wantedScopes(resource.scopes_supported ?? []);
  const url = new URL(as.authorization_endpoint);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: waiter.redirectUri,
    scope,
    state: p.state,
    code_challenge: p.challenge,
    code_challenge_method: "S256",
    resource: resource.resource,
  }).toString();
  info(`${c.cyan("◆")} ${tr(
    `Cấp quyền công cụ AI cho ${brand().name} CLI (một lần). Mở trình duyệt…`,
    `Grant AI tool access to the ${brand().name} CLI (once). Opening your browser…`,
  )}`);
  info(`  ${c.yellow(url.toString())}`);
  const code = await obtainCode(url.toString(), waiter, p.state, { openBrowser: opts.openBrowser !== false, manual: opts.manual === true });
  const tok = await json<Record<string, unknown>>(as.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: waiter.redirectUri,
      client_id: clientId,
      code_verifier: p.verifier,
      resource: resource.resource,
    }).toString(),
  });
  if (!tok.res.ok) throw errorFor(tok.res.status, tok.body, tok.res);
  const grant: McpGrant = {
    clientId,
    accessToken: String(tok.body.access_token),
    refreshToken: tok.body.refresh_token ? String(tok.body.refresh_token) : undefined,
    expiresAt: Date.now() + Number(tok.body.expires_in ?? 900) * 1000,
    scope: String(tok.body.scope ?? scope),
    resource: resource.resource,
    authServer: asUrl,
  };
  writeSecret(account(), JSON.stringify(grant));
  return grant;
}

async function refreshGrant(g: McpGrant): Promise<McpGrant | undefined> {
  if (!g.refreshToken) return undefined;
  return withFileLock(lockFile(`${context().profile}-mcp`), async () => {
    const cur = readGrant();
    if (cur && cur.accessToken !== g.accessToken && cur.expiresAt - Date.now() > 60_000) return cur;
    const a = await json<AsMeta>(`${g.authServer}/.well-known/oauth-authorization-server`);
    const tok = await json<Record<string, unknown>>(a.body.token_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: g.refreshToken!, client_id: g.clientId, resource: g.resource }).toString(),
    });
    if (!tok.res.ok) return undefined;
    const next: McpGrant = {
      ...g,
      accessToken: String(tok.body.access_token),
      refreshToken: tok.body.refresh_token ? String(tok.body.refresh_token) : g.refreshToken,
      expiresAt: Date.now() + Number(tok.body.expires_in ?? 900) * 1000,
      scope: String(tok.body.scope ?? g.scope),
    };
    writeSecret(account(), JSON.stringify(next));
    return next;
  });
}

/** A valid MCP token, refreshing or asking for consent when needed (consent only with a TTY). */
export async function mcpToken(opts: { interactive: boolean }): Promise<string> {
  let g = readGrant();
  if (g && g.expiresAt - Date.now() < 60_000) g = await refreshGrant(g);
  if (g) return g.accessToken;
  if (!opts.interactive)
    throw new CliError(
      tr("CLI chưa được cấp quyền công cụ AI trên máy này.", "The CLI has not been granted AI tool access on this machine."),
      Exit.auth,
      tr(`Chạy một lần: ${brand().bin} tools login`, `Run once: ${brand().bin} tools login`),
    );
  const { browserAvailable } = await import("../commands/auth.js");
  return (await authorizeMcp({ openBrowser: browserAvailable(), manual: !browserAvailable() })).accessToken;
}

export async function revokeGrant(): Promise<void> {
  const g = readGrant();
  if (!g) return;
  try {
    const a = await json<AsMeta>(`${g.authServer}/.well-known/oauth-authorization-server`);
    if (a.body.revocation_endpoint)
      await fetch(a.body.revocation_endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: g.refreshToken ?? g.accessToken, client_id: g.clientId }).toString(),
      });
  } catch {
    // local removal still happens
  }
  deleteGrant();
}
