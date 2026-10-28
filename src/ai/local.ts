// --model: the agent loop runs on this machine with the user's own model; tools come from the workspace's
// MCP server. Writes follow MCP rules (a proposal with a confirmation link), so the loop never writes by itself.
// Emits the same StreamChunk events as the platform assistant, so the REPL and -p render both the same way.
import Anthropic from "@anthropic-ai/sdk";
import { fetch } from "undici";
import { CliError, Exit } from "../core/errors.js";
import { tr, currentLang } from "../core/i18n.js";
import { brand } from "../core/brand.js";
import { getProfile } from "../core/config.js";
import { context } from "../core/context.js";
import { networkError, serverMessage, userAgent } from "../core/http.js";
import { McpClient, resultValue, type McpTool } from "../mcp/client.js";
import type { AskOutcome, StreamChunk } from "./client.js";
import type { ResolvedModel } from "./models.js";

const MAX_STEPS = 25;
/** Tool output beyond this is cut with a note; one report can otherwise fill the model's context. */
const MAX_RESULT_CHARS = 60_000;
/** Models that accept the server-side refusal fallback ("default" routing). */
const FALLBACK_MODELS = /^claude-(fable-5-1|opus-5-5|opus-5|sonnet-5-5)$/;

interface WireTool {
  wire: string;
  tool: McpTool;
}

type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ChatToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface LocalAskInput {
  text: string;
  signal?: AbortSignal;
  onChunk: (c: StreamChunk) => void;
}

/** Provider tool names allow [A-Za-z0-9_-] only; MCP names may carry dots. */
const wireName = (n: string) => n.replace(/[^A-Za-z0-9_-]/g, "__").slice(0, 64);

function systemPrompt(readOnly: boolean): string {
  const b = brand();
  const p = getProfile(context().profile);
  const lang = currentLang() === "en" ? "English" : "Vietnamese";
  return [
    `You are a terminal assistant for ${b.name}, working on the user's live workspace data through the tools provided.`,
    `Workspace: ${p?.workspaceName ?? p?.workspaceCode ?? "-"} (${context().env}). Today: ${new Date().toISOString().slice(0, 10)}.`,
    "Answer from tool results only; if no tool can answer, say so instead of guessing numbers.",
    readOnly
      ? "This session is read-only: do not try to change data."
      : "Tools that change data only create a proposal and return a confirmation link. Nothing is saved until the user opens the link and confirms. Show the link and say clearly that the change is not made yet.",
    `Reply in ${lang} unless the user writes in another language. Output is shown in a terminal: short paragraphs, plain Markdown lists and tables, no HTML.`,
  ].join("\n");
}

function resultText(r: Awaited<ReturnType<McpClient["callTool"]>>): string {
  const v = resultValue(r);
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > MAX_RESULT_CHARS ? `${s.slice(0, MAX_RESULT_CHARS)}\n[… ${s.length - MAX_RESULT_CHARS} more characters cut]` : s;
}

export class LocalChat {
  private readonly mcp: McpClient;
  private tools?: WireTool[];
  private readonly claudeHistory: Anthropic.Beta.BetaMessageParam[] = [];
  private readonly chatHistory: ChatMessage[] = [];
  private anthropic?: Anthropic;

  constructor(readonly model: ResolvedModel, interactive: boolean, private readonly readOnly = false) {
    this.mcp = new McpClient(interactive);
  }

  private async loadTools(): Promise<WireTool[]> {
    if (this.tools) return this.tools;
    const all = await this.mcp.listTools();
    const usable = this.readOnly ? all.filter((t) => t.annotations?.readOnlyHint) : all;
    const seen = new Set<string>();
    this.tools = usable
      .map((tool) => ({ wire: wireName(tool.name), tool }))
      .filter((t) => !seen.has(t.wire) && seen.add(t.wire));
    return this.tools;
  }

  private async runTool(wire: string, args: unknown, onChunk: LocalAskInput["onChunk"], outcome: AskOutcome): Promise<{ text: string; isError: boolean }> {
    const t = this.tools?.find((x) => x.wire === wire);
    if (!t) return { text: `Unknown tool ${wire}`, isError: true };
    const label = t.tool.annotations?.title ?? t.tool.title ?? t.tool.name;
    const started = Date.now();
    const activity = { kind: "tool", label, toolName: t.tool.name, elapsedMs: null as number | null };
    if (!args || typeof args !== "object" || Array.isArray(args)) return { text: "Tool input must be a JSON object.", isError: true };
    try {
      const r = await this.mcp.callTool(t.tool.name, args as Record<string, unknown>);
      activity.elapsedMs = Date.now() - started;
      outcome.activities.push(activity);
      onChunk({ type: "activity", activity });
      return { text: resultText(r), isError: !!r.isError };
    } catch (e) {
      // An expired MCP grant ends the turn; other failures go back to the model so it can adjust.
      if (e instanceof CliError && e.exitCode === Exit.auth) throw e;
      activity.elapsedMs = Date.now() - started;
      outcome.activities.push(activity);
      onChunk({ type: "activity", activity });
      return { text: (e as Error).message, isError: true };
    }
  }

  async ask(input: LocalAskInput): Promise<AskOutcome> {
    const tools = await this.loadTools();
    const outcome: AskOutcome = { text: "", notices: [], activities: [], ended: "done" };
    if (this.model.api === "anthropic") await this.askClaude(input, tools, outcome);
    else await this.askChat(input, tools, outcome);
    outcome.done = { type: outcome.ended, text: outcome.text };
    input.onChunk(outcome.done);
    return outcome;
  }

  // ── Anthropic Messages ───────────────────────────────────────────────────────────────────────────
  private async askClaude(input: LocalAskInput, tools: WireTool[], outcome: AskOutcome): Promise<void> {
    this.anthropic ??= new Anthropic({ apiKey: this.model.apiKey, baseURL: this.model.baseUrl, defaultHeaders: { "User-Agent": userAgent() } });
    const defs: Anthropic.Beta.BetaTool[] = tools.map((t) => ({
      name: t.wire,
      description: (t.tool.description ?? t.tool.title ?? t.tool.name).slice(0, 4000),
      input_schema: (t.tool.inputSchema ?? { type: "object", properties: {} }) as Anthropic.Beta.BetaTool.InputSchema,
    }));
    const fallback = FALLBACK_MODELS.test(this.model.model);
    this.claudeHistory.push({ role: "user", content: input.text });
    for (let step = 0; step < MAX_STEPS; step++) {
      let msg: Anthropic.Beta.BetaMessage;
      try {
        const stream = this.anthropic.beta.messages.stream(
          {
            model: this.model.model,
            max_tokens: 32_000,
            system: [{ type: "text", text: systemPrompt(this.readOnly), cache_control: { type: "ephemeral" } }],
            tools: defs,
            messages: this.claudeHistory,
            ...(fallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
          },
          { signal: input.signal },
        );
        stream.on("text", (d) => {
          outcome.text += d;
          input.onChunk({ type: "token", text: d });
        });
        msg = await stream.finalMessage();
      } catch (e) {
        throw anthropicError(e, input.signal);
      }
      // Append the whole content (thinking and fallback blocks included) so the next turn replays it unchanged.
      this.claudeHistory.push({ role: "assistant", content: msg.content });
      if (msg.stop_reason === "refusal") {
        outcome.notices.push({ code: "model_refusal", message: tr("Model từ chối trả lời câu này.", "The model declined to answer this.") });
        outcome.ended = "error";
        return;
      }
      const uses = msg.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
      if (msg.stop_reason === "max_tokens") {
        outcome.notices.push({ code: "model_max_tokens", message: tr("Câu trả lời bị cắt vì quá dài.", "The answer was cut off for length.") });
        // A tool call cut mid-input must not run; close it so the history stays valid.
        if (uses.length) this.claudeHistory.push({ role: "user", content: uses.map((u) => ({ type: "tool_result" as const, tool_use_id: u.id, content: "Not run: the call was cut off.", is_error: true })) });
        return;
      }
      if (msg.stop_reason === "pause_turn") continue;
      if (msg.stop_reason !== "tool_use" || !uses.length) return;
      if (outcome.text && !outcome.text.endsWith("\n")) {
        outcome.text += "\n";
        input.onChunk({ type: "token", text: "\n" });
      }
      const results = await Promise.all(uses.map((u) => this.runTool(u.name, u.input, input.onChunk, outcome)));
      this.claudeHistory.push({
        role: "user",
        content: uses.map((u, i) => ({ type: "tool_result" as const, tool_use_id: u.id, content: results[i]!.text, ...(results[i]!.isError ? { is_error: true } : {}) })),
      });
    }
    outcome.notices.push({ code: "model_steps", message: tr(`Dừng sau ${MAX_STEPS} bước gọi công cụ.`, `Stopped after ${MAX_STEPS} tool steps.`) });
  }

  // ── chat-completions (GPT, Gemini, Grok, Ollama) ─────────────────────────────────────────────────
  private async askChat(input: LocalAskInput, tools: WireTool[], outcome: AskOutcome): Promise<void> {
    const defs = tools.map((t) => ({
      type: "function" as const,
      function: { name: t.wire, description: (t.tool.description ?? t.tool.title ?? t.tool.name).slice(0, 1000), parameters: t.tool.inputSchema ?? { type: "object", properties: {} } },
    }));
    if (!this.chatHistory.length) this.chatHistory.push({ role: "system", content: systemPrompt(this.readOnly) });
    this.chatHistory.push({ role: "user", content: input.text });
    for (let step = 0; step < MAX_STEPS; step++) {
      const turn = await this.chatTurn(defs, input, outcome);
      this.chatHistory.push({ role: "assistant", content: turn.content || null, ...(turn.calls.length ? { tool_calls: turn.calls } : {}) });
      if (turn.finish === "length") {
        outcome.notices.push({ code: "model_max_tokens", message: tr("Câu trả lời bị cắt vì quá dài.", "The answer was cut off for length.") });
        for (const call of turn.calls) this.chatHistory.push({ role: "tool", tool_call_id: call.id, content: "Not run: the call was cut off." });
        return;
      }
      if (!turn.calls.length) return;
      if (outcome.text && !outcome.text.endsWith("\n")) {
        outcome.text += "\n";
        input.onChunk({ type: "token", text: "\n" });
      }
      const results = await Promise.all(
        turn.calls.map((call) => {
          let args: unknown;
          try {
            args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
          } catch {
            return Promise.resolve({ text: "Invalid JSON arguments; send a valid JSON object.", isError: true });
          }
          return this.runTool(call.function.name, args, input.onChunk, outcome);
        }),
      );
      turn.calls.forEach((call, i) => this.chatHistory.push({ role: "tool", tool_call_id: call.id, content: results[i]!.isError ? `ERROR: ${results[i]!.text}` : results[i]!.text }));
    }
    outcome.notices.push({ code: "model_steps", message: tr(`Dừng sau ${MAX_STEPS} bước gọi công cụ.`, `Stopped after ${MAX_STEPS} tool steps.`) });
  }

  private async chatTurn(defs: unknown[], input: LocalAskInput, outcome: AskOutcome): Promise<{ content: string; calls: ChatToolCall[]; finish?: string }> {
    const url = `${this.model.baseUrl}/chat/completions`;
    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream", "User-Agent": userAgent(), ...(this.model.apiKey ? { Authorization: `Bearer ${this.model.apiKey}` } : {}) },
        body: JSON.stringify({ model: this.model.model, messages: this.chatHistory, ...(defs.length ? { tools: defs } : {}), stream: true }),
        signal: input.signal,
      });
    } catch (e) {
      throw networkError(e, url);
    }
    if (!res.ok) {
      const body = await res.json().catch(() => undefined);
      throw providerError(this.model, res.status, serverMessage((body as { error?: unknown })?.error ?? body).message);
    }
    let content = "";
    let finish: string | undefined;
    const calls: ChatToolCall[] = [];
    const decoder = new TextDecoder();
    let buf = "";
    for await (const part of res.body ?? []) {
      buf += decoder.decode(part as Uint8Array, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        let ev: { choices?: { delta?: { content?: string | null; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] }; finish_reason?: string | null }[] };
        try {
          ev = JSON.parse(data);
        } catch {
          continue;
        }
        const ch = ev.choices?.[0];
        if (!ch) continue;
        if (ch.finish_reason) finish = ch.finish_reason;
        const d = ch.delta;
        if (d?.content) {
          content += d.content;
          outcome.text += d.content;
          input.onChunk({ type: "token", text: d.content });
        }
        for (const tc of d?.tool_calls ?? []) {
          const i = tc.index ?? calls.length;
          calls[i] ??= { id: tc.id ?? `call_${i}`, type: "function", function: { name: "", arguments: "" } };
          if (tc.id) calls[i]!.id = tc.id;
          if (tc.function?.name) calls[i]!.function.name += tc.function.name;
          if (tc.function?.arguments) calls[i]!.function.arguments += tc.function.arguments;
        }
      }
    }
    return { content, calls: calls.filter(Boolean), finish };
  }
}

function providerError(m: ResolvedModel, status: number, message?: string): CliError {
  const who = m.label;
  if (status === 401 || status === 403)
    return new CliError(tr(`${who}: khoá model bị từ chối.`, `${who}: the model key was rejected.`) + (message ? ` (${message})` : ""), Exit.auth, `${brand().bin} model add ${m.provider} --key-from-stdin`);
  if (status === 404) return new CliError(tr(`${who}: không có model này.`, `${who}: no such model.`) + (message ? ` (${message})` : ""), Exit.notFound);
  if (status === 429) return new CliError(tr(`${who}: nhà model đang giới hạn tốc độ hoặc hết hạn mức.`, `${who}: the provider is rate limiting or out of quota.`) + (message ? ` (${message})` : ""), Exit.quota);
  return new CliError(`${who}: HTTP ${status}${message ? ` ${message}` : ""}`, Exit.general);
}

function anthropicError(e: unknown, signal?: AbortSignal): unknown {
  if (signal?.aborted || e instanceof Anthropic.APIUserAbortError) return new CliError(tr("Đã dừng.", "Stopped."), Exit.interrupted);
  if (e instanceof Anthropic.APIConnectionError) return new CliError(tr("Không kết nối được tới nhà model.", "Could not reach the model provider."), Exit.network);
  if (e instanceof Anthropic.APIError) {
    const m = { provider: "claude", label: "claude" } as ResolvedModel;
    return providerError(m, e.status ?? 0, e.message);
  }
  return e;
}
