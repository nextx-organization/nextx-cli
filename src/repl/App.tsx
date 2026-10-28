import React, { useCallback, useEffect, useRef, useState } from "react";
import { Box, Static, Text, useApp, useInput, useStdout } from "ink";
import Spinner from "ink-spinner";
import { existsSync, readdirSync, statSync, appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { brand } from "../core/brand.js";
import { context, setContext } from "../core/context.js";
import { isCliError } from "../core/errors.js";
import { tr } from "../core/i18n.js";
import { c, table } from "../core/output.js";
import { get, post } from "../core/http.js";
import { getProfile, updateProfile, loadConfig, saveConfig, type Mode } from "../core/config.js";
import { historyFile } from "../core/paths.js";
import { VERSION } from "../core/version.js";
import {
  ask, attach, attachmentKind, composeText, confirmAction, escalate, feedback, history as fetchHistory, listConversations,
  openConversation, pinConversation, renameConversation, riskOf, confirmWord, usage as fetchUsage,
  type ActivityDto, type AgentDto, type AskOutcome, type Attachment, type ProposedAction,
} from "../ai/client.js";
import { listWorkspaces, switchWorkspace, findWorkspace, logoutServer } from "../auth/session.js";
import { deleteSession } from "../auth/credentials.js";
import { findProjectNotes, notesFileName, proposalCard, renderBlocks, runLines } from "../commands/ai.js";
import { markdown } from "./markdown.js";
import { Editor, Menu, Select, edit, type MenuItem } from "./components.js";
import { LocalChat } from "../ai/local.js";
import { listModels, resolveModel, type ResolvedModel } from "../ai/models.js";
import { SHORTCUTS, SLASH, matchSlash, slashCommands } from "./slash.js";
import * as nf from "../ai/nextfarm.js";

export interface AppProps {
  initialQuestion?: string;
  sessionId: string;
  resumed: boolean;
  files: string[];
  /** --model: answer with the user's own model on this machine instead of the platform assistant. */
  model?: ResolvedModel;
}

interface Done {
  id: number;
  text: string;
}

interface Live {
  activities: ActivityDto[];
  text: string;
  agent?: AgentDto;
  reconnecting?: number;
}

type Modal =
  | { kind: "select"; title: string; items: MenuItem[]; initial?: number; resolve: (v: string | undefined) => void }
  | { kind: "confirm"; proposal: ProposedAction; typed: string; resolve: (yes: boolean) => void };

const MODES: Mode[] = ["propose", "auto", "read"];
const modeLabel = (m: Mode) =>
  m === "propose" ? c.cyan(tr("⏵⏵ đề xuất", "⏵⏵ propose")) : m === "auto" ? c.yellow(tr("⏵⏵ tự ghi việc thường", "⏵⏵ auto-write normal")) : c.dim(tr("⏸ chỉ đọc", "⏸ read only"));

let seq = 0;
const nextId = () => ++seq;

function loadHistory(): string[] {
  try {
    return readFileSync(historyFile(), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as string).slice(-500);
  } catch {
    return [];
  }
}

function saveHistory(line: string): void {
  try {
    appendFileSync(historyFile(), `${JSON.stringify(line)}\n`, { mode: 0o600 });
  } catch {
    // history is a convenience
  }
}

/** Files under cwd usable with @ (supported types only, shallow + 2 levels, ignores node_modules/.git). */
function attachableFiles(): string[] {
  const root = process.cwd();
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (out.length > 300 || depth > 2) return;
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const n of names) {
      if (n.startsWith(".") || n === "node_modules" || n === "dist") continue;
      const p = join(dir, n);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(p, depth + 1);
      else if (attachmentKind(p)) out.push(relative(root, p));
    }
  };
  walk(root, 0);
  return out;
}

export function App(props: AppProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const width = Math.max(40, Math.min(stdout?.columns || 100, 120));
  const b = brand();

  const [done, setDone] = useState<Done[]>([]);
  const [live, setLive] = useState<Live | null>(null);
  const liveRef = useRef<Live | null>(null);
  const [, setTick] = useState(0);
  const [value, setValue] = useState("");
  const [cursor, setCursor] = useState(0);
  const [menuIndex, setMenuIndex] = useState(0);
  const [menuOff, setMenuOff] = useState(false);
  const [modal, setModal] = useState<Modal | null>(null);
  const [mode, setMode] = useState<Mode>(context().mode);
  const [agent, setAgent] = useState<string | undefined>(context().agent);
  const [local, setLocal] = useState<LocalChat | undefined>(() => (props.model ? new LocalChat(props.model, true, context().mode === "read") : undefined));
  const [sessionId, setSessionId] = useState(props.sessionId);
  const [pending, setPending] = useState<Attachment[]>([]);
  const [usageText, setUsageText] = useState("");
  const [busy, setBusy] = useState(false);
  const [lastOutcome, setLastOutcome] = useState<AskOutcome | undefined>();
  const [hist] = useState<string[]>(loadHistory);
  const histIdx = useRef<number>(-1);
  const abortRef = useRef<AbortController | null>(null);
  const ctrlC = useRef(0);
  const lastEsc = useRef(0);
  const lastSent = useRef("");
  const filesCache = useRef<string[] | null>(null);
  const agentsCache = useRef<{ code: string; name: string; status: string }[] | null>(null);

  const say = useCallback((text: string) => setDone((d) => [...d, { id: nextId(), text }]), []);
  const sayErr = useCallback((e: unknown) => {
    const msg = isCliError(e) ? `${c.red("✗")} ${e.message}${e.hint ? `\n  ${c.dim(e.hint)}` : ""}` : `${c.red("✗")} ${(e as Error)?.message ?? String(e)}`;
    setDone((d) => [...d, { id: nextId(), text: msg }]);
  }, []);

  const profile = () => getProfile(context().profile);
  const refreshUsage = useCallback(() => {
    fetchUsage()
      .then((u) => setUsageText(u.limit ? `${u.planName ?? ""} · ${u.remaining}/${u.limit} ${tr("lượt", "turns")}` : (u.planName ?? "")))
      .catch(() => undefined);
  }, []);

  // ── header, once ──────────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    const p = profile();
    const env = context().env === "prod" ? c.red("prod") : c.yellow("sandbox");
    const notes = findProjectNotes();
    const inner = width - 4;
    const line1 = ` ${p?.userName ?? ""} · ${c.bold(p?.workspaceName ?? "")} · ${env}`;
    const line2 = ` ${c.dim(`${process.cwd().replace(process.env.HOME ?? "", "~")}${notes ? ` (${notesFileName()})` : ""} · CLI ${VERSION}`)}`;
    const strip = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, "");
    const pad = (s: string) => s + " ".repeat(Math.max(0, inner + 1 - [...strip(s)].length));
    const title = local ? `─ ${b.name} · model: ${local.model.label} · ${tr("công cụ qua MCP", "tools over MCP")} ` : `─ ${b.aiName} `;
    say([
      c.cyan(`╭${title}${"─".repeat(Math.max(0, inner - title.length + 2))}╮`),
      `${c.cyan("│")}${pad(line1)} ${c.cyan("│")}`,
      `${c.cyan("│")}${pad(line2)} ${c.cyan("│")}`,
      c.cyan(`╰${"─".repeat(inner + 2)}╯`),
      c.dim(tr("  / lệnh · @ đính kèm · # ghi nhớ · Shift+Tab chế độ · Esc dừng · Ctrl+C thoát", "  / commands · @ attach · # note · Shift+Tab mode · Esc stop · Ctrl+C exit")),
    ].join("\n"));
    refreshUsage();
    void (async () => {
      if (props.resumed) await showHistory(props.sessionId, 6);
      for (const f of props.files) await addAttachment(f);
      if (props.initialQuestion) void send(props.initialQuestion);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── live redraw throttle ──────────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => {
      setLive(liveRef.current ? { ...liveRef.current } : null);
      setTick((x) => x + 1);
    }, 50);
    return () => clearInterval(t);
  }, [busy]);

  async function showHistory(id: string, last: number) {
    try {
      const msgs = ((await fetchHistory(id)) ?? []).slice(-last);
      for (const m of msgs) say(m.role === "User" ? c.bold(`› ${m.text}`) : `${markdown(m.text)}${renderBlocks(m.blocks?.filter((x) => x.type !== "text")).map((l) => `\n${l}`).join("")}`);
      if (msgs.length) say(c.dim(tr("  — tiếp tục hội thoại —", "  — conversation resumed —")));
    } catch (e) {
      sayErr(e);
    }
  }

  async function addAttachment(path: string) {
    try {
      const a = await attach(path, sessionId);
      setPending((p) => [...p, a]);
      say(c.dim(`  ⏺ ${tr("Đính kèm", "Attached")} ${a.name} · ${a.summary ?? ""}`));
    } catch (e) {
      sayErr(e);
    }
  }

  function pick(title: string, items: MenuItem[], initial = 0): Promise<string | undefined> {
    return new Promise((resolve) =>
      setModal({ kind: "select", title, items, initial, resolve: (v) => { setModal(null); resolve(v); } }),
    );
  }

  function askConfirm(p: ProposedAction): Promise<boolean> {
    return new Promise((resolve) => setModal({ kind: "confirm", proposal: p, typed: "", resolve: (yes) => { setModal(null); resolve(yes); } }));
  }

  // ── proposals ─────────────────────────────────────────────────────────────────────────────────
  async function handleProposal(p: ProposedAction) {
    if (!p.writes) {
      say(`  ${c.cyan("↗")} ${p.label}${p.confirmPrompt ? ` — ${p.confirmPrompt}` : ""}`);
      return;
    }
    const risk = riskOf(p);
    say(proposalCard(p).join("\n"));
    if (mode === "read") return say(c.dim(tr("  Chế độ chỉ đọc: không ghi. Shift+Tab để đổi.", "  Read-only mode: nothing written. Shift+Tab to change.")));
    if (risk === "device") return say(c.dim(tr(`  Việc chạm thiết bị / tự động hoá chỉ xác nhận trong app ${b.mobileApp}: ${context().endpoints.app}`, `  Device and automation actions are confirmed in the ${b.mobileApp} app: ${context().endpoints.app}`)));
    if (risk === "finance") return say(c.dim(tr(`  Việc tài chính chỉ xác nhận trong app: ${context().endpoints.app}`, `  Finance actions are confirmed in the app: ${context().endpoints.app}`)));
    const yes = mode === "auto" && risk === "normal" ? true : await askConfirm(p);
    if (!yes) return say(c.dim(tr(`  Không ghi gì. Đề xuất còn chờ tới khi hết hạn.`, `  Nothing written. The proposal waits until it expires.`)));
    try {
      const r = await confirmAction(sessionId, p);
      say(`${r.success ? c.green("✓") : c.yellow("⚠")} ${r.message}${renderBlocks(r.blocks).map((l) => `\n${l}`).join("")}${r.success ? c.dim(tr("  · hoàn tác: /undo", "  · undo: /undo")) : ""}`);
    } catch (e) {
      sayErr(e);
    }
  }

  // ── sending ───────────────────────────────────────────────────────────────────────────────────
  async function send(raw: string) {
    const text = raw.trim();
    if (!text) return;
    if (text.startsWith("/")) return runSlash(text);
    if (text.startsWith("#")) return note(text.slice(1).trim());
    const follow = /^[1-3]$/.test(text) ? lastOutcome?.done?.followUps?.[Number(text) - 1] : undefined;
    const question = follow ?? text;

    // @agent:code and @file mentions
    let thisAgent = agent;
    const atts = [...pending];
    for (const m of question.matchAll(/(^|\s)@(\S+)/g)) {
      const token = m[2]!;
      if (token.startsWith("agent:")) thisAgent = token.slice(6);
      else if (existsSync(token) && attachmentKind(token)) {
        try {
          atts.push(await attach(token, sessionId));
        } catch (e) {
          sayErr(e);
        }
      }
    }
    const clean = question.replace(/(^|\s)@agent:\S+/g, "$1").trim();
    setPending([]);
    lastSent.current = question;
    saveHistory(question);
    hist.push(question);
    histIdx.current = -1;
    say(`${c.bold("›")} ${question}${atts.length ? c.dim(`  [${atts.map((a) => a.name).join(", ")}]`) : ""}`);

    const notes = findProjectNotes();
    liveRef.current = { activities: [], text: "" };
    setLive(liveRef.current);
    setBusy(true);
    const ctl = new AbortController();
    abortRef.current = ctl;
    try {
      const onChunk = (ch: { type: string; text?: string | null; activity?: ActivityDto | null; agent?: AgentDto | null }) => {
        const l = liveRef.current!;
        if (ch.type === "token") l.text += ch.text ?? "";
        else if (ch.type === "activity" && ch.activity) l.activities.push(ch.activity);
        else if (ch.type === "agent" && ch.agent) l.agent = ch.agent;
        l.reconnecting = undefined;
      };
      if (local) {
        const skipped = atts.filter((a) => a.kind !== "text");
        if (skipped.length) say(c.yellow(tr(`  ⚠ Model riêng chỉ đọc tệp chữ; bỏ qua ${skipped.map((a) => a.name).join(", ")}.`, `  ⚠ Your own model reads text files only; skipped ${skipped.map((a) => a.name).join(", ")}.`)));
        const out = await local.ask({ text: composeText(clean, atts.filter((a) => a.kind === "text"), notes?.text), signal: ctl.signal, onChunk });
        setLastOutcome(out);
        say(renderAnswer(out));
        return;
      }
      const out = await ask({
        sessionId,
        text: composeText(clean, atts, notes?.text),
        attachments: atts,
        agent: thisAgent,
        signal: ctl.signal,
        onChunk,
        onRetry: (n) => liveRef.current && (liveRef.current.reconnecting = n),
      });
      setLastOutcome(out);
      if (out.sessionId && out.sessionId !== sessionId) setSessionId(out.sessionId);
      updateProfile(context().profile, { lastConversation: out.sessionId || sessionId });
      say(renderAnswer(out));
      if (out.proposedAction) await handleProposal(out.proposedAction);
      if (out.ended === "escalate") say(c.dim(tr("  Cần người hỗ trợ? /support <vấn đề>", "  Need a human? /support <problem>")));
      refreshUsage();
    } catch (e) {
      if (ctl.signal.aborted) say(c.dim(tr("  ⏹ Đã dừng.", "  ⏹ Stopped.")));
      else sayErr(e);
    } finally {
      abortRef.current = null;
      liveRef.current = null;
      setLive(null);
      setBusy(false);
    }
  }

  function renderAnswer(out: AskOutcome): string {
    const parts: string[] = [];
    if (out.agent && out.agent.code !== "general") parts.push(c.cyan(`● ${out.agent.name}`) + (out.agent.requestedDenied ? c.yellow(tr(" (Agent bạn chọn chưa mở cho gói này)", " (the Agent you chose is not in your plan)")) : ""));
    const tools = out.activities.filter((a) => a.kind === "tool");
    for (const a of tools) parts.push(c.dim(`  ⏺ ${a.label}`));
    if (out.text) parts.push(markdown(out.text).replace(/^/gm, "  "));
    parts.push(...renderBlocks(out.done?.blocks?.filter((x) => x.type !== "text")));
    for (const n of out.notices) if (n.message && !out.text.includes(n.message.slice(0, 24))) parts.push(`  ${c.yellow("⚠")} ${n.message}`);
    const fu = out.done?.followUps ?? [];
    if (fu.length) parts.push(c.dim(`  ↳ ${fu.map((f, i) => `${i + 1}) ${f}`).join("  ")}`));
    if (out.ended === "delivered_to_agent") parts.push(c.cyan(tr("  Đã chuyển tới nhân viên hỗ trợ.", "  Delivered to a support agent.")));
    return parts.join("\n");
  }

  function note(text: string) {
    if (!text) return;
    const f = join(process.cwd(), notesFileName());
    const existing = findProjectNotes();
    const target = existing?.path ?? f;
    appendFileSync(target, `${existsSync(target) ? "\n" : `# ${b.aiName}\n\n`}- ${text}\n`);
    say(`${c.green("✓")} ${tr(`Đã ghi vào ${relative(process.cwd(), target) || notesFileName()} — gửi kèm mọi câu hỏi trong thư mục này.`, `Saved to ${relative(process.cwd(), target) || notesFileName()} — sent with every question in this folder.`)}`);
  }

  // ── slash commands ────────────────────────────────────────────────────────────────────────────
  /** NextFarm versions of the slash commands whose server contract differs. True = handled. */
  async function farmSlash(cmd: string, arg: string): Promise<boolean> {
    switch (cmd) {
      case "undo": {
        const target = nf.undoTarget(arg || undefined);
        const ok = await pick(tr(`Hoàn tác "${target.label}"?`, `Undo "${target.label}"?`), [{ label: tr("Không", "No"), value: "n" }, { label: tr("Hoàn tác", "Undo"), value: "y" }]);
        if (ok === "y") say(`${c.green("✓")} ${await nf.undo(target)}`);
        return true;
      }
      case "why": {
        const id = arg || lastOutcome?.runId;
        if (!id) throw new Error(tr("Chưa có câu trả lời nào trong phiên này.", "No answer in this session yet."));
        say((await nf.runTrace(id)).join("\n"));
        return true;
      }
      case "memory": {
        const m = await nf.memories();
        const [sub, id] = arg.split(/\s+/);
        if (sub === "forget" && id) {
          const hit = m.items.find((x) => x.id.startsWith(id));
          if (!hit) throw new Error(tr("Không thấy điều nhớ này.", "Memory not found."));
          await nf.forgetMemory(hit.id);
          say(`${c.green("✓")} ${tr("Đã quên.", "Forgotten.")}`);
          return true;
        }
        say(m.items.length ? table(["ID", tr("Điều nhớ", "Memory"), tr("Dùng", "Uses")], m.items.map((x) => [x.id.slice(0, 8), x.display, x.uses])) + (m.canDelete ? c.dim("\n  /memory forget <id>") : "") : tr("  Trợ lý chưa nhớ gì về trang trại.", "  Nothing remembered about the farm yet."));
        return true;
      }
      case "schedule": {
        const m = /^"([^"]+)"\s+(daily|weekly)\s+(?:([1-7])@)?(\d{1,2}:\d{2})$/.exec(arg);
        if (m) {
          const [, q, freq, day, time] = m;
          const s = await nf.createSchedule(q!, freq as "daily" | "weekly", time!.padStart(5, "0"), day ? Number(day) : undefined);
          say(`${c.green("✓")} ${tr(`Đã lên lịch · ${s.when}`, `Scheduled · ${s.when}`)}\n${c.dim(tr(`  Mở mục Trợ lý AI trong app ${b.mobileApp} một lần để cho phép chạy nền.`, `  Open the AI assistant in the ${b.mobileApp} app once to allow background runs.`))}`);
        } else {
          const list = await nf.schedules();
          say((list.length ? table(["ID", tr("Tên", "Title"), tr("Lịch", "When"), tr("Lần tới", "Next")], list.map((s) => [s.id.slice(0, 8), s.title, s.when, s.nextRunAt.slice(0, 16).replace("T", " ")])) + "\n" : "") + c.dim(tr('  /schedule "nhật ký hôm qua" daily 07:00 · weekly 1@07:00 (1 = thứ Hai)', '  /schedule "yesterday\'s log" daily 07:00 · weekly 1@07:00 (1 = Monday)')));
        }
        return true;
      }
      case "sau-benh": {
        if (!arg) throw new Error(tr("Cần ảnh: /sau-benh <ảnh.jpg>", "Pass a photo: /sau-benh <photo.jpg>"));
        const [path, ...note] = arg.split(/\s+/);
        await addAttachment(path!);
        await send(note.length ? note.join(" ") : tr("Ảnh này cây bị sâu bệnh gì? Mức độ, cách xử lý và lô nào cần kiểm tra thêm.", "What pest or disease is in this photo? Severity, treatment and which plots to check."));
        return true;
      }
      case "thoi-tiet":
        await send(arg ? tr(`Thời tiết 3 ngày tới ở ${arg}, có ảnh hưởng gì tới việc phun, tưới, thu hoạch?`, `Weather for the next 3 days at ${arg} — any impact on spraying, irrigation, harvest?`)
          : tr("Thời tiết 3 ngày tới ở trang trại, có ảnh hưởng gì tới việc phun, tưới, thu hoạch?", "Weather for the next 3 days at the farm — any impact on spraying, irrigation, harvest?"));
        return true;
      case "ban-tin": {
        const brief = await nf.latestBrief();
        say(brief ? `${c.bold(brief.title)} ${c.dim(brief.createdAt.slice(0, 16).replace("T", " "))}\n${markdown(brief.text)}` : tr("  Chưa có bản tin sáng nào. Bật trong app: Trợ lý AI › Bản tin sáng.", "  No morning brief yet. Turn it on in the app: AI assistant › Morning brief."));
        return true;
      }
      default:
        return false;
    }
  }

  async function runSlash(line: string) {
    const [cmd0, ...rest] = line.slice(1).split(/\s+/);
    const cmd = (cmd0 ?? "").toLowerCase();
    const arg = rest.join(" ").trim();
    try {
      // Commands that belong to another backend behave like unknown ones.
      if (SLASH.some((s) => s.name === cmd) && !slashCommands().some((s) => s.name === cmd)) {
        say(`${c.yellow("⚠")} ${tr(`Không có lệnh /${cmd}.`, `No command /${cmd}.`)} ${c.dim("/help")}`);
        return;
      }
      if (b.platform === "nextfarm" && (await farmSlash(cmd, arg))) return;
      switch (cmd) {
        case "help":
        case "?": {
          const w = Math.max(...slashCommands().map((s) => s.name.length)) + 2;
          say([...slashCommands().map((s) => `  ${c.cyan(`/${s.name}`.padEnd(w + 1))} ${s.description()}`), "", ...SHORTCUTS.map((s) => `  ${s.keys.padEnd(30)} ${c.dim(s.description())}`)].join("\n"));
          break;
        }
        case "new": {
          const r = await openConversation(true);
          setSessionId(r.sessionId);
          setLastOutcome(undefined);
          say(c.dim(tr("  — hội thoại mới —", "  — new conversation —")));
          break;
        }
        case "resume": {
          let list = await listConversations(50);
          if (arg) list = list.filter((x) => `${x.title ?? ""} ${x.lastPreview ?? ""}`.toLowerCase().includes(arg.toLowerCase()));
          const id = await pick(tr("Mở lại hội thoại:", "Resume conversation:"), list.map((x) => ({ label: `${x.isPinned ? "📌 " : ""}${(x.title ?? x.lastPreview ?? x.sessionId).slice(0, 60)}`, hint: x.updatedAt.slice(0, 16).replace("T", " "), value: x.sessionId })));
          if (id) {
            setSessionId(id);
            await showHistory(id, 6);
          }
          break;
        }
        case "rename":
          await renameConversation(sessionId, arg || null);
          say(`${c.green("✓")} ${tr("Đã đặt tên.", "Renamed.")}`);
          break;
        case "pin": {
          const cur = (await listConversations(100)).find((x) => x.sessionId === sessionId);
          await pinConversation(sessionId, !cur?.isPinned);
          say(`${c.green("✓")} ${cur?.isPinned ? tr("Đã bỏ ghim.", "Unpinned.") : tr("Đã ghim.", "Pinned.")}`);
          break;
        }
        case "workspace":
        case "ws": {
          const list = await listWorkspaces();
          const cur = profile()?.workspaceId;
          const pickedId = arg ? undefined : await pick(tr("Chọn workspace:", "Choose a workspace:"), list.map((w) => ({ label: w.name, hint: [w.code, w.primaryGroupName].filter(Boolean).join(" · "), value: w.id })), Math.max(0, list.findIndex((w) => w.id === cur)));
          const target = arg ? findWorkspace(list, arg) : list.find((w) => w.id === pickedId);
          if (!target) break;
          await switchWorkspace(target);
          const r = await openConversation(true);
          setSessionId(r.sessionId);
          say(`${c.green("✓")} ${tr(`Đang làm việc trên ${c.bold(target.name)} · hội thoại mới`, `Now on ${c.bold(target.name)} · new conversation`)}`);
          refreshUsage();
          break;
        }
        case "agent": {
          agentsCache.current ??= await get<{ code: string; name: string; status: string }[]>("/ai/agents");
          const list = agentsCache.current;
          const code = arg || (await pick(tr("Chọn Agent:", "Choose an Agent:"), list.map((a) => ({ label: a.name, hint: a.status === "available" ? a.code : `${a.code} · ${a.status}`, value: a.code })), Math.max(0, list.findIndex((a) => a.code === (agent ?? "general")))));
          if (!code) break;
          const a = list.find((x) => x.code === code);
          if (!a) throw new Error(tr(`Không có Agent "${code}".`, `No Agent "${code}".`));
          setAgent(code === "general" ? undefined : code);
          updateProfile(context().profile, { agent: code === "general" ? undefined : code });
          say(`${c.green("✓")} Agent: ${c.bold(a.name)}${a.status !== "available" ? c.yellow(tr(" (chưa mở cho gói hiện tại — máy chủ sẽ dùng Trợ lý chung)", " (not in your plan — the server will use the general assistant)")) : ""}`);
          break;
        }
        case "mode": {
          const m = (arg as Mode) || MODES[(MODES.indexOf(mode) + 1) % MODES.length]!;
          if (!MODES.includes(m)) throw new Error("read | propose | auto");
          setMode(m);
          setContext({ mode: m });
          say(`  ${modeLabel(m)}`);
          break;
        }
        case "model": {
          if (!arg) {
            const rows = listModels();
            say([
              `  ${tr("Đang dùng", "Using")} ${c.bold(local ? local.model.label : b.aiName)}`,
              `  ${c.cyan(b.bin.padEnd(10))} ${b.aiName}`,
              ...rows.map((r) => `  ${c.cyan(r.name.padEnd(10))} ${r.entry.model ?? ""}${r.hasKey ? "" : c.yellow(tr(" (chưa có khoá)", " (no key)"))}`),
              c.dim(`  /model ${b.bin} · /model claude · /model ollama/<model> · ${b.bin} model add <nhà>`),
            ].join("\n"));
            break;
          }
          const m = resolveModel(arg);
          setLocal(m ? new LocalChat(m, true, mode === "read") : undefined);
          say(`${c.green("✓")} ${m ? `${tr("Model của bạn", "Your model")}: ${m.label} · ${tr("công cụ qua MCP, ghi chỉ bằng link xác nhận, không trừ lượt AI", "tools over MCP, writes only via a confirmation link, no AI turns used")}` : b.aiName}`);
          break;
        }
        case "attach":
          if (!arg) throw new Error(tr("Cần đường dẫn tệp.", "Pass a file path."));
          await addAttachment(arg);
          break;
        case "pending": {
          const p = await get<{ changesets: { id: string; title: string; status: string; expiresAt: string }[]; questions: unknown[] }>("/ai/pending", { query: { take: 20 } });
          say(p.changesets.length ? table(["ID", tr("Việc", "Change"), tr("Trạng thái", "Status"), tr("Hết hạn", "Expires")], p.changesets.map((x) => [x.id.slice(0, 8), x.title, x.status, x.expiresAt.slice(0, 16).replace("T", " ")])) + c.dim(`\n  ${b.bin} ai apply <id> · ${b.bin} ai reject <id>`) : tr("  Không có việc nào đang chờ.", "  Nothing is waiting."));
          break;
        }
        case "journal": {
          const j = await get<{ items: { id: string; title: string; status: string; undoable: boolean; undoUntil?: string | null; createdAt: string }[] }>("/ai/journal", { query: { pageSize: 15 } });
          say(j.items.length ? table(["ID", tr("Việc", "Change"), tr("Trạng thái", "Status"), tr("Hoàn tác tới", "Undo until")], j.items.map((x) => [x.id.slice(0, 8), x.title, x.status, x.undoable ? (x.undoUntil ?? "").slice(0, 10) : "—"])) : tr("  Nhật ký trống.", "  The journal is empty."));
          break;
        }
        case "undo": {
          const j = await get<{ items: { id: string; title: string; undoable: boolean }[] }>("/ai/journal", { query: { pageSize: 30 } });
          const target = arg ? j.items.find((x) => x.id.startsWith(arg)) : j.items.find((x) => x.undoable);
          if (!target) throw new Error(tr("Không có việc nào hoàn tác được.", "Nothing to undo."));
          const ok = await pick(tr(`Hoàn tác "${target.title}"?`, `Undo "${target.title}"?`), [{ label: tr("Không", "No"), value: "n" }, { label: tr("Hoàn tác", "Undo"), value: "y" }]);
          if (ok !== "y") break;
          const r = await post<{ reverted?: number; conflicts?: number }>(`/ai/changesets/${target.id}/undo`, {});
          say(`${c.green("✓")} ${tr(`Đã hoàn tác${r.reverted ? ` ${r.reverted} dòng` : ""}${r.conflicts ? `, ${r.conflicts} dòng xung đột không ghi đè` : ""}.`, `Undone${r.reverted ? ` ${r.reverted} rows` : ""}${r.conflicts ? `, ${r.conflicts} conflicts left untouched` : ""}.`)}`);
          break;
        }
        case "why": {
          const id = arg || lastOutcome?.runId;
          if (!id) throw new Error(tr("Chưa có câu trả lời nào trong phiên này.", "No answer in this session yet."));
          const run = await get<Record<string, unknown>>(`/ai/runs/${id}`);
          say(runLines(run).join("\n"));
          break;
        }
        case "memory": {
          const list = await get<{ id: string; display: string; kind: string; uses: number; lockedBy?: string | null }[]>("/ai/memory");
          say(list.length ? table(["ID", tr("Điều nhớ", "Memory"), tr("Dùng", "Uses"), ""], list.map((m) => [m.id.slice(0, 8), m.display, m.uses, m.lockedBy ? "🔒" : ""])) + c.dim(`\n  ${b.bin} ai memory edit|lock|forget <id>`) : tr("  AI chưa nhớ gì về công ty.", "  Nothing remembered yet."));
          break;
        }
        case "schedule": {
          const m = /^"([^"]+)"\s+(daily|weekly|monthly)\s+(?:(\d+)@)?(\d{1,2}:\d{2})$/.exec(arg);
          if (m) {
            const [, q, freq, day, time] = m;
            const s = await post<{ nextRunAt: string }>("/ai/schedules", { title: q!.slice(0, 60), question: q, agentCode: agent ?? null, frequency: freq, timeOfDay: time, dayOfWeek: freq === "weekly" ? Number(day ?? 1) : null, dayOfMonth: freq === "monthly" ? Number(day ?? 1) : null, enabled: true });
            say(`${c.green("✓")} ${tr(`Đã lên lịch · lần tới ${s.nextRunAt.slice(0, 16).replace("T", " ")}`, `Scheduled · next ${s.nextRunAt.slice(0, 16).replace("T", " ")}`)}`);
          } else {
            const list = await get<{ id: string; title: string; frequency: string; timeOfDay: string; nextRunAt: string; enabled: boolean }[]>("/ai/schedules");
            say((list.length ? table(["ID", tr("Tên", "Title"), tr("Lịch", "When"), tr("Lần tới", "Next")], list.map((s) => [s.id.slice(0, 8), s.title, `${s.frequency} ${s.timeOfDay}`, s.nextRunAt.slice(0, 16).replace("T", " ")])) + "\n" : "") + c.dim(tr('  /schedule "doanh thu hôm qua" daily 08:00 · weekly 1@08:00 · monthly 1@08:00', '  /schedule "yesterday\'s revenue" daily 08:00 · weekly 1@08:00 · monthly 1@08:00')));
          }
          break;
        }
        case "library": {
          const list = await get<{ kind: string; name: string; createdAt: string }[]>("/ai/library");
          say(list.length ? table(["#", tr("Loại", "Kind"), tr("Tên", "Name"), tr("Lúc", "At")], list.slice(0, 20).map((x, i) => [i + 1, x.kind, x.name, x.createdAt.slice(0, 16).replace("T", " ")])) + c.dim(`\n  ${b.bin} ai library get <#>`) : tr("  Thư viện trống.", "  The library is empty."));
          break;
        }
        case "export": {
          const [fmt = "md", file] = arg.split(/\s+/);
          const msgs = (await fetchHistory(sessionId)) ?? [];
          const out = file ?? `${b.bin}-${sessionId.slice(0, 8)}.${fmt === "json" ? "json" : "md"}`;
          writeFileSync(out, fmt === "json" ? JSON.stringify(msgs, null, 2) : msgs.map((m) => `${m.role === "User" ? "## " : ""}${m.text}\n`).join("\n"));
          say(`${c.green("✓")} ${tr(`Đã xuất ${msgs.length} tin → ${out}`, `Exported ${msgs.length} messages → ${out}`)}`);
          break;
        }
        case "tools": {
          const { publicTools } = await import("../commands/tools.js");
          const list = await publicTools();
          const by = new Map<string, number>();
          for (const t of list) by.set(t.module, (by.get(t.module) ?? 0) + 1);
          say([...by.entries()].map(([m, n]) => `  ${m.padEnd(12)} ${n}`).join("\n") + c.dim(tr(`\n  ${b.bin} tools list · ${b.bin} tools describe <tên>`, `\n  ${b.bin} tools list · ${b.bin} tools describe <name>`)));
          break;
        }
        case "usage": {
          const u = await fetchUsage();
          say(`  ${tr("Gói", "Plan")} ${c.bold(u.planName ?? "-")} · ${tr("đã dùng", "used")} ${u.used ?? 0}${u.limit ? `/${u.limit}` : ""} · ${tr("mở lại", "resets")} ${u.resetsAt?.slice(0, 10) ?? ""}`);
          break;
        }
        case "feedback": {
          const id = lastOutcome?.done?.messageId;
          if (!id) throw new Error(tr("Chưa có câu trả lời để góp ý.", "No answer to rate yet."));
          await feedback(id, arg !== "down");
          say(`${c.green("✓")} ${tr("Cảm ơn bạn đã góp ý.", "Thanks for the feedback.")}`);
          break;
        }
        case "support": {
          if (!arg) throw new Error(tr("Ghi rõ vấn đề: /support <vấn đề>", "Describe it: /support <problem>"));
          const r = await escalate(sessionId, arg);
          say(`${c.green("✓")} ${tr(`Đã chuyển cho nhân viên (${r.status}) · chờ khoảng ${r.estimatedWaitMinutes} phút`, `Handed over (${r.status}) · about ${r.estimatedWaitMinutes} min`)}`);
          break;
        }
        case "status": {
          const p = profile();
          say([`  ${c.bold(p?.userName ?? "")} ${c.dim(p?.userEmail ?? "")}`, `  ${p?.workspaceName ?? ""} · ${context().env} · ${context().endpoints.api}`, `  Agent ${agent ?? "general"} · ${modeLabel(mode)} · ${usageText}`, `  CLI ${VERSION} · ${tr("hồ sơ", "profile")} ${context().profile}`].join("\n"));
          break;
        }
        case "doctor": {
          const { doctor } = await import("../commands/util.js");
          const checks = await doctor();
          say(checks.map((ch) => `  ${ch.ok === true ? c.green("✓") : ch.ok === "warn" ? c.yellow("⚠") : c.red("✗")} ${ch.name.padEnd(14)} ${ch.detail}`).join("\n"));
          break;
        }
        case "config": {
          const cfg = loadConfig() as unknown as Record<string, unknown>;
          const [k, v] = arg.split(/\s+/);
          if (k && v !== undefined) {
            const { SETTABLE } = await import("../core/config.js");
            const parse = SETTABLE[k];
            if (!parse) throw new Error(Object.keys(SETTABLE).join(", "));
            cfg[k] = parse(v);
            saveConfig(cfg as never);
            say(`${c.green("✓")} ${k} = ${String(cfg[k])}`);
          } else say(["lang", "mode", "updateChannel", "updateCheck", "telemetry"].map((x) => `  ${x.padEnd(14)} ${String(cfg[x] ?? "—")}`).join("\n"));
          break;
        }
        case "init": {
          const f = join(process.cwd(), notesFileName());
          if (existsSync(f)) throw new Error(tr(`${notesFileName()} đã có.`, `${notesFileName()} already exists.`));
          writeFileSync(f, tr(`# Chỉ dẫn cho ${b.aiName}\n\n- Bối cảnh: …\n- Quy ước: …\n`, `# Instructions for ${b.aiName}\n\n- Context: …\n- Conventions: …\n`));
          say(`${c.green("✓")} ${tr(`Đã tạo ${notesFileName()} — sửa tệp rồi hỏi tiếp.`, `Created ${notesFileName()} — edit it and keep asking.`)}`);
          break;
        }
        case "mcp":
          say(`  ${context().endpoints.mcp}\n${c.dim(`  ${b.bin} mcp install`)}`);
          break;
        case "logout":
          await logoutServer();
          deleteSession(context().profile);
          say(`${c.green("✓")} ${tr("Đã đăng xuất.", "Logged out.")}`);
          setTimeout(() => exit(), 50);
          break;
        case "clear":
          stdout?.write("\u001b[2J\u001b[3J\u001b[H");
          setDone([]);
          break;
        case "exit":
        case "quit":
          exit();
          break;
        default: {
          const near = matchSlash(cmd).map((s) => `/${s.name}`).slice(0, 3);
          say(`${c.yellow("⚠")} ${tr(`Không có lệnh /${cmd}.`, `No command /${cmd}.`)}${near.length ? ` ${tr("Ý bạn là", "Did you mean")} ${near.join(", ")}?` : ""} ${c.dim("/help")}`);
        }
      }
    } catch (e) {
      sayErr(e);
    }
  }

  // ── menus ─────────────────────────────────────────────────────────────────────────────────────
  const menuItems: MenuItem[] = (() => {
    if (menuOff || modal || busy) return [];
    if (/^\/\S*$/.test(value)) return matchSlash(value).map((s) => ({ label: `/${s.name}`, hint: s.description(), value: `/${s.name}` }));
    const at = /(^|\s)@(\S*)$/.exec(value.slice(0, cursor));
    if (at) {
      const q = at[2]!.toLowerCase();
      filesCache.current ??= attachableFiles();
      const agents = (agentsCache.current ?? []).map((a) => ({ label: `@agent:${a.code}`, hint: a.name, value: `@agent:${a.code}` }));
      const files = filesCache.current.map((f) => ({ label: `@${f}`, hint: attachmentKind(f) ?? "", value: `@${f}` }));
      return [...files, ...agents].filter((i) => i.label.toLowerCase().includes(q)).slice(0, 50);
    }
    return [];
  })();

  useEffect(() => {
    if (/(^|\s)@\S*$/.test(value) && !agentsCache.current) get<{ code: string; name: string; status: string }[]>("/ai/agents").then((a) => (agentsCache.current = a)).catch(() => undefined);
    setMenuIndex(0);
  }, [value]);

  function applyMenu(item: MenuItem) {
    if (item.value.startsWith("/")) {
      const v = `${item.value} `;
      setValue(v);
      setCursor(v.length);
      return;
    }
    const before = value.slice(0, cursor).replace(/@\S*$/, `${item.value} `);
    const v = before + value.slice(cursor);
    setValue(v);
    setCursor(before.length);
  }

  // ── keys ──────────────────────────────────────────────────────────────────────────────────────
  useInput((input, key) => {
    if (modal?.kind === "select") return; // Select handles its own keys
    if (modal?.kind === "confirm") {
      const p = modal.proposal;
      const large = riskOf(p) === "large";
      if (key.escape || (key.ctrl && input === "c")) return modal.resolve(false);
      if (large) {
        if (key.return) return modal.resolve(modal.typed === confirmWord(p));
        if (key.backspace || key.delete) return setModal({ ...modal, typed: modal.typed.slice(0, -1) });
        if (input && !key.ctrl && !key.meta) return setModal({ ...modal, typed: modal.typed + input });
        return;
      }
      if (input === "y" || input === "Y") return modal.resolve(true);
      if (input === "n" || input === "N" || key.return) return modal.resolve(false);
      if (input === "d" || input === "D") {
        let pretty = p.payloadJson;
        try {
          pretty = JSON.stringify(JSON.parse(p.payloadJson), null, 2);
        } catch {
          // raw
        }
        say(c.dim(pretty.split("\n").map((l) => `    ${l}`).join("\n")));
      }
      return;
    }

    if (key.ctrl && input === "c") {
      if (busy) return abortRef.current?.abort();
      if (value) {
        setValue("");
        setCursor(0);
        return;
      }
      if (Date.now() - ctrlC.current < 1500) return exit();
      ctrlC.current = Date.now();
      say(c.dim(tr("  Nhấn Ctrl+C lần nữa để thoát.", "  Press Ctrl+C again to exit.")));
      return;
    }
    if (key.ctrl && input === "d") {
      if (!value) exit();
      return;
    }
    if (key.escape) {
      if (busy) return abortRef.current?.abort();
      if (menuItems.length) return setMenuOff(true);
      if (Date.now() - lastEsc.current < 600 && lastSent.current) {
        setValue(lastSent.current);
        setCursor(lastSent.current.length);
      }
      lastEsc.current = Date.now();
      return;
    }
    if (key.ctrl && input === "l") {
      stdout?.write("\u001b[2J\u001b[3J\u001b[H");
      setDone([]);
      return;
    }
    if (key.ctrl && input === "o") {
      const acts = lastOutcome?.activities ?? [];
      say(acts.length ? acts.map((a) => `  ${a.kind === "tool" ? c.cyan("⏺") : c.dim("·")} ${a.label}${a.elapsedMs ? c.dim(`  +${(a.elapsedMs / 1000).toFixed(1)}s`) : ""}`).join("\n") : c.dim(tr("  Chưa có bước nào.", "  No steps yet.")));
      return;
    }
    if (key.tab && key.shift) {
      const m = MODES[(MODES.indexOf(mode) + 1) % MODES.length]!;
      setMode(m);
      setContext({ mode: m });
      return;
    }
    if (busy) return;

    if (menuItems.length && (key.upArrow || key.downArrow)) {
      setMenuIndex((i) => (i + (key.upArrow ? -1 : 1) + menuItems.length) % menuItems.length);
      return;
    }
    if (menuItems.length && key.tab) return applyMenu(menuItems[menuIndex]!);
    if (key.return) {
      // "\" at end of line or Alt+Enter = new line
      if (key.meta || value.slice(0, cursor).endsWith("\\")) {
        const base = value.slice(0, cursor).endsWith("\\") ? value.slice(0, cursor - 1) + value.slice(cursor) : value;
        const at = value.slice(0, cursor).endsWith("\\") ? cursor - 1 : cursor;
        const [v, cur] = edit.insert(base, at, "\n");
        setValue(v);
        setCursor(cur);
        return;
      }
      if (menuItems.length && value.startsWith("/") && !value.includes(" ")) {
        const chosen = menuItems[menuIndex]!.value;
        setValue("");
        setCursor(0);
        void send(chosen);
        return;
      }
      if (menuItems.length && !value.startsWith("/")) return applyMenu(menuItems[menuIndex]!);
      const v = value;
      setValue("");
      setCursor(0);
      setMenuOff(false);
      void send(v);
      return;
    }
    if (key.upArrow && !value.includes("\n")) {
      if (!hist.length) return;
      histIdx.current = histIdx.current < 0 ? hist.length - 1 : Math.max(0, histIdx.current - 1);
      const h = hist[histIdx.current]!;
      setValue(h);
      setCursor(h.length);
      return;
    }
    if (key.downArrow && !value.includes("\n")) {
      if (histIdx.current < 0) return;
      histIdx.current += 1;
      const h = histIdx.current >= hist.length ? "" : hist[histIdx.current]!;
      if (histIdx.current >= hist.length) histIdx.current = -1;
      setValue(h);
      setCursor(h.length);
      return;
    }
    if (key.leftArrow) return setCursor((x) => Math.max(0, x - 1));
    if (key.rightArrow) return setCursor((x) => Math.min(value.length, x + 1));
    if (key.ctrl && input === "a") return setCursor(edit.home(value, cursor));
    if (key.ctrl && input === "e") return setCursor(edit.end(value, cursor));
    if (key.ctrl && input === "u") {
      setValue(value.slice(cursor));
      setCursor(0);
      return;
    }
    if (key.ctrl && input === "w") {
      const [v, cur] = edit.wordBack(value, cursor);
      setValue(v);
      setCursor(cur);
      return;
    }
    if (key.backspace || key.delete) {
      const [v, cur] = key.delete && !key.backspace && cursor < value.length && process.platform !== "darwin" ? edit.del(value, cursor) : edit.backspace(value, cursor);
      setValue(v);
      setCursor(cur);
      setMenuOff(false);
      return;
    }
    // A pasted single line ending in Enter is sent; multi-line pastes stay in the editor.
    if (input && input.length > 1 && input.endsWith("\r") && !/[\r\n]/.test(input.slice(0, -1)) && !key.ctrl && !key.meta) {
      const [v] = edit.insert(value, cursor, input.slice(0, -1));
      setValue("");
      setCursor(0);
      void send(v);
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      const [v, cur] = edit.insert(value, cursor, input.replace(/\r/g, "\n"));
      setValue(v);
      setCursor(cur);
      if (input === "/" || input === "@") setMenuOff(false);
    }
  });

  // ── view ──────────────────────────────────────────────────────────────────────────────────────
  const p = profile();
  const footerRight = c.dim(`${p?.workspaceName ?? ""} · ${context().env}${local ? ` · ${local.model.label}` : usageText ? ` · ${usageText}` : ""}${agent && !local ? ` · ${agent}` : ""}`);
  const lastReason = live?.activities.filter((a) => a.kind !== "tool").at(-1);

  return (
    <Box flexDirection="column">
      <Static items={done}>{(it) => <Text key={it.id}>{it.text}</Text>}</Static>
      {live ? (
        <Box flexDirection="column" marginTop={0}>
          {live.agent && live.agent.code !== "general" ? <Text color="cyan">{`● ${live.agent.name}`}</Text> : null}
          {live.activities.filter((a) => a.kind === "tool").map((a, i) => (
            <Text key={i} color="gray">{`  ⏺ ${a.label}`}</Text>
          ))}
          {live.text ? <Text>{markdown(live.text).replace(/^/gm, "  ")}</Text> : null}
          <Text color="gray">
            <Spinner type="dots" /> {live.reconnecting ? tr(`Mất kết nối, đang nối lại (${live.reconnecting}/2)…`, `Reconnecting (${live.reconnecting}/2)…`) : (lastReason?.label ?? tr("Đang nghĩ…", "Thinking…"))}
            {"  "}
            <Text dimColor>{tr("Esc dừng", "Esc to stop")}</Text>
          </Text>
        </Box>
      ) : null}
      {modal?.kind === "select" ? (
        <Select title={modal.title} items={modal.items} initial={modal.initial} onPick={modal.resolve} hint={tr("↑↓ chọn · Enter · Esc huỷ", "↑↓ choose · Enter · Esc cancel")} />
      ) : modal?.kind === "confirm" ? (
        <Box marginTop={0}>
          {riskOf(modal.proposal) === "large" ? (
            <Text>
              {c.yellow("└ ")}
              {tr(`Gõ ${c.bold(confirmWord(modal.proposal))} để xác nhận, Enter để huỷ`, `Type ${c.bold(confirmWord(modal.proposal))} to confirm, Enter to cancel`)} › {modal.typed}
              <Text inverse> </Text>
            </Text>
          ) : (
            <Text>
              {c.yellow("└ ")}
              {tr("Ghi?", "Write?")} {c.bold("[y]")} {tr("có", "yes")}  {c.bold("[n]")} {tr("không", "no")}  {c.bold("[d]")} {tr("xem dữ liệu", "show data")}
            </Text>
          )}
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          {pending.length ? <Text color="gray">{`  📎 ${pending.map((a) => a.name).join(", ")}`}</Text> : null}
          <Editor value={value} cursor={cursor} disabled={busy} placeholder={busy ? "" : tr(`Hỏi ${b.aiName}… (/ để xem lệnh)`, `Ask ${b.aiName}… (/ for commands)`)} />
          {menuItems.length ? <Menu items={menuItems} index={menuIndex} /> : null}
          <Box justifyContent="space-between" width={width}>
            <Text>{`  ${modeLabel(mode)} ${c.dim("(Shift+Tab)")}`}</Text>
            <Text>{footerRight}</Text>
          </Box>
        </Box>
      )}
    </Box>
  );
}
