// NextFarm assistant contract. Same exported shapes as client.ts, different server:
//   POST /ai/agent-runs → GET /ai/agent-runs/{id}/events (SSE, resumable with Last-Event-ID)
//   POST /ai/action-proposals/{id}/decision|undo (Idempotency-Key required)
// REST bodies are snake_case both ways; SSE event payloads are camelCase.
import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { basename, extname } from "node:path";
import { FormData } from "undici";
import { get, post, patch, del, requestRaw, errorFor } from "../core/http.js";
import { CliError, Exit } from "../core/errors.js";
import { currentLang, tr } from "../core/i18n.js";
import type {
  ActivityDto, AnswerBlock, AskInput, AskOutcome, Attachment, ConfirmResult, Conversation, InitResult, ProposedAction, Risk, StreamChunk,
} from "./client.js";

type Json = Record<string, unknown>;

/** First present key, snake or camel. */
function pick<T = unknown>(o: unknown, ...keys: string[]): T | undefined {
  if (!o || typeof o !== "object") return undefined;
  for (const k of keys) if ((o as Json)[k] !== undefined && (o as Json)[k] !== null) return (o as Json)[k] as T;
  return undefined;
}

// ── Conversations ───────────────────────────────────────────────────────────────────────────────────

/** A new conversation is created by the first run; "" means "start one". */
export const openConversation = async (_forceNew: boolean): Promise<InitResult> =>
  ({ sessionId: "", greeting: "", suggestedQuestions: [], status: "active" });

export async function listConversations(limit = 30): Promise<Conversation[]> {
  const r = await get<Json>("/ai/conversations", { query: { page: 1, page_size: Math.min(limit, 50) } });
  return (pick<Json[]>(r, "items") ?? []).map((x) => ({
    sessionId: String(pick(x, "conversation_id", "conversationId")),
    title: pick<string>(x, "title") ?? null,
    lastPreview: pick<string>(x, "title") ?? null,
    isPinned: Boolean(pick(x, "pinned")),
    status: pick<string>(x, "status"),
    updatedAt: String(pick(x, "last_message_at", "lastMessageAt", "updated_at", "updatedAt") ?? ""),
  }));
}

export const renameConversation = (id: string, title: string | null) => patch(`/ai/conversations/${id}`, { title: title ?? "" });
export const pinConversation = (id: string, pinned: boolean) => patch(`/ai/conversations/${id}`, { pinned });
export const deleteConversation = (id: string) => del(`/ai/conversations/${id}`);

export async function history(sessionId: string): Promise<InitResult["messages"]> {
  if (!sessionId) return [];
  const r = await get<Json>(`/ai/conversations/${sessionId}`);
  return (pick<Json[]>(r, "messages") ?? []).map((m) => ({
    id: String(pick(m, "message_id", "messageId")),
    role: pick<string>(m, "role") === "user" ? "User" : "Assistant",
    text: pick<string>(m, "text") ?? "",
    createdAt: String(pick(m, "created_at", "createdAt") ?? ""),
  }));
}

/** NextFarm rates a whole run, so `messageId` here is the run id (see `done.messageId` below). */
export const feedback = (runId: string, helpful: boolean) => post(`/ai/agent-runs/${runId}/feedback`, { rating: helpful ? "up" : "down" });

export const escalate = async (_sessionId: string, _topic: string): Promise<{ estimatedWaitMinutes: number; status: string }> => {
  throw new CliError(tr("NextFarm chưa có chuyển cho nhân viên hỗ trợ từ terminal.", "Handing over to a support agent is not available for NextFarm yet."), Exit.general);
};

export async function usage() {
  const q = await get<Json>("/ai/assistant/quota");
  const limit = Number(pick(q, "limit") ?? 0);
  return {
    planName: tr("Tuần này", "This week"),
    used: Number(pick(q, "used") ?? 0),
    limit,
    remaining: Number(pick(q, "remaining") ?? 0),
    resetsAt: nextMondayVietnam(),
    enforced: limit > 0,
  };
}

/** The weekly quota resets at 00:00 Monday, Vietnam time (UTC+7). */
export function nextMondayVietnam(now = new Date()): string {
  const vn = new Date(now.getTime() + 7 * 3600_000);
  const days = ((8 - vn.getUTCDay()) % 7) || 7;
  const d = new Date(Date.UTC(vn.getUTCFullYear(), vn.getUTCMonth(), vn.getUTCDate() + days));
  return `${d.toISOString().slice(0, 10)}T00:00:00+07:00`;
}

// ── Attachments ─────────────────────────────────────────────────────────────────────────────────────

const IMAGE: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };
const DOCUMENT: Record<string, string> = {
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".csv": "text/csv",
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};
const MAX_BYTES = 10 * 1024 * 1024;

/** Images go to /ai/attachments, documents to /ai/files; both return an id the run references. */
export async function attachBinary(path: string, kind: "table" | "image"): Promise<Attachment> {
  const name = basename(path);
  const ext = extname(path).toLowerCase();
  const size = statSync(path).size;
  if (size > MAX_BYTES) throw new CliError(tr("Tệp quá lớn (tối đa 10 MB).", "File too large (max 10 MB)."), Exit.usage);
  const type = kind === "image" ? IMAGE[ext] : DOCUMENT[ext];
  if (!type) throw new CliError(tr(`Chưa hỗ trợ ${ext}.`, `Unsupported ${ext}.`), Exit.usage);
  const form = new FormData();
  form.append("file", new Blob([readFileSync(path)], { type }), name);
  const r = await post<Json>(kind === "image" ? "/ai/attachments" : "/ai/files", form);
  const id = String(pick(r, "attachment_id", "attachmentId", "id"));
  return kind === "image"
    ? { path, name, kind, imageKey: id, summary: `${Math.round(size / 1024)} KB` }
    : { path, name, kind, fileKey: id, summary: `${Math.round(size / 1024)} KB` };
}

export const isDocument = (path: string) => extname(path).toLowerCase() in DOCUMENT;

// ── Ask ─────────────────────────────────────────────────────────────────────────────────────────────

interface RunEvent {
  id?: string;
  runId?: string;
  sequence?: number;
  type: string;
  payload?: Json;
}

/** Last proposal written from this process — `/undo` without an id targets it. */
export let lastWritten: { proposalId: string; label: string } | undefined;

export async function ask(input: AskInput): Promise<AskOutcome> {
  const attachmentIds = [...new Set(input.attachments?.flatMap((a) => [a.imageKey, a.fileKey]).filter(Boolean) ?? [])];
  const created = await post<Json>("/ai/agent-runs", {
    message: input.text,
    route_key: "assistant.orchestrate",
    app_id: "farm",
    locale: currentLang(),
    conversation_id: input.sessionId || null,
    client_request_id: randomUUID(),
    attachment_ids: attachmentIds,
  }, { signal: input.signal });
  const runId = String(pick(created, "run_id", "runId", "id"));
  const outcome: AskOutcome = {
    text: "", notices: [], activities: [], ended: "error", runId,
    sessionId: String(pick(created, "conversation_id", "conversationId") ?? input.sessionId ?? ""),
  };
  const proposals: ProposedAction[] = [];

  // The run lives on the server; a dropped stream reconnects from the last event instead of asking again.
  let lastEventId: string | undefined;
  for (let attempt = 0; ; attempt++) {
    if (attempt > 0) {
      if (attempt > 5) throw new CliError(tr("Mất kết nối giữa chừng.", "Connection lost mid-answer."), Exit.network);
      input.onRetry?.(attempt);
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
    try {
      const res = await requestRaw("GET", `/ai/agent-runs/${runId}/events`, {
        signal: input.signal,
        headers: { Accept: "text/event-stream", ...(lastEventId ? { "Last-Event-ID": lastEventId } : {}) },
      });
      if (!res.ok) throw errorFor(res.status, await res.json().catch(() => undefined), res);
      if (!res.body) throw new CliError(tr("Máy chủ trả luồng rỗng.", "Empty stream from server."), Exit.general);
      for await (const ev of events(res.body)) {
        lastEventId = ev.id ?? lastEventId;
        const chunk = toChunk(ev, outcome, proposals);
        if (chunk) input.onChunk(chunk);
        if (outcome.done) {
          outcome.proposedAction = proposals[0];
          if (proposals.length > 1)
            outcome.notices.push({ code: "proposals", message: tr(`Còn ${proposals.length - 1} đề xuất khác — xem trong app.`, `${proposals.length - 1} more proposals — see the app.`) });
          return outcome;
        }
      }
      throw new CliError(tr("Mất kết nối giữa chừng.", "Connection lost mid-answer."), Exit.network);
    } catch (e) {
      if (input.signal?.aborted) {
        await post(`/ai/agent-runs/${runId}/cancel`, {}).catch(() => undefined);
        throw e;
      }
      if (!(e instanceof CliError) || e.exitCode !== Exit.network) throw e;
    }
  }
}

function toChunk(ev: RunEvent, out: AskOutcome, proposals: ProposedAction[]): StreamChunk | undefined {
  const p = ev.payload ?? {};
  switch (ev.type) {
    case "progress.updated": {
      const activity: ActivityDto = { kind: "tool", label: String(p.label ?? ""), toolName: (p.toolName as string) ?? null };
      if (p.completed) return undefined;
      out.activities.push(activity);
      return { type: "activity", activity, runId: out.runId };
    }
    case "assistant.message_delta": {
      // Leading blank deltas would print empty lines before the answer.
      const delta = out.text ? String(p.delta ?? "") : String(p.delta ?? "").trimStart();
      if (!delta) return undefined;
      out.text += delta;
      return { type: "token", text: delta };
    }
    case "assistant.message_completed": {
      const text = String(pick(p.message, "text") ?? "");
      // Some answers arrive whole, without deltas.
      if (!out.text && text) {
        out.text = text;
        return { type: "token", text };
      }
      return undefined;
    }
    case "action.approval_required":
      proposals.push(toProposal(String(p.proposalId), String(p.actionType), p.proposal));
      return undefined;
    case "ui.action_requested": {
      // Clarifying question: { action: "ask", label, value: '{"options":[…]}' }. Options become numbered follow-ups (type 1, 2, 3).
      if (p.action !== "ask" || typeof p.label !== "string") return undefined;
      let options: string[] = [];
      try {
        options = ((JSON.parse(String(p.value ?? "{}")) as { options?: unknown[] }).options ?? []).filter((x): x is string => typeof x === "string");
      } catch {
        // question without options
      }
      out.followUps = options;
      const text = `${out.text ? "\n\n" : ""}${p.label.trim()}${options.map((o, i) => `\n  ${i + 1}. ${o}`).join("")}`;
      out.text += text;
      return { type: "token", text };
    }
    case "run.completed":
    case "run.awaiting_user":
      out.ended = "done";
      out.done = { type: "done", messageId: out.runId, runId: out.runId, followUps: out.followUps ?? [] };
      return out.done;
    case "run.cancelled":
    case "run.failed": {
      const message = String(p.errorMessage ?? (ev.type === "run.cancelled" ? tr("Đã dừng.", "Stopped.") : tr("Trợ lý gặp lỗi, thử lại.", "The assistant failed, try again.")));
      out.ended = "error";
      out.done = { type: "error", code: String(p.errorCode ?? ev.type), message, text: message, runId: out.runId };
      if (!out.text) out.text = message;
      return out.done;
    }
    default:
      return undefined;
  }
}

async function* events(stream: AsyncIterable<Uint8Array>): AsyncGenerator<RunEvent> {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const part of stream) {
    buf += decoder.decode(part, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const data = frame.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
      if (!data) continue;
      try {
        yield JSON.parse(data) as RunEvent;
      } catch {
        // heartbeat or partial frame
      }
    }
  }
}

// ── Proposals ───────────────────────────────────────────────────────────────────────────────────────

/** Line kinds that move money or touch devices: never confirmed from the terminal (the server enforces it too). */
const FINANCE_KINDS = new Set(["cash", "settlement", "purchase_slip"]);

function kindsOf(v: unknown, acc: string[] = []): string[] {
  if (Array.isArray(v)) for (const x of v) kindsOf(x, acc);
  else if (v && typeof v === "object")
    for (const [k, x] of Object.entries(v)) {
      if (k === "kind" && typeof x === "string") acc.push(x);
      else kindsOf(x, acc);
    }
  return acc;
}

function entriesOf(v: unknown): Json[] {
  if (!v || typeof v !== "object") return [];
  if (Array.isArray((v as Json).entries)) return (v as Json).entries as Json[];
  for (const x of Object.values(v)) {
    const found = entriesOf(x);
    if (found.length) return found;
  }
  return [];
}

export function riskOfNextFarm(actionType: string, proposal: unknown): Risk {
  if (/^(automation|iot|drone)\./.test(actionType)) return "device";
  const kinds = kindsOf(proposal);
  if (kinds.some((k) => k.startsWith("iot_"))) return "device";
  if (kinds.some((k) => FINANCE_KINDS.has(k))) return "finance";
  if (entriesOf(proposal).length > 20 || kinds.some((k) => /close|return|delete|remove/.test(k))) return "large";
  return "normal";
}

function toProposal(proposalId: string, actionType: string, proposal: unknown): ProposedAction {
  const entries = entriesOf(proposal);
  const summary = pick<string>(proposal, "summary", "title") ?? "";
  const lines = entries.length
    ? entries.map((e) => `+ ${pick<string>(e, "label") ?? pick<string>(pick(e, "display"), "title") ?? pick<string>(e, "kind") ?? ""}`)
    : summary ? [] : [JSON.stringify(proposal).slice(0, 300)];
  return {
    kind: actionType,
    label: summary || (entries.length ? tr(`Ghi ${entries.length} mục`, `Write ${entries.length} entries`) : actionType),
    confirmPrompt: lines.join("\n"),
    payloadJson: JSON.stringify(proposal ?? {}),
    writes: true,
    nonce: proposalId,
    recipientCount: entries.length > 1 ? entries.length : null,
    risk: riskOfNextFarm(actionType, proposal),
  };
}

const EXECUTED = new Set(["succeeded", "partial"]);

export async function confirmAction(_sessionId: string, a: ProposedAction): Promise<ConfirmResult> {
  const r = await post<Json>(`/ai/action-proposals/${a.nonce}/decision`, { approved: true }, { idempotencyKey: true });
  const execution = String(pick(r, "execution") ?? "");
  const lines = pick<Json[]>(r, "lines") ?? [];
  const ok = lines.filter((l) => pick(l, "status") === "succeeded").length;
  const failed = lines.filter((l) => ["failed", "outcome_unknown"].includes(String(pick(l, "status")))).length;
  const success = EXECUTED.has(execution);
  const codes = [...new Set(lines.filter((l) => pick(l, "code")).map((l) => String(pick(l, "code"))))];
  if (success) lastWritten = { proposalId: a.nonce, label: a.label };
  const message = execution === "deterministic_command_required"
    ? tr("Đã ghi nhận đồng ý. Việc này hoàn tất trong app NextFarm.", "Approval recorded. Finish this in the NextFarm app.")
    : success
      ? tr(`Đã ghi ${ok || lines.length} mục${failed ? `, ${failed} mục lỗi — xem trong app` : ""}.`, `Wrote ${ok || lines.length} entries${failed ? `, ${failed} failed — check the app` : ""}.`)
      : tr(`Chưa ghi được (${[execution || "không rõ", ...codes].join(" · ")}).`, `Not written (${[execution || "unknown", ...codes].join(" · ")}).`);
  return { success, message, messageId: a.nonce, kind: a.kind, writes: true };
}

export async function rejectAction(proposalId: string): Promise<void> {
  await post(`/ai/action-proposals/${proposalId}/decision`, { approved: false }, { idempotencyKey: true });
}

/** What `/undo` would revert: the given proposal, or the last one written from this process. */
export function undoTarget(proposalId?: string): { proposalId: string; label: string } {
  const target = proposalId ? { proposalId, label: proposalId.slice(0, 8) } : lastWritten;
  if (!target) throw new CliError(tr("Chưa có lần ghi nào trong phiên này để hoàn tác.", "Nothing written in this session to undo."), Exit.notFound);
  return target;
}

export async function undo(target: { proposalId: string }): Promise<string> {
  const r = await post<Json>(`/ai/action-proposals/${target.proposalId}/undo`, {}, { idempotencyKey: true });
  const undone = (pick<Json[]>(r, "lines") ?? []).filter((l) => pick(l, "undone")).length;
  return tr(`Đã hoàn tác${undone ? ` ${undone} mục` : ""}.`, `Undone${undone ? ` ${undone} entries` : ""}.`);
}

// ── Run trace, memory, schedules, brief ─────────────────────────────────────────────────────────────

export async function runTrace(runId: string): Promise<string[]> {
  const r = await get<Json>(`/ai/agent-runs/${runId}`);
  const status = String(pick(r, "status") ?? "");
  const steps = (pick<Json[]>(r, "activities", "progress") ?? []).map((s, i) => `  ${i + 1}. ${pick<string>(s, "label") ?? ""}${pick(s, "tool_name", "toolName") ? ` · ${pick(s, "tool_name", "toolName")}` : ""}`);
  return [`  ${tr("Lượt", "Run")} ${runId.slice(0, 8)} · ${status}`, ...(steps.length ? steps : [tr("  (không có bước công cụ)", "  (no tool steps)")])];
}

export interface MemoryItem { id: string; display: string; kind: string; uses: number }

export async function memories(): Promise<{ canDelete: boolean; items: MemoryItem[] }> {
  const r = await get<Json>("/ai/memories");
  return {
    canDelete: Boolean(pick(r, "can_delete", "canDelete")),
    items: (pick<Json[]>(r, "items") ?? []).map((m) => ({
      id: String(pick(m, "id")),
      display: `${pick(m, "key") ?? ""}: ${pick(m, "value") ?? ""}`,
      kind: String(pick(m, "kind") ?? ""),
      uses: Number(pick(m, "use_count", "useCount") ?? 0),
    })),
  };
}

export const forgetMemory = (id: string) => del(`/ai/memories/${id}`);

export interface Schedule { id: string; title: string; when: string; nextRunAt: string; enabled: boolean }

export async function schedules(): Promise<Schedule[]> {
  const r = await get<Json[] | Json>("/ai/scheduled-prompts");
  const list = Array.isArray(r) ? r : (pick<Json[]>(r, "items") ?? []);
  return list.map((s) => ({
    id: String(pick(s, "id")),
    title: String(pick(s, "title", "prompt") ?? ""),
    when: `${(pick<number[]>(s, "days_of_week", "daysOfWeek") ?? []).length ? `${tr("thứ", "days")} ${(pick<number[]>(s, "days_of_week", "daysOfWeek") ?? []).join(",")}` : tr("hằng ngày", "daily")} ${pick(s, "time_of_day", "timeOfDay") ?? ""}`,
    nextRunAt: String(pick(s, "next_run_at", "nextRunAt") ?? ""),
    enabled: pick(s, "enabled") !== false,
  }));
}

/** daily → every day; weekly N → ISO weekday N (1 = Monday). Running in the background needs the app's one-time consent. */
export async function createSchedule(question: string, frequency: "daily" | "weekly", timeOfDay: string, day?: number): Promise<Schedule> {
  const r = await post<Json>("/ai/scheduled-prompts", {
    title: question.slice(0, 60), question, time_of_day: timeOfDay, days_of_week: frequency === "weekly" ? [day ?? 1] : [], channels: ["app"], enabled: true,
  });
  return (await schedules()).find((x) => x.id === String(pick(r, "id"))) ?? { id: String(pick(r, "id")), title: question, when: timeOfDay, nextRunAt: "", enabled: true };
}

export const runSchedule = (id: string) => post(`/ai/scheduled-prompts/${id}/run`, {});
export const deleteSchedule = (id: string) => del(`/ai/scheduled-prompts/${id}`);

/** Latest morning brief, or undefined when none was sent yet. */
export async function latestBrief(): Promise<{ title: string; text: string; createdAt: string } | undefined> {
  const r = await get<Json | undefined>("/ai/briefs/latest");
  if (!r) return undefined;
  return {
    title: String(pick(r, "title", "subject") ?? tr("Bản tin sáng", "Morning brief")),
    text: String(pick(r, "text", "body", "content", "summary") ?? ""),
    createdAt: String(pick(r, "created_at", "createdAt") ?? ""),
  };
}

export type { AnswerBlock };
