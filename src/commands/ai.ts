import type { Command } from "commander";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { brand } from "../core/brand.js";
import { context } from "../core/context.js";
import { CliError, Exit } from "../core/errors.js";
import { tr } from "../core/i18n.js";
import { c, emit, info, json, ok, outputFormat, table, warn } from "../core/output.js";
import { get, post, put, del } from "../core/http.js";
import { getProfile, updateProfile } from "../core/config.js";
import { hasTty, confirm, confirmTyped, select } from "../core/prompt.js";
import { requirePerson, withWorkspace } from "../auth/session.js";
import {
  ask, attach, attachmentKind, composeText, confirmAction, listConversations, openConversation, renameConversation, pinConversation,
  deleteConversation, history, riskOf, confirmWord, type AskOutcome, type Attachment, type ProposedAction, type AnswerBlock,
} from "../ai/client.js";
import type { RootFlags } from "../program.js";
import { LocalChat } from "../ai/local.js";
import { mcpToken } from "../auth/mcp-oauth.js";
import { defaultModel, resolveModel, type ResolvedModel } from "../ai/models.js";
import { registerAiNextFarm } from "./ai-nextfarm.js";

// ── NEXTX.md ───────────────────────────────────────────────────────────────────────────────────────

const NOTES_MAX = 4096;

export function notesFileName(): string {
  return `${brand().bin.toUpperCase()}.md`;
}

/** Nearest NEXTX.md walking up from cwd, stopping at the git root or home. */
export function findProjectNotes(start = process.cwd()): { path: string; text: string } | undefined {
  let dir = start;
  const home = homedir();
  for (;;) {
    const f = join(dir, notesFileName());
    if (existsSync(f)) {
      const text = readFileSync(f, "utf8");
      return { path: f, text: text.length > NOTES_MAX ? text.slice(0, NOTES_MAX) : text };
    }
    if (existsSync(join(dir, ".git")) || dir === home) return undefined;
    const up = dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
}

// ── Rendering helpers shared with the REPL fallback ────────────────────────────────────────────────

export function renderBlocks(blocks: AnswerBlock[] | null | undefined): string[] {
  const out: string[] = [];
  for (const b of blocks ?? []) {
    if (b.type === "table" && Array.isArray(b.rows) && b.columns?.length) {
      const cols = b.columns;
      const rows = (b.rows as Record<string, unknown>[]).map((r) =>
        cols.map((col) => {
          const v = r[col.key ?? col.name ?? ""];
          return typeof v === "number" ? v.toLocaleString("vi-VN") : v === null || v === undefined ? "" : String(v);
        }),
      );
      out.push(table(cols.map((col) => col.label ?? col.name ?? col.key ?? ""), rows, cols.map((col) => (col.type === "number" || col.type === "money" ? "r" : "l"))));
      if (b.total && b.total > rows.length) out.push(c.dim(tr(`  … ${rows.length}/${b.total} dòng`, `  … ${rows.length}/${b.total} rows`)));
    } else if (b.type === "steps" && b.steps?.length) {
      b.steps.forEach((s, i) => out.push(`  ${i + 1}. ${s}`));
    } else if (b.type === "file" && b.url) {
      out.push(`  ${c.cyan("⬇")} ${b.label ?? tr("Tệp", "File")}: ${b.url}`);
    } else if ((b.type === "button" || b.type === "link") && (b.url || b.routeHint)) {
      const url = b.url ?? `${context().endpoints.app}${b.routeHint}`;
      out.push(`  ${c.cyan("↗")} ${b.label ?? ""} ${c.dim(url)}`);
    }
  }
  return out;
}

export function proposalCard(a: ProposedAction): string[] {
  const env = context().env === "prod" ? c.red(tr("GHI VÀO PROD", "WRITES TO PROD")) : c.yellow("SANDBOX");
  const risk = riskOf(a);
  const tag = risk === "large" ? c.red(tr("GHI LỚN · ", "LARGE WRITE · ")) : risk === "finance" ? c.red(tr("TÀI CHÍNH · ", "FINANCE · "))
    : risk === "device" ? c.red(tr("THIẾT BỊ · ", "DEVICE · ")) : "";
  const left = a.expiresAt ? Math.max(0, Math.round((Date.parse(a.expiresAt) - Date.now()) / 60000)) : 15;
  const lines = [
    c.yellow(`┌ ${tr("Đề xuất", "Proposal")} `) + tag + env + c.yellow(` · ${tr(`hết hạn sau ${left} phút`, `expires in ${left} min`)}`),
    c.yellow("│ ") + c.bold(a.label),
  ];
  for (const l of a.confirmPrompt.split("\n").filter(Boolean)) lines.push(c.yellow("│ ") + l);
  if (a.recipientCount) lines.push(c.yellow("│ ") + tr(`Người nhận: ${a.recipientCount}`, `Recipients: ${a.recipientCount}`));
  if (a.estimatedCost) lines.push(c.yellow("│ ") + tr(`Chi phí ước tính: ${a.estimatedCost.toLocaleString("vi-VN")} ${a.costCurrency ?? ""}`, `Estimated cost: ${a.estimatedCost} ${a.costCurrency ?? ""}`));
  return lines;
}

/**
 * Decides and, when allowed, executes a proposed write. Returns true if it was written.
 * Rules (docs §2.6): read mode never writes; finance never from the terminal; no TTY ⇒ never;
 * large writes need the typed number; auto mode skips the y/N for normal writes only.
 */
export async function handleProposal(sessionId: string, a: ProposedAction, mode = context().mode): Promise<{ written: boolean; message?: string }> {
  if (!a.writes) {
    const r = await confirmAction(sessionId, a);
    return { written: false, message: r.message };
  }
  const risk = riskOf(a);
  // NextFarm proposals are confirmed by id; the default platform's by reopening the conversation.
  const resume = brand().platform === "nextfarm" ? `${brand().bin} ai apply ${a.nonce}` : `${brand().bin} -r ${sessionId}`;
  if (mode === "read") {
    info(c.dim(tr("  Chế độ chỉ đọc: không ghi. Đổi chế độ: --mode propose", "  Read-only mode: nothing written. Switch with --mode propose")));
    return { written: false };
  }
  if (risk === "finance" || risk === "device") {
    info(c.dim(risk === "device"
      ? tr(`  Việc chạm thiết bị / tự động hoá chỉ xác nhận trong app: ${context().endpoints.app}`, `  Device and automation actions are confirmed in the app only: ${context().endpoints.app}`)
      : tr(`  Việc tài chính chỉ xác nhận trong app: ${context().endpoints.app}`, `  Finance actions are confirmed in the app only: ${context().endpoints.app}`)));
    return { written: false };
  }
  if (!hasTty()) {
    info(tr(`  Chưa ghi. Xác nhận trong 15 phút: ${c.bold(resume)}`, `  Not written. Confirm within 15 minutes: ${c.bold(resume)}`));
    return { written: false };
  }
  let yes: boolean;
  if (risk === "large") yes = await confirmTyped(c.yellow("└"), confirmWord(a));
  else if (mode === "auto") yes = true;
  else yes = await confirm(c.yellow("└ ") + tr("Ghi?", "Write?"));
  if (!yes) {
    info(c.dim(tr(`  Không ghi gì. Đề xuất còn chờ tới khi hết hạn: ${resume}`, `  Nothing written. The proposal waits until it expires: ${resume}`)));
    return { written: false };
  }
  const r = await confirmAction(sessionId, a);
  if (r.success) ok(r.message || tr("Đã ghi.", "Written."));
  else warn(r.message);
  for (const l of renderBlocks(r.blocks)) info(l);
  return { written: r.success, message: r.message };
}

// ── Root: REPL or -p ───────────────────────────────────────────────────────────────────────────────

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const ch of process.stdin) chunks.push(ch as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export async function resolveConversation(o: RootFlags): Promise<string> {
  const p = getProfile(context().profile);
  if (typeof o.resume === "string") return o.resume;
  if (o.resume === true) {
    const list = await listConversations(30);
    if (!hasTty()) throw new CliError(tr("Cần id hội thoại khi không có terminal: -r <id>", "Pass a conversation id without a terminal: -r <id>"), Exit.usage);
    const pick = await select(tr("Mở lại hội thoại:", "Resume conversation:"), list.map((x) => ({
      label: `${x.isPinned ? "📌 " : ""}${x.title ?? x.lastPreview ?? x.sessionId}`.slice(0, 70),
      hint: x.updatedAt.slice(0, 16).replace("T", " "),
      value: x.sessionId,
    })));
    if (!pick) throw new CliError(tr("Đã huỷ.", "Cancelled."), Exit.interrupted);
    return pick;
  }
  if (o.continue && p?.lastConversation) return p.lastConversation;
  return (await openConversation(true)).sessionId;
}

export async function runRoot(o: RootFlags, words: string[]): Promise<void> {
  const printMode = o.print !== undefined && o.print !== false;
  const spec = o.model ?? defaultModel();
  const model = spec ? resolveModel(spec) : undefined;
  if (!printMode && hasTty() && outputFormat() === "text") {
    await requirePerson();
    // The MCP grant may need a browser round-trip; do it before the chat UI owns the terminal.
    if (model) await mcpToken({ interactive: true });
    const { startRepl } = await import("../repl/index.js");
    return withWorkspace(context().workspace, () => startRepl({ flags: o, initialQuestion: words.join(" ").trim() || undefined, model }));
  }
  const q = [typeof o.print === "string" ? o.print : "", ...words].join(" ").trim();
  const piped = await readStdin();
  if (!q && !piped) throw new CliError(tr(`Thiếu câu hỏi. Ví dụ: ${brand().bin} -p "${brand().example.vi}"`, `Missing question. Example: ${brand().bin} -p "${brand().example.en}"`), Exit.usage);
  await requirePerson();
  const question = q || tr("Xử lý nội dung đính kèm.", "Process the attached content.");
  await withWorkspace(context().workspace, () => (model ? printLocal(o, model, question, piped) : printAsk(o, question, piped)));
}

/** -p with --model: same output contract as the platform assistant, answered by the user's model. */
async function printLocal(o: RootFlags, model: ResolvedModel, question: string, piped: string): Promise<void> {
  const attachments: Attachment[] = [];
  for (const f of (o.file ?? []).slice(0, 3)) {
    if (attachmentKind(f) !== "text") throw new CliError(tr(`Model riêng chỉ đọc tệp chữ: ${f}`, `Your own model reads text files only: ${f}`), Exit.usage);
    attachments.push(await attach(f));
  }
  if (piped) attachments.push({ path: "-", name: "stdin", kind: "text", text: piped.slice(0, 20_000) });
  const fmt = outputFormat();
  const chat = new LocalChat(model, hasTty(), context().mode === "read");
  const outcome = await chat.ask({
    text: composeText(question, attachments, findProjectNotes()?.text),
    onChunk: (ch) => {
      if (fmt === "stream-json") return json(ch);
      if (fmt !== "text") return;
      if (ch.type === "token") process.stdout.write(ch.text ?? "");
      else if (ch.type === "activity" && ch.activity && !o.quiet) process.stderr.write(c.dim(`⏺ ${ch.activity.label}\n`));
    },
  });
  if (fmt === "json")
    json({ model: model.label, text: outcome.text, notices: outcome.notices, tools: outcome.activities.map((a) => a.toolName), workspace: getProfile(context().profile)?.workspaceCode ?? null, env: context().env, ended: outcome.ended });
  else if (fmt === "text") {
    if (outcome.text && !outcome.text.endsWith("\n")) process.stdout.write("\n");
    for (const n of outcome.notices) process.stderr.write(`${c.yellow("⚠")} ${n.message}\n`);
  }
  if (outcome.ended === "error") process.exitCode = Exit.general;
}

async function printAsk(o: RootFlags, question: string, piped: string): Promise<void> {
  const sessionId = await resolveConversation(o);
  const attachments: Attachment[] = [];
  for (const f of (o.file ?? []).slice(0, 3)) attachments.push(await attach(f, sessionId));
  if (piped) attachments.push({ path: "-", name: "stdin", kind: "text", text: piped.slice(0, 20_000) });
  const notes = findProjectNotes();
  const fmt = outputFormat();
  const text = composeText(question, attachments, notes?.text);
  const stdout = process.stdout;
  const stderr = process.stderr;
  const outcome: AskOutcome = await ask({
    sessionId,
    text,
    attachments,
    agent: context().agent,
    onChunk: (ch) => {
      if (fmt === "stream-json") return json(ch);
      if (fmt !== "text") return;
      if (ch.type === "token") stdout.write(ch.text ?? "");
      else if (ch.type === "activity" && ch.activity?.kind === "tool" && !o.quiet) stderr.write(c.dim(`⏺ ${ch.activity.label}\n`));
    },
    onRetry: (n) => stderr.write(c.yellow(tr(`⚠ Mất kết nối, đang nối lại (${n}/2)…\n`, `⚠ Connection lost, reconnecting (${n}/2)…\n`))),
  });
  const conversationId = outcome.sessionId || sessionId;
  updateProfile(context().profile, { lastConversation: conversationId });

  const proposal = outcome.proposedAction;
  if (fmt === "json") {
    json({
      conversationId,
      runId: outcome.runId ?? null,
      messageId: outcome.done?.messageId ?? null,
      text: outcome.text,
      blocks: outcome.done?.blocks ?? [],
      followUps: outcome.done?.followUps ?? [],
      notices: outcome.notices,
      agent: outcome.agent ?? null,
      proposals: proposal ? [{ kind: proposal.kind, label: proposal.label, prompt: proposal.confirmPrompt, writes: proposal.writes, expiresAt: proposal.expiresAt ?? null, risk: riskOf(proposal),
        confirm: brand().platform === "nextfarm" ? `${brand().bin} ai apply ${proposal.nonce}` : `${brand().bin} -r ${conversationId}` }] : [],
      workspace: getProfile(context().profile)?.workspaceCode ?? null,
      env: context().env,
      ended: outcome.ended,
    });
  } else if (fmt === "text") {
    if (outcome.text && !outcome.text.endsWith("\n")) stdout.write("\n");
    // Notices the answer already says in words are not repeated.
    for (const n of outcome.notices) if (n.message && !outcome.text.includes(n.message.slice(0, 24))) stderr.write(`${c.yellow("⚠")} ${n.message}\n`);
    for (const l of renderBlocks(outcome.done?.blocks?.filter((b) => b.type !== "text"))) stdout.write(`${l}\n`);
    if (proposal) {
      for (const l of proposalCard(proposal)) stderr.write(`${l}\n`);
      await handleProposal(conversationId, proposal);
    }
  }
  if (outcome.notices.some((n) => n.code === "ai_not_purchased")) process.exitCode = Exit.forbidden;
  else if (proposal?.writes) process.exitCode = Exit.notConfirmed;
  else if (outcome.ended === "error") process.exitCode = Exit.general;
}

// ── `ai` subcommands ───────────────────────────────────────────────────────────────────────────────

interface ChangesetHead {
  id: string;
  runId: string;
  title: string;
  toolName: string;
  status: string;
  risk: number;
  expiresAt: string;
  undoable: boolean;
  undoUntil?: string | null;
  createdAt: string;
  version: number;
  summary?: unknown;
}

interface Memory {
  id: string;
  scope: string;
  kind: string;
  key: string;
  display: string;
  status: string;
  uses: number;
  lockedBy?: string | null;
}

interface Schedule {
  id: string;
  title: string;
  question: string;
  agentCode?: string | null;
  frequency: string;
  timeOfDay: string;
  dayOfWeek?: number | null;
  dayOfMonth?: number | null;
  enabled: boolean;
  nextRunAt: string;
  lastRunAt?: string | null;
  lastStatus?: string | null;
  lastSessionId?: string | null;
  runCount: number;
}

const short = (id: string) => id.slice(0, 8);
const when = (iso?: string | null) => (iso ? iso.slice(0, 16).replace("T", " ") : "");

async function findChangeset(id: string): Promise<ChangesetHead> {
  if (id.length >= 32) return get<ChangesetHead>(`/ai/changesets/${id}`);
  const pending = await get<{ changesets: ChangesetHead[] }>("/ai/pending", { query: { take: 50 } });
  const journal = await get<{ items: ChangesetHead[] }>("/ai/journal", { query: { pageSize: 50 } });
  const hit = [...pending.changesets, ...journal.items].find((x) => x.id.startsWith(id));
  if (!hit) throw new CliError(tr("Không thấy bản nháp này.", "Changeset not found."), Exit.notFound);
  return hit;
}

export function registerAi(program: Command): void {
  const ai = program.command("ai").description(tr("trợ lý AI: hỏi, lịch sử, đề xuất ghi, bộ nhớ, lịch chạy", "AI assistant: ask, history, proposals, memory, schedules"));

  ai.command("ask <question...>")
    .description(tr("hỏi một câu không tương tác (giống -p)", "ask one question non-interactively (same as -p)"))
    .option("--conversation <id>", tr("hỏi tiếp trong hội thoại này", "continue this conversation"))
    .action(async (words: string[], o: { conversation?: string }) => {
      const root = program.opts<RootFlags>();
      await runRoot({ ...root, print: words.join(" "), resume: o.conversation ?? root.resume }, []);
    });

  ai.command("history")
    .description(tr("danh sách hội thoại", "list conversations"))
    .option("--search <text>", tr("lọc theo chữ", "filter by text"))
    .option("--limit <n>", tr("số dòng", "rows"), "30")
    .action(async (o: { search?: string; limit: string }) => {
      await requirePerson();
      let list = await listConversations(Number(o.limit));
      if (o.search) list = list.filter((x) => `${x.title ?? ""} ${x.lastPreview ?? ""}`.toLowerCase().includes(o.search!.toLowerCase()));
      emit(list, () => info(table(["ID", tr("Tiêu đề", "Title"), "Agent", tr("Cập nhật", "Updated")], list.map((x) => [
        short(x.sessionId), `${x.isPinned ? "📌 " : ""}${(x.title ?? x.lastPreview ?? "").slice(0, 60)}`, x.agentCode ?? "", when(x.updatedAt),
      ]))));
    });

  ai.command("show <id>")
    .description(tr("in toàn bộ một hội thoại", "print a whole conversation"))
    .action(async (id: string) => {
      await requirePerson();
      const full = id.length >= 32 ? id : (await listConversations(100)).find((x) => x.sessionId.startsWith(id))?.sessionId;
      if (!full) throw new CliError(tr("Không thấy hội thoại.", "Conversation not found."), Exit.notFound);
      const msgs = (await history(full)) ?? [];
      emit(msgs, () => {
        for (const m of msgs) {
          info(m.role === "User" ? c.bold(`› ${m.text}`) : m.text);
          for (const l of renderBlocks(m.blocks?.filter((b) => b.type !== "text"))) info(l);
          info();
        }
      });
    });

  ai.command("rename <id> [title...]").description(tr("đặt tên hội thoại (bỏ trống = xoá tên)", "rename a conversation (empty = clear)"))
    .action(async (id: string, title: string[]) => {
      await renameConversation(id, title.join(" ") || null);
      ok(tr("Đã đổi tên.", "Renamed."));
    });
  ai.command("pin <id>").option("--off", tr("bỏ ghim", "unpin")).description(tr("ghim hội thoại", "pin a conversation"))
    .action(async (id: string, o: { off?: boolean }) => {
      await pinConversation(id, !o.off);
      ok(o.off ? tr("Đã bỏ ghim.", "Unpinned.") : tr("Đã ghim.", "Pinned."));
    });
  ai.command("delete <id>").description(tr("xoá hẳn một hội thoại (không hoàn tác)", "delete a conversation permanently"))
    .action(async (id: string) => {
      if (hasTty() && !(await confirm(tr("Xoá hẳn hội thoại này?", "Delete this conversation permanently?")))) return;
      await deleteConversation(id);
      ok(tr("Đã xoá.", "Deleted."));
    });

  if (brand().platform === "nextfarm") return registerAiNextFarm(ai, program);

  ai.command("why [runId]")
    .description(tr("vì sao AI trả lời vậy: các bước, công cụ đã gọi", "why the AI answered that way: steps and tools"))
    .action(async (runId?: string) => {
      await requirePerson();
      const id = runId ?? (await get<{ id: string }[]>("/ai/runs", { query: { limit: 1 } }))[0]?.id;
      if (!id) throw new CliError(tr("Chưa có lượt chạy nào.", "No runs yet."), Exit.notFound);
      const run = await get<Record<string, unknown>>(`/ai/runs/${id}`);
      emit(run, () => printRun(run));
    });

  ai.command("runs").description(tr("các lượt chạy gần đây", "recent runs")).option("--limit <n>", "", "20")
    .action(async (o: { limit: string }) => {
      const runs = await get<{ id: string; status: string; question: string; createdAt: string; elapsedSeconds?: number; errorCode?: string | null }[]>("/ai/runs", { query: { limit: o.limit } });
      emit(runs, () => info(table(["Run", tr("Trạng thái", "Status"), tr("Câu hỏi", "Question"), "s", tr("Lúc", "At")], runs.map((r) => [short(r.id), r.status, r.question.slice(0, 50), r.elapsedSeconds ?? "", when(r.createdAt)]))));
    });

  ai.command("pending").description(tr("bản nháp ghi và câu hỏi đang chờ bạn", "drafts and questions waiting for you"))
    .action(async () => {
      await requirePerson();
      const p = await get<{ changesets: ChangesetHead[]; questions: { id: string; runId: string; expiresAt: string }[] }>("/ai/pending", { query: { take: 50 } });
      emit(p, () => {
        if (!p.changesets.length && !p.questions.length) return info(tr("Không có việc nào đang chờ.", "Nothing is waiting."));
        if (p.changesets.length)
          info(table(["ID", tr("Việc", "Change"), tr("Trạng thái", "Status"), tr("Hết hạn", "Expires")], p.changesets.map((x) => [short(x.id), x.title, x.status, when(x.expiresAt)])));
        if (p.questions.length) info(tr(`${p.questions.length} câu hỏi của AI đang chờ trả lời — mở \`${brand().bin} -r\` để trả lời.`, `${p.questions.length} AI questions await answers — open \`${brand().bin} -r\`.`));
        info(c.dim(`  ${brand().bin} ai show-changeset <id> · ${brand().bin} ai apply <id> · ${brand().bin} ai reject <id>`));
      });
    });

  ai.command("show-changeset <id>").description(tr("xem từng dòng của một bản nháp", "show the rows of a draft"))
    .action(async (id: string) => {
      const head = await findChangeset(id);
      const items = await get<{ items: { seq: number; op: string; label: string; before?: unknown; after?: unknown; applied: boolean }[]; totalCount: number }>(`/ai/changesets/${head.id}/items`, { query: { pageSize: 200 } });
      emit({ head, items }, () => {
        info(`${c.bold(head.title)} ${c.dim(head.status)} · ${items.totalCount} ${tr("dòng", "rows")}`);
        for (const it of items.items) {
          const sign = it.op === "delete" ? c.red("−") : it.op === "create" ? c.green("+") : c.yellow("~");
          info(`  ${sign} ${it.label}`);
          if (it.op === "update" && it.before && it.after) info(c.dim(`      ${JSON.stringify(it.before)} → ${JSON.stringify(it.after)}`));
        }
      });
    });

  ai.command("apply <id>").description(tr("áp dụng một bản nháp (ghi thật)", "apply a draft (real write)"))
    .action(async (id: string) => {
      await requirePerson();
      const head = await findChangeset(id);
      if (context().mode === "read") throw new CliError(tr("Chế độ chỉ đọc.", "Read-only mode."), Exit.forbidden);
      if (!hasTty()) throw new CliError(tr("Áp dụng bản nháp cần terminal tương tác (hoặc chính sách duyệt trước).", "Applying needs an interactive terminal (or a pre-approval policy)."), Exit.notConfirmed);
      const env = context().env === "prod" ? c.red("PROD") : c.yellow("SANDBOX");
      info(`${c.bold(head.title)} · ${env}`);
      const yes = head.risk >= 3 ? await confirmTyped("", tr("dong-y", "confirm")) : await confirm(tr("Áp dụng?", "Apply?"));
      if (!yes) return void info(tr("Không ghi gì.", "Nothing written."));
      const r = await post<Record<string, unknown>>(`/ai/changesets/${head.id}/apply`, undefined, { query: { expectedVersion: head.version } });
      emit(r, () => ok(tr(`Đã áp dụng · hoàn tác: ${brand().bin} ai undo ${short(head.id)}`, `Applied · undo: ${brand().bin} ai undo ${short(head.id)}`)));
    });

  ai.command("reject <id>").description(tr("huỷ một bản nháp", "reject a draft"))
    .action(async (id: string) => {
      const head = await findChangeset(id);
      await post(`/ai/changesets/${head.id}/reject`, {});
      ok(tr("Đã huỷ bản nháp.", "Draft rejected."));
    });

  ai.command("undo <id>").description(tr("hoàn tác việc AI đã ghi (trong hạn)", "undo what the AI wrote (within the window)"))
    .action(async (id: string) => {
      const head = await findChangeset(id);
      if (hasTty() && !(await confirm(tr(`Hoàn tác "${head.title}"?`, `Undo "${head.title}"?`)))) return;
      const r = await post<{ reverted?: number; conflicts?: number }>(`/ai/changesets/${head.id}/undo`, {});
      emit(r, () => ok(tr(`Đã hoàn tác ${r.reverted ?? ""} dòng${r.conflicts ? `, ${r.conflicts} dòng xung đột (đã bị người khác sửa, không ghi đè)` : ""}.`, `Reverted ${r.reverted ?? ""} rows${r.conflicts ? `, ${r.conflicts} conflicts (changed by someone else, not overwritten)` : ""}.`)));
    });

  ai.command("journal").description(tr("nhật ký những gì AI đã ghi", "journal of what the AI wrote"))
    .option("--module <m>", tr("lọc theo phân hệ", "filter by module"))
    .option("--limit <n>", "", "20")
    .action(async (o: { module?: string; limit: string }) => {
      const j = await get<{ items: ChangesetHead[]; totalCount: number }>("/ai/journal", { query: { module: o.module, pageSize: o.limit } });
      emit(j, () => {
        if (!j.items.length) return info(tr("Chưa có gì trong nhật ký.", "The journal is empty."));
        info(table(["ID", tr("Việc", "Change"), tr("Trạng thái", "Status"), tr("Hoàn tác tới", "Undo until"), tr("Lúc", "At")], j.items.map((x) => [short(x.id), x.title, x.status, x.undoable ? when(x.undoUntil) : "—", when(x.createdAt)])));
      });
    });

  const mem = ai.command("memory").description(tr("AI đang nhớ gì về công ty", "what the AI remembers about your company"));
  mem.command("list", { isDefault: true }).action(async () => {
    const list = await get<Memory[]>("/ai/memory");
    emit(list, () => (list.length ? info(table(["ID", tr("Điều nhớ", "Memory"), tr("Loại", "Kind"), tr("Dùng", "Uses"), ""], list.map((m) => [short(m.id), m.display, m.kind, m.uses, m.lockedBy ? "🔒" : ""]))) : info(tr("AI chưa nhớ gì.", "Nothing remembered yet."))));
  });
  mem.command("edit <id> <text...>").description(tr("sửa câu chữ một điều nhớ", "edit a memory")).action(async (id: string, text: string[]) => {
    const m = await resolveMemory(id);
    await put(`/ai/memory/${m.id}`, { display: text.join(" ") });
    ok(tr("Đã sửa.", "Updated."));
  });
  mem.command("lock <id>").option("--off", tr("mở khoá", "unlock")).description(tr("khoá để AI không tự sửa", "lock so the AI cannot change it"))
    .action(async (id: string, o: { off?: boolean }) => {
      const m = await resolveMemory(id);
      await put(`/ai/memory/${m.id}`, { lockedBy: o.off ? null : "user" });
      ok(o.off ? tr("Đã mở khoá.", "Unlocked.") : tr("Đã khoá.", "Locked."));
    });
  mem.command("forget <id>").description(tr("bảo AI quên một điều", "make the AI forget something")).action(async (id: string) => {
    const m = await resolveMemory(id);
    await del(`/ai/memory/${m.id}`);
    ok(tr("Đã quên.", "Forgotten."));
  });

  const sch = ai.command("schedule").description(tr("lên lịch một câu hỏi chạy định kỳ", "schedule a recurring question"));
  sch.command("list", { isDefault: true }).action(async () => {
    const list = await get<Schedule[]>("/ai/schedules");
    emit(list, () => (list.length ? info(table(["ID", tr("Tên", "Title"), tr("Lịch", "When"), tr("Lần tới", "Next"), tr("Lần trước", "Last"), ""], list.map((s) => [short(s.id), s.title, `${s.frequency} ${s.timeOfDay}`, when(s.nextRunAt), `${when(s.lastRunAt)} ${s.lastStatus ?? ""}`, s.enabled ? "" : tr("tắt", "off")]))) : info(tr("Chưa có lịch nào.", "No schedules."))));
  });
  sch.command("add <question>")
    .description(tr('vd: ai schedule add "doanh thu hôm qua" --daily 08:00', 'e.g. ai schedule add "yesterday\'s revenue" --daily 08:00'))
    .option("--daily <HH:mm>")
    .option("--weekly <dow@HH:mm>", tr("0=CN … 6=T7, vd 1@08:00", "0=Sun … 6=Sat, e.g. 1@08:00"))
    .option("--monthly <dom@HH:mm>", tr("ngày 1–28, vd 1@08:00", "day 1–28, e.g. 1@08:00"))
    .option("--title <title>")
    .action(async (question: string, o: { daily?: string; weekly?: string; monthly?: string; title?: string }) => {
      const [frequency, spec] = o.weekly ? ["weekly", o.weekly] : o.monthly ? ["monthly", o.monthly] : ["daily", o.daily ?? "08:00"];
      const [day, time] = spec!.includes("@") ? spec!.split("@") : [undefined, spec];
      const s = await post<Schedule>("/ai/schedules", {
        title: o.title ?? question.slice(0, 60), question, agentCode: context().agent ?? null, frequency, timeOfDay: time,
        dayOfWeek: frequency === "weekly" ? Number(day) : null, dayOfMonth: frequency === "monthly" ? Number(day) : null, enabled: true,
      });
      emit(s, () => ok(tr(`Đã lên lịch · lần chạy tới ${when(s.nextRunAt)}`, `Scheduled · next run ${when(s.nextRunAt)}`)));
    });
  sch.command("run <id>").description(tr("chạy ngay một lần", "run once now")).action(async (id: string) => {
    const s = await resolveSchedule(id);
    const r = await post<Schedule>(`/ai/schedules/${s.id}/run`, {});
    emit(r, () => ok(tr(`Đã chạy · xem: ${brand().bin} ai show ${r.lastSessionId ?? ""}`, `Ran · see: ${brand().bin} ai show ${r.lastSessionId ?? ""}`)));
  });
  sch.command("off <id>").description(tr("tắt lịch", "disable")).action(async (id: string) => toggleSchedule(id, false));
  sch.command("on <id>").description(tr("bật lịch", "enable")).action(async (id: string) => toggleSchedule(id, true));
  sch.command("delete <id>").description(tr("xoá lịch", "delete")).action(async (id: string) => {
    const s = await resolveSchedule(id);
    await del(`/ai/schedules/${s.id}`);
    ok(tr("Đã xoá lịch.", "Schedule deleted."));
  });

  const lib = ai.command("library").description(tr("ảnh, tài liệu, tệp AI đã tạo", "images, documents and files the AI produced"));
  lib.command("list", { isDefault: true }).option("--kind <kind>", "image | document | generated").action(async (o: { kind?: string }) => {
    const list = await get<{ id: string; kind: string; name: string; createdAt: string; url: string; sessionId?: string }[]>("/ai/library", { query: { kind: o.kind } });
    emit(list, () => info(table(["#", tr("Loại", "Kind"), tr("Tên", "Name"), tr("Lúc", "At")], list.map((x, i) => [i + 1, x.kind, x.name, when(x.createdAt)]))));
  });
  lib.command("get <n>").description(tr("tải mục thứ n về máy", "download item n")).option("-o, --out <file>")
    .action(async (n: string, o: { out?: string }) => {
      const list = await get<{ name: string; url: string }[]>("/ai/library");
      const item = list[Number(n) - 1];
      if (!item) throw new CliError(tr("Không có mục này.", "No such item."), Exit.notFound);
      const { fetch } = await import("undici");
      const res = await fetch(item.url);
      const file = o.out ?? item.name;
      writeFileSync(file, Buffer.from(await res.arrayBuffer()));
      ok(tr(`Đã lưu ${file}`, `Saved ${file}`));
    });

  ai.command("agents").description(tr("các Agent bạn dùng được", "Agents available to you"))
    .action(async () => {
      const list = await get<{ code: string; name: string; description: string; status: string; requiredPlanName?: string | null }[]>("/ai/agents");
      emit(list, () => info(table(["Code", tr("Tên", "Name"), tr("Trạng thái", "Status"), tr("Mô tả", "Description")], list.map((a) => [a.code, a.name, a.status === "available" ? c.green(a.status) : c.dim(`${a.status}${a.requiredPlanName ? ` (${a.requiredPlanName})` : ""}`), a.description.slice(0, 60)]))));
    });

  ai.command("usage").description(tr("lượt AI tháng này", "AI turns this month"))
    .action(async () => {
      const u = await (await import("../ai/client.js")).usage();
      emit(u, () => info(`${tr("Gói", "Plan")} ${c.bold(u.planName ?? "-")} · ${tr("đã dùng", "used")} ${u.used ?? 0}${u.limit ? `/${u.limit}` : ""} · ${tr("mở lại", "resets")} ${u.resetsAt?.slice(0, 10) ?? ""}`));
    });

  ai.command("feedback <messageId> <vote>").description(tr("báo câu trả lời tốt (up) / chưa tốt (down)", "rate an answer: up / down"))
    .action(async (messageId: string, vote: string) => {
      await post(`/operator/widget/support/messages/${messageId}/feedback`, { helpful: vote === "up" });
      ok(tr("Cảm ơn bạn đã góp ý.", "Thanks for the feedback."));
    });

  ai.command("support <problem...>").description(tr("chuyển cho nhân viên hỗ trợ (mở ticket)", "hand over to a support agent (opens a ticket)"))
    .action(async (problem: string[]) => {
      const sessionId = getProfile(context().profile)?.lastConversation ?? (await openConversation(false)).sessionId;
      const r = await post<{ estimatedWaitMinutes: number; status: string }>("/operator/widget/support/escalate", { sessionId, topic: problem.join(" ") });
      emit(r, () => ok(tr(`Đã chuyển (${r.status}) · chờ khoảng ${r.estimatedWaitMinutes} phút`, `Handed over (${r.status}) · about ${r.estimatedWaitMinutes} min`)));
    });
}

async function resolveMemory(id: string): Promise<Memory> {
  const m = (await get<Memory[]>("/ai/memory")).find((x) => x.id.startsWith(id));
  if (!m) throw new CliError(tr("Không thấy điều nhớ này.", "Memory not found."), Exit.notFound);
  return m;
}

async function resolveSchedule(id: string): Promise<Schedule> {
  const s = (await get<Schedule[]>("/ai/schedules")).find((x) => x.id.startsWith(id));
  if (!s) throw new CliError(tr("Không thấy lịch này.", "Schedule not found."), Exit.notFound);
  return s;
}

async function toggleSchedule(id: string, enabled: boolean): Promise<void> {
  const s = await resolveSchedule(id);
  await put(`/ai/schedules/${s.id}`, { title: s.title, question: s.question, agentCode: s.agentCode, frequency: s.frequency, timeOfDay: s.timeOfDay, dayOfWeek: s.dayOfWeek, dayOfMonth: s.dayOfMonth, enabled });
  ok(enabled ? tr("Đã bật lịch.", "Enabled.") : tr("Đã tắt lịch.", "Disabled."));
}

export function runLines(run: Record<string, unknown>): string[] {
  const out = [c.bold(String(run.question ?? "")), c.dim(`  ${run.status ?? ""} · ${run.elapsedSeconds ?? "?"}s · run ${String(run.id ?? "").slice(0, 8)}`)];
  const steps = (run.steps ?? run.trace ?? run.events) as { kind?: string; label?: string; toolName?: string; elapsedMs?: number; status?: string; error?: string }[] | undefined;
  for (const s of steps ?? []) {
    const mark = s.kind === "tool" ? c.cyan("⏺") : c.dim("·");
    out.push(`  ${mark} ${s.label ?? s.toolName ?? s.kind ?? ""}${s.elapsedMs ? c.dim(`  +${(s.elapsedMs / 1000).toFixed(1)}s`) : ""}${s.error ? c.red(`  ${s.error}`) : ""}`);
  }
  const tools = run.toolCalls as { name?: string; status?: string; durationMs?: number }[] | undefined;
  for (const tc of tools ?? []) out.push(`  ${c.cyan("⏺")} ${tc.name ?? ""} ${c.dim(`${tc.status ?? ""} ${tc.durationMs ?? ""}ms`)}`);
  return out;
}

export function printRun(run: Record<string, unknown>): void {
  for (const l of runLines(run)) info(l);
}
