// The user's own model (--model): which providers exist, where their keys live, how a spec like
// "claude", "gpt/<name>" or "ollama/qwen3:32b" resolves. Keys stay in the keychain and never go to the platform.
import { CliError, Exit } from "../core/errors.js";
import { tr } from "../core/i18n.js";
import { brand } from "../core/brand.js";
import { loadConfig, saveConfig } from "../core/config.js";
import { readSecret, writeSecret, deleteSecret } from "../auth/credentials.js";

export type Provider = "claude" | "gemini" | "gpt" | "grok" | "ollama";

interface ProviderInfo {
  label: string;
  /** Wire protocol: Anthropic Messages, or the chat-completions shape the others share. */
  api: "anthropic" | "chat";
  baseUrl: string;
  keyEnv?: string;
  /** Model used when the spec names only the provider. Others must name the model once (`model add … --name`). */
  defaultModel?: string;
  needsKey: boolean;
}

// A→Z, no provider is favoured.
export const PROVIDERS: Record<Provider, ProviderInfo> = {
  claude: { label: "Claude (Anthropic)", api: "anthropic", baseUrl: "https://api.anthropic.com", keyEnv: "ANTHROPIC_API_KEY", defaultModel: "claude-opus-5-5", needsKey: true },
  gemini: { label: "Gemini (Google)", api: "chat", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", keyEnv: "GEMINI_API_KEY", needsKey: true },
  gpt: { label: "GPT (OpenAI)", api: "chat", baseUrl: "https://api.openai.com/v1", keyEnv: "OPENAI_API_KEY", needsKey: true },
  grok: { label: "Grok (xAI)", api: "chat", baseUrl: "https://api.x.ai/v1", keyEnv: "XAI_API_KEY", needsKey: true },
  ollama: { label: "Ollama (máy bạn / your machine)", api: "chat", baseUrl: "http://localhost:11434", needsKey: false },
};

export interface ModelEntry {
  provider: Provider;
  model?: string;
  url?: string;
}

export interface ResolvedModel {
  provider: Provider;
  api: ProviderInfo["api"];
  model: string;
  baseUrl: string;
  apiKey?: string;
  /** Shown in the header: "claude/claude-opus-5-5". */
  label: string;
}

type Stored = { models?: Record<string, ModelEntry>; defaultModel?: string };

const stored = (): Stored => loadConfig() as unknown as Stored;

function save(patch: (s: Stored) => void): void {
  const c = loadConfig();
  patch(c as unknown as Stored);
  saveConfig(c);
}

export const isProvider = (p: string): p is Provider => p in PROVIDERS;

export function listModels(): { name: string; entry: ModelEntry; hasKey: boolean; isDefault: boolean }[] {
  const s = stored();
  return Object.entries(s.models ?? {}).map(([name, entry]) => ({
    name,
    entry,
    hasKey: !PROVIDERS[entry.provider].needsKey || !!keyFor(entry.provider),
    isDefault: s.defaultModel === name,
  }));
}

export function addModel(provider: Provider, opts: { key?: string; model?: string; url?: string }): void {
  if (PROVIDERS[provider].needsKey && opts.key) writeSecret(`model:${provider}`, opts.key.trim());
  save((s) => {
    s.models = { ...s.models, [provider]: { provider, ...(opts.model ? { model: opts.model } : {}), ...(opts.url ? { url: opts.url.replace(/\/+$/, "") } : {}) } };
  });
}

export function removeModel(name: string): boolean {
  const s = stored();
  const entry = s.models?.[name];
  if (!entry) return false;
  deleteSecret(`model:${entry.provider}`);
  save((x) => {
    delete x.models?.[name];
    if (x.defaultModel === name) delete x.defaultModel;
  });
  return true;
}

export function setDefaultModel(name: string | undefined): void {
  save((s) => {
    if (name) s.defaultModel = name;
    else delete s.defaultModel;
  });
}

export const defaultModel = (): string | undefined => stored().defaultModel;

function keyFor(p: Provider): string | undefined {
  const env = PROVIDERS[p].keyEnv;
  return (env && process.env[env]) || readSecret(`model:${p}`);
}

/** The CLI's own command name (or "default") means the platform assistant: returns undefined. */
export function resolveModel(spec: string): ResolvedModel | undefined {
  const s = spec.trim();
  if (!s || s === brand().bin || s === "default") return undefined;
  const slash = s.indexOf("/");
  const head = slash < 0 ? s : s.slice(0, slash);
  const name = slash < 0 ? undefined : s.slice(slash + 1);
  if (!isProvider(head))
    throw new CliError(tr(`Không biết nhà model "${head}".`, `Unknown model provider "${head}".`), Exit.usage, tr(`Có: ${Object.keys(PROVIDERS).join(", ")} (vd --model ollama/qwen3:32b)`, `Available: ${Object.keys(PROVIDERS).join(", ")} (e.g. --model ollama/qwen3:32b)`));
  const info = PROVIDERS[head];
  const entry = stored().models?.[head];
  const model = name || entry?.model || info.defaultModel;
  if (!model)
    throw new CliError(tr(`Cần tên model cho ${head}.`, `Name the ${head} model.`), Exit.usage, `${brand().bin} --model ${head}/<model>  ·  ${brand().bin} model add ${head} --name <model>`);
  const apiKey = keyFor(head);
  if (info.needsKey && !apiKey)
    throw new CliError(tr(`Chưa có khoá ${info.label}.`, `No ${info.label} key yet.`), Exit.auth, `${brand().bin} model add ${head} --key-from-stdin${info.keyEnv ? tr(` (hoặc đặt ${info.keyEnv})`, ` (or set ${info.keyEnv})`) : ""}`);
  let baseUrl = entry?.url ?? info.baseUrl;
  if (head === "ollama") baseUrl = `${baseUrl.replace(/\/v1$/, "")}/v1`;
  return { provider: head, api: info.api, model, baseUrl, apiKey, label: `${head}/${model}` };
}
