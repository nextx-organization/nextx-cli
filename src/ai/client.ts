// Chat with the platform assistant over SSE. Shared by `-p` and the REPL.
import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { basename, extname } from "node:path";
import { fetch } from "undici";
import { get, post, put, patch, del, requestRaw, errorFor, networkError } from "../core/http.js";
import { CliError, Exit } from "../core/errors.js";
import { tr } from "../core/i18n.js";
import { brand } from "../core/brand.js";
import * as nf from "./nextfarm.js";

/** NextFarm talks to its own assistant API (see nextfarm.ts); the other brands share this file's contract. */
const farm = () => brand().platform === "nextfarm";

const BASE = "/operator/widget/support";

export interface ActivityDto {
  kind: "tool" | "reasoning" | string;
  label: string;
  toolName?: string | null;
  elapsedMs?: number | null;
}

export interface AnswerBlock {
  type: string;
  text?: string | null;
  steps?: string[] | null;
  label?: string | null;
  routeHint?: string | null;
  module?: string | null;
  url?: string | null;
  columns?: { key?: string; label?: string; name?: string; type?: string }[] | null;
  rows?: unknown;
  total?: number | null;
  entity?: string | null;
  expiresAt?: string | null;
}

export interface ProposedAction {
  kind: string;
  label: string;
  confirmPrompt: string;
  payloadJson: string;
  writes: boolean;
  nonce: string;
  expiresAt?: string | null;
  recipientCount?: number | null;
  estimatedCost?: number | null;
  costCurrency?: string | null;
  proposalJson?: string | null;
  /** Set by platforms that know the risk better than the kind regex (NextFarm: per entry line). */
  risk?: Risk;
}

export interface AgentDto {
  code: string;
  name: string;
  source: string;
  requestedDenied: boolean;
}

export interface StreamChunk {
  type: "activity" | "agent" | "token" | "notice" | "done" | "error" | "escalate" | "delivered_to_agent" | "low_confidence" | string;
  text?: string | null;
  messageId?: string | null;
  followUps?: string[] | null;
  confidence?: string;
  blocks?: AnswerBlock[] | null;
  proposedAction?: ProposedAction | null;
  activity?: ActivityDto | null;
  clarify?: { question: string; options: { label: string; value?: string; text?: string }[] } | null;
  runId?: string | null;
  code?: string | null;
  message?: string | null;
  agent?: AgentDto | null;
  source?: { kind: string; title: string; routeHint?: string | null } | null;
}

export interface Conversation {
  sessionId: string;
  lastPreview?: string | null;
  status?: string;
  topic?: string | null;
  updatedAt: string;
  title?: string | null;
  isPinned?: boolean;
  agentCode?: string | null;
}

export interface InitResult {
  sessionId: string;
  greeting: string;
  suggestedQuestions: string[];
  status: string;
  messages?: { id: string; role: string; text: string; createdAt: string; blocks?: AnswerBlock[] | null }[] | null;
}

export const openConversation = (forceNew: boolean) => farm() ? nf.openConversation(forceNew) : post<InitResult>(`${BASE}/init`, { forceNew });
export const listConversations = (limit = 30) => farm() ? nf.listConversations(limit) : get<Conversation[]>(`${BASE}/conversations`, { query: { limit } });
export const renameConversation = (id: string, title: string | null) => farm() ? nf.renameConversation(id, title) : patch(`${BASE}/conversations/${id}/title`, { title });
export const pinConversation = (id: string, pinned: boolean) => farm() ? nf.pinConversation(id, pinned) : put(`${BASE}/conversations/${id}/pin`, { pinned });
export const deleteConversation = (id: string) => farm() ? nf.deleteConversation(id) : del(`${BASE}/conversations/${id}`);
export const history = (sessionId: string) => farm() ? nf.history(sessionId) : get<InitResult["messages"]>(`${BASE}/history`, { query: { sessionId } });
export const feedback = (messageId: string, helpful: boolean) => farm() ? nf.feedback(messageId, helpful) : post(`${BASE}/messages/${messageId}/feedback`, { helpful });
export const escalate = (sessionId: string, topic: string) => farm() ? nf.escalate(sessionId, topic) : post<{ estimatedWaitMinutes: number; status: string }>(`${BASE}/escalate`, { sessionId, topic });
export const usage = (): Promise<{ planName?: string; used?: number; limit?: number; remaining?: number; resetsAt?: string; enforced?: boolean }> =>
  farm() ? nf.usage() : get(`${BASE}/usage`);

export interface ConfirmResult {
  success: boolean;
  message: string;
  messageId: string;
  kind: string;
  writes: boolean;
  resultJson?: string | null;
  blocks?: AnswerBlock[] | null;
}

export const confirmAction = (sessionId: string, a: ProposedAction): Promise<ConfirmResult> => farm() ? nf.confirmAction(sessionId, a) :
  post<ConfirmResult>(`${BASE}/${sessionId}/confirm-action`, { kind: a.kind, payloadJson: a.payloadJson, nonce: a.nonce });

// ── Attachments ─────────────────────────────────────────────────────────────────────────────────────

export interface Attachment {
  path: string;
  name: string;
  kind: "table" | "image" | "text";
  fileKey?: string;
  imageKey?: string;
  /** For text files: content inlined into the question. */
  text?: string;
  summary?: string;
}

const TABLE = new Set([".xlsx", ".csv"]);
const IMAGE: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };
const TEXT = new Set([".txt", ".md", ".json", ".log", ".yml", ".yaml", ".tsv", ".xml", ".html", ".sql"]);
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_TEXT = 20_000;

export function attachmentKind(path: string): Attachment["kind"] | undefined {
  const ext = extname(path).toLowerCase();
  if (farm() && nf.isDocument(path)) return "table";
  if (TABLE.has(ext)) return "table";
  if (ext in IMAGE) return "image";
  if (TEXT.has(ext)) return "text";
  return undefined;
}

async function putFile(url: string, body: Buffer, contentType: string): Promise<void> {
  let res;
  try {
    res = await fetch(url, { method: "PUT", body, headers: { "Content-Type": contentType } });
  } catch (e) {
    throw networkError(e, url);
  }
  if (!res.ok) throw new CliError(tr(`Tải tệp lên thất bại (HTTP ${res.status}).`, `Upload failed (HTTP ${res.status}).`), Exit.general);
}

export async function attach(path: string, sessionId?: string): Promise<Attachment> {
  const kind = attachmentKind(path);
  const name = basename(path);
  if (!kind)
    throw new CliError(
      tr(`Chưa hỗ trợ loại tệp ${extname(path) || name}. Dùng .xlsx/.csv, ảnh .png/.jpg/.webp, hoặc tệp chữ (.txt .md .json …).`,
        `Unsupported file type ${extname(path) || name}. Use .xlsx/.csv, .png/.jpg/.webp images, or text files (.txt .md .json …).`),
      Exit.usage,
    );
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    throw new CliError(tr(`Không đọc được tệp ${path}.`, `Cannot read ${path}.`), Exit.usage);
  }
  if (kind === "text") {
    const raw = readFileSync(path, "utf8");
    const cut = raw.length > MAX_TEXT;
    return { path, name, kind, text: cut ? raw.slice(0, MAX_TEXT) : raw, summary: tr(`${raw.length.toLocaleString("vi-VN")} ký tự${cut ? ", đã cắt" : ""}`, `${raw.length} chars${cut ? ", truncated" : ""}`) };
  }
  if (farm()) return nf.attachBinary(path, kind);
  if (size > MAX_BYTES) throw new CliError(tr("Tệp quá lớn (tối đa 10 MB).", "File too large (max 10 MB)."), Exit.usage);
  const body = readFileSync(path);
  if (kind === "table") {
    const ct = extname(path).toLowerCase() === ".csv" ? "text/csv" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    const up = await post<{ storageKey: string; uploadUrl: string }>(`${BASE}/files/upload-url`, { fileName: name, contentType: ct, fileSizeBytes: size });
    await putFile(up.uploadUrl, body, ct);
    const s = await post<{ fileId: string; rowCount: number; columnCount: number }>(`${BASE}/files/extract`, { storageKey: up.storageKey, fileName: name, sessionId });
    return { path, name, kind, fileKey: s.fileId, summary: `${s.rowCount.toLocaleString("vi-VN")} × ${s.columnCount}` };
  }
  const ct = IMAGE[extname(path).toLowerCase()]!;
  const up = await post<{ storageKey: string; uploadUrl: string }>("/operator/nextx-ai/attachments/upload-url", { fileName: name, contentType: ct, fileSizeBytes: size });
  await putFile(up.uploadUrl, body, ct);
  return { path, name, kind, imageKey: up.storageKey, summary: `${Math.round(size / 1024)} KB` };
}

/** Text attachments and NEXTX.md are sent inline, clearly delimited, after the user's question. */
export function composeText(question: string, attachments: Attachment[], projectNotes?: string): string {
  const parts = [question];
  for (const a of attachments.filter((x) => x.kind === "text"))
    parts.push(`\n\n--- ${tr("Tệp", "File")} ${a.name} ---\n${a.text}\n--- ${tr("Hết tệp", "End of file")} ---`);
  if (projectNotes) parts.push(`\n\n--- ${tr(`Chỉ dẫn của dự án (${brand().bin.toUpperCase()}.md)`, `Project instructions (${brand().bin.toUpperCase()}.md)`)} ---\n${projectNotes}\n---`);
  return parts.join("");
}

// ── Streaming ask ───────────────────────────────────────────────────────────────────────────────────

export interface AskInput {
  sessionId: string;
  text: string;
  attachments?: Attachment[];
  agent?: string;
  signal?: AbortSignal;
  onChunk: (c: StreamChunk) => void;
  /** Called before a reconnect attempt (UI shows "reconnecting…"). */
  onRetry?: (attempt: number) => void;
}

export interface AskOutcome {
  text: string;
  done?: StreamChunk;
  runId?: string;
  agent?: AgentDto;
  notices: { code: string; message: string }[];
  activities: ActivityDto[];
  proposedAction?: ProposedAction;
  ended: "done" | "error" | "escalate" | "delivered_to_agent";
  /** Conversation the answer belongs to, when the server created one for this question (NextFarm). */
  sessionId?: string;
  /** Choices of a clarifying question, offered as numbered follow-ups (NextFarm). */
  followUps?: string[];
}

/**
 * Sends one question and streams the answer. If the connection drops, the same Idempotency-Key is resent,
 * so the server replays the stored answer instead of answering (and charging) twice.
 */
export async function ask(input: AskInput): Promise<AskOutcome> {
  if (farm()) return nf.ask(input);
  const key = randomUUID();
  const body = {
    sessionId: input.sessionId,
    text: input.text,
    imageKeys: input.attachments?.filter((a) => a.imageKey).map((a) => a.imageKey) ?? undefined,
    fileKeys: input.attachments?.filter((a) => a.fileKey).map((a) => a.fileKey) ?? undefined,
    agentCode: input.agent,
    clientPlatform: "cli",
  };
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      input.onRetry?.(attempt);
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
    const outcome: AskOutcome = { text: "", notices: [], activities: [], ended: "error" };
    try {
      const res = await requestRaw("POST", `${BASE}/ask/stream`, { body, idempotencyKey: key, signal: input.signal });
      if (!res.ok) {
        const data = await res.json().catch(() => undefined);
        throw errorFor(res.status, data, res);
      }
      if (!res.body) throw new CliError(tr("Máy chủ trả luồng rỗng.", "Empty stream from server."), Exit.general);
      for await (const chunk of sse(res.body)) {
        input.onChunk(chunk);
        switch (chunk.type) {
          case "token":
            outcome.text += chunk.text ?? "";
            break;
          case "activity":
            if (chunk.activity) outcome.activities.push(chunk.activity);
            outcome.runId ??= chunk.runId ?? undefined;
            break;
          case "agent":
            outcome.agent = chunk.agent ?? undefined;
            break;
          case "notice":
            outcome.notices.push({ code: chunk.code ?? "", message: chunk.message ?? "" });
            break;
          case "done":
          case "error":
          case "escalate":
          case "delivered_to_agent":
            outcome.ended = chunk.type;
            outcome.done = chunk;
            outcome.runId = chunk.runId ?? outcome.runId;
            outcome.proposedAction = chunk.proposedAction ?? undefined;
            if (chunk.type === "error" && chunk.text && !outcome.text) outcome.text = chunk.text;
            break;
        }
      }
      if (!outcome.done) throw new CliError(tr("Mất kết nối giữa chừng.", "Connection lost mid-answer."), Exit.network);
      return outcome;
    } catch (e) {
      lastErr = e;
      const ce = e as CliError;
      // Only transport failures are retried; 4xx/5xx with a body are final.
      if (input.signal?.aborted || (ce instanceof CliError && ce.exitCode !== Exit.network)) throw e;
    }
  }
  throw lastErr;
}

async function* sse(stream: AsyncIterable<Uint8Array>): AsyncGenerator<StreamChunk> {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const part of stream) {
    buf += decoder.decode(part, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const data = frame
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (!data) continue;
      try {
        yield JSON.parse(data) as StreamChunk;
      } catch {
        // keep-alive or partial garbage
      }
    }
  }
}

// ── Write risk ──────────────────────────────────────────────────────────────────────────────────────

/** device = pumps, valves, drones, automation rules (NextFarm). Like finance, never confirmed from the terminal. */
export type Risk = "normal" | "large" | "finance" | "device";

const FINANCE = /payment|invoice|einvoice|finance|refund|payout|wallet|billing|thanh.?toan|hoa.?don|tien/i;
const LARGE = /delete|remove|merge|bulk|batch|mass|permission|role|group|xoa|gop|hang.?loat|campaign|broadcast/i;

/** Large = deletes, merges, permission changes, > 20 records or recipients. Finance never runs from the terminal. */
export function riskOf(a: ProposedAction): Risk {
  if (a.risk) return a.risk;
  if (FINANCE.test(a.kind)) return "finance";
  if (LARGE.test(a.kind)) return "large";
  if ((a.recipientCount ?? 0) > 20) return "large";
  try {
    const p = JSON.parse(a.payloadJson) as Record<string, unknown>;
    const n = Object.values(p).find((v) => Array.isArray(v) && v.length > 20);
    if (n) return "large";
  } catch {
    // opaque payload: judged by kind only
  }
  return "normal";
}

/** Number the user types to confirm a large write (records/recipients), or the action label. */
export function confirmWord(a: ProposedAction): string {
  if (a.recipientCount) return String(a.recipientCount);
  try {
    const p = JSON.parse(a.payloadJson) as Record<string, unknown>;
    const arr = Object.values(p).find((v) => Array.isArray(v)) as unknown[] | undefined;
    if (arr && arr.length > 1) return String(arr.length);
  } catch {
    // ignore
  }
  return tr("dong-y", "confirm");
}
