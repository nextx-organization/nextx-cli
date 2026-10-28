import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { brand } from "./brand.js";

function base(kind: "config" | "state"): string {
  const b = brand().bin;
  if (process.platform === "win32") {
    const root = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
    return join(root, b, kind === "state" ? "state" : "");
  }
  if (kind === "config") return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), b);
  return join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), b);
}

export function configDir(): string {
  const d = base("config");
  mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
}

export function stateDir(): string {
  const d = base("state");
  mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
}

export const configFile = () => join(configDir(), "config.toml");
export const credentialsFile = () => join(configDir(), "credentials.json");
export const historyFile = () => join(stateDir(), "history");
export const lockFile = (profile: string) => join(stateDir(), `${profile}.lock`);
export const updateCheckFile = () => join(stateDir(), "update-check.json");
