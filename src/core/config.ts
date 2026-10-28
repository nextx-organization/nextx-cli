// ~/.config/<bin>/config.toml — preferences and profiles. Never holds tokens or keys (see credentials.ts).
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { parse, stringify } from "smol-toml";
import { configFile } from "./paths.js";
import type { EnvName } from "./brand.js";
import { envVar } from "./brand.js";

export type Mode = "read" | "propose" | "auto";
export type Lang = "vi" | "en";

export interface Profile {
  env: EnvName;
  workspaceId?: string;
  workspaceCode?: string;
  workspaceName?: string;
  userEmail?: string;
  userName?: string;
  agent?: string;
  /** Last conversation, for `-c`. */
  lastConversation?: string;
}

export interface Config {
  defaultProfile: string;
  lang?: Lang;
  mode?: Mode;
  updateChannel?: "latest" | "next";
  updateCheck?: boolean;
  telemetry?: boolean;
  color?: boolean;
  profiles: Record<string, Profile>;
}

const EMPTY: Config = { defaultProfile: "default", profiles: {} };

export function loadConfig(): Config {
  const f = configFile();
  if (!existsSync(f)) return structuredClone(EMPTY);
  const raw = parse(readFileSync(f, "utf8")) as Partial<Config>;
  return { ...structuredClone(EMPTY), ...raw, profiles: (raw.profiles ?? {}) as Record<string, Profile> };
}

export function saveConfig(c: Config): void {
  const f = configFile();
  const tmp = `${f}.tmp`;
  writeFileSync(tmp, stringify(c as unknown as Record<string, unknown>), { mode: 0o600 });
  renameSync(tmp, f);
}

/** Profile chosen by --profile, then <PREFIX>_PROFILE, then the configured default. */
export function profileName(flag?: string): string {
  return flag ?? envVar("PROFILE") ?? loadConfig().defaultProfile;
}

export function getProfile(name: string): Profile | undefined {
  return loadConfig().profiles[name];
}

export function updateProfile(name: string, patch: Partial<Profile>): Profile {
  const c = loadConfig();
  const next = { env: "prod" as EnvName, ...c.profiles[name], ...patch };
  c.profiles[name] = next;
  saveConfig(c);
  return next;
}

export function removeProfile(name: string): void {
  const c = loadConfig();
  delete c.profiles[name];
  saveConfig(c);
}

/** Dotted keys settable with `config set`. */
export const SETTABLE: Record<string, (v: string) => unknown> = {
  lang: (v) => (v === "en" ? "en" : "vi"),
  mode: (v) => {
    if (v !== "read" && v !== "propose" && v !== "auto") throw new Error("mode: read | propose | auto");
    return v;
  },
  updateChannel: (v) => (v === "next" ? "next" : "latest"),
  updateCheck: (v) => v !== "false" && v !== "0",
  telemetry: (v) => v !== "false" && v !== "0",
  color: (v) => v !== "false" && v !== "0",
  defaultProfile: (v) => v,
};
