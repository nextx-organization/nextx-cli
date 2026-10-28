// Options shared by every command, resolved once from global flags + environment + config.
import { brand, envVar, type EnvName, type Endpoints } from "./brand.js";
import { getProfile, loadConfig, profileName, type Mode } from "./config.js";

export interface RunContext {
  profile: string;
  env: EnvName;
  endpoints: Endpoints;
  /** -w: run this command on another workspace (code or id). */
  workspace?: string;
  agent?: string;
  mode: Mode;
  debug: boolean;
  verbose: boolean;
  interactive: boolean;
}

export interface GlobalFlags {
  profile?: string;
  sandbox?: boolean;
  workspace?: string;
  agent?: string;
  mode?: Mode;
  debug?: boolean;
  verbose?: boolean;
}

let ctx: RunContext | undefined;

export function initContext(flags: GlobalFlags): RunContext {
  const profile = profileName(flags.profile);
  const p = getProfile(profile);
  const envFromVar = envVar("ENV");
  const env: EnvName = flags.sandbox || envFromVar === "sandbox" ? "sandbox" : envFromVar === "prod" ? "prod" : (p?.env ?? "prod");
  const cfg = loadConfig();
  ctx = {
    profile,
    env,
    endpoints: overrideEndpoints(brand().env[env]),
    workspace: flags.workspace ?? envVar("WORKSPACE"),
    agent: flags.agent ?? p?.agent,
    mode: flags.mode ?? cfg.mode ?? "propose",
    debug: flags.debug === true || envVar("DEBUG") === "1",
    verbose: flags.verbose === true,
    interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
  };
  return ctx;
}

/** <PREFIX>_API_URL etc. let us point a build at a local stack; never documented for customers. */
function overrideEndpoints(e: Endpoints): Endpoints {
  return {
    api: envVar("API_URL") ?? e.api,
    auth: envVar("AUTH_URL") ?? e.auth,
    mcp: envVar("MCP_URL") ?? e.mcp,
    app: envVar("APP_URL") ?? e.app,
    docs: envVar("DOCS_URL") ?? e.docs,
    id: envVar("ID_URL") ?? e.id,
  };
}

export function context(): RunContext {
  if (!ctx) return initContext({});
  return ctx;
}

export function setContext(patch: Partial<RunContext>): void {
  ctx = { ...context(), ...patch };
}
