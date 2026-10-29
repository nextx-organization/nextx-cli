// Token storage: the OS keychain when available (macOS Keychain, Windows Credential Manager, libsecret),
// otherwise a 0600 JSON file. Model API keys (--model) are stored the same way under "model:<provider>".
import { existsSync, readFileSync, writeFileSync, renameSync, chmodSync } from "node:fs";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { brand } from "../core/brand.js";
import { credentialsFile } from "../core/paths.js";
import { t } from "../core/i18n.js";
import { warn } from "../core/output.js";

export interface Session {
  kind: "session";
  accessToken: string;
  refreshToken: string;
  /** Epoch ms when the access token expires. */
  expiresAt: number;
  userId: string;
  workspaceId: string;
  /** How it was obtained, for `status`. */
  via: "web" | "qr" | "device" | "password" | "ci";
  /** Server-side session id if known (for `sessions revoke`). */
  sessionId?: string;
}

interface KeyringEntry {
  getPassword(): string | null;
  setPassword(v: string): void;
  deletePassword(): boolean;
}
type KeyringModule = { Entry: new (service: string, account: string) => KeyringEntry };

/**
 * Standalone builds cannot ship the per-platform keychain addon. They talk to the OS tools instead, never
 * putting the secret on a command line: macOS `security -i` reads commands from stdin (value base64-encoded),
 * Linux `secret-tool store` reads the secret from stdin.
 */
function cliKeyring(): KeyringModule | null {
  // A keychain item written by another program makes macOS ask the user; never block a script on that dialog.
  const timeout = process.stdin.isTTY ? 30_000 : 3_000;
  const has = (cmd: string, args: string[]) => {
    const r = spawnSync(cmd, args, { stdio: "ignore" });
    return !r.error && r.status !== null;
  };
  if (process.platform === "darwin" && has("/usr/bin/security", ["help"])) {
    class MacEntry implements KeyringEntry {
      constructor(private s: string, private a: string) {}
      getPassword() {
        const r = spawnSync("/usr/bin/security", ["find-generic-password", "-s", this.s, "-a", this.a, "-w"], { encoding: "utf8", timeout });
        if (r.status !== 0) return null;
        const v = r.stdout.trim();
        return v.startsWith("b64:") ? Buffer.from(v.slice(4), "base64").toString("utf8") : v;
      }
      setPassword(v: string) {
        const enc = "b64:" + Buffer.from(v, "utf8").toString("base64");
        const r = spawnSync("/usr/bin/security", ["-i"], { input: `add-generic-password -U -s ${this.s} -a ${this.a} -w ${enc}\n`, encoding: "utf8", timeout });
        if (r.status !== 0) throw new Error(r.stderr || "security failed");
      }
      deletePassword() {
        return spawnSync("/usr/bin/security", ["delete-generic-password", "-s", this.s, "-a", this.a], { stdio: "ignore" }).status === 0;
      }
    }
    return { Entry: MacEntry };
  }
  if (process.platform === "linux" && (process.env.DBUS_SESSION_BUS_ADDRESS || process.env.DISPLAY) && has("secret-tool", ["--version"])) {
    class LinuxEntry implements KeyringEntry {
      constructor(private s: string, private a: string) {}
      getPassword() {
        const r = spawnSync("secret-tool", ["lookup", "service", this.s, "account", this.a], { encoding: "utf8", timeout });
        return r.status === 0 && r.stdout ? r.stdout : null;
      }
      setPassword(v: string) {
        const r = spawnSync("secret-tool", ["store", "--label", `${this.s} ${this.a}`, "service", this.s, "account", this.a], { input: v, encoding: "utf8", timeout });
        if (r.status !== 0) throw new Error(r.stderr || "secret-tool failed");
      }
      deletePassword() {
        return spawnSync("secret-tool", ["clear", "service", this.s, "account", this.a], { stdio: "ignore" }).status === 0;
      }
    }
    return { Entry: LinuxEntry };
  }
  return null;
}

let keyring: KeyringModule | null | undefined;
let warned = false;

function loadKeyring(): KeyringModule | null {
  if (keyring !== undefined) return keyring;
  if (process.env[`${brand().envPrefix}_NO_KEYCHAIN`] === "1") return (keyring = null);
  try {
    const require = createRequire(import.meta.url);
    const mod = require("@napi-rs/keyring") as KeyringModule;
    // Probe once: headless Linux without a secret service throws here.
    new mod.Entry(service(), "__probe__").getPassword();
    keyring = mod;
  } catch {
    try {
      keyring = cliKeyring();
      osTool = keyring !== null;
    } catch {
      keyring = null;
    }
  }
  return keyring;
}

/**
 * Each backend owns its own keychain items. Sharing one item between the addon (process "node") and the OS tool
 * (`security`) makes macOS move the item's access list to whoever wrote last, and every read by the other one
 * then pops a password dialog — several stacked dialogs when calls overlap.
 */
let osTool = false;
const service = () => `${brand().bin}-cli${osTool ? "-os" : ""}`;

function readFileStore(): Record<string, string> {
  const f = credentialsFile();
  if (!existsSync(f)) return {};
  try {
    return JSON.parse(readFileSync(f, "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

function writeFileStore(data: Record<string, string>): void {
  const f = credentialsFile();
  const tmp = `${f}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 1), { mode: 0o600 });
  renameSync(tmp, f);
  try {
    chmodSync(f, 0o600);
  } catch {
    // Windows ignores POSIX modes; the file lives under the user's profile.
  }
  if (!warned && process.env[`${brand().envPrefix}_NO_KEYCHAIN`] !== "1") {
    warned = true;
    warn(t("keychain.fallback", { file: f }));
  }
}

export function storageKind(): "keychain" | "file" {
  return loadKeyring() ? "keychain" : "file";
}

export function readSecret(account: string): string | undefined {
  const k = loadKeyring();
  if (k) {
    try {
      return new k.Entry(service(), account).getPassword() ?? undefined;
    } catch {
      return undefined;
    }
  }
  return readFileStore()[account];
}

export function writeSecret(account: string, value: string): void {
  const k = loadKeyring();
  if (k) {
    new k.Entry(service(), account).setPassword(value);
    return;
  }
  const s = readFileStore();
  s[account] = value;
  writeFileStore(s);
}

export function deleteSecret(account: string): void {
  const k = loadKeyring();
  if (k) {
    try {
      new k.Entry(service(), account).deletePassword();
    } catch {
      // already gone
    }
    return;
  }
  const s = readFileStore();
  if (account in s) {
    delete s[account];
    writeFileStore(s);
  }
}

export function readSession(profile: string): Session | undefined {
  const raw = readSecret(`session:${profile}`);
  if (!raw) return undefined;
  try {
    const s = JSON.parse(raw) as Session;
    return s.kind === "session" && s.accessToken && s.refreshToken ? s : undefined;
  } catch {
    return undefined;
  }
}

export function writeSession(profile: string, s: Session): void {
  writeSecret(`session:${profile}`, JSON.stringify(s));
}

export function deleteSession(profile: string): void {
  deleteSecret(`session:${profile}`);
}
