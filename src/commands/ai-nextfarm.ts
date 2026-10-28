// `ai` subcommands whose NextFarm contract differs from the default platform: proposals instead of changesets, weekly quota,
// farm memory, scheduled questions, morning brief, pest photos. Conversation commands are shared (ai.ts).
import type { Command } from "commander";
import { brand } from "../core/brand.js";
import { CliError, Exit } from "../core/errors.js";
import { tr } from "../core/i18n.js";
import { c, emit, info, ok, table } from "../core/output.js";
import { get } from "../core/http.js";
import { hasTty, confirm } from "../core/prompt.js";
import { requirePerson } from "../auth/session.js";
import * as nf from "../ai/nextfarm.js";
import { feedback, usage } from "../ai/client.js";
import { markdown } from "../repl/markdown.js";
import { runRoot } from "./ai.js";
import type { RootFlags } from "../program.js";

const when = (s: string) => s.slice(0, 16).replace("T", " ");

export function registerAiNextFarm(ai: Command, program: Command): void {
  ai.command("why [runId]")
    .description(tr("vì sao trợ lý trả lời vậy: các bước, công cụ đã gọi", "why the assistant answered that way: steps and tools"))
    .action(async (runId?: string) => {
      await requirePerson();
      const id = runId ?? (await get<{ items?: { run_id?: string; id?: string }[] }>("/ai/agent-runs", { query: { page_size: 1 } })).items?.[0];
      const rid = typeof id === "string" ? id : id?.run_id ?? id?.id;
      if (!rid) throw new CliError(tr("Chưa có lượt chạy nào.", "No runs yet."), Exit.notFound);
      const lines = await nf.runTrace(rid);
      emit({ runId: rid, steps: lines }, () => info(lines.join("\n")));
    });

  ai.command("apply <proposalId>").description(tr("xác nhận một đề xuất ghi (ghi thật)", "approve a proposed write (real write)"))
    .action(async (proposalId: string) => {
      await requirePerson();
      if (hasTty() && !(await confirm(tr(`Ghi đề xuất ${proposalId.slice(0, 8)}?`, `Write proposal ${proposalId.slice(0, 8)}?`)))) return;
      // Device, automation and money lines are refused by the server for the CLI (403 proposal.requires_app).
      const r = await nf.confirmAction("", { kind: "", label: proposalId.slice(0, 8), confirmPrompt: "", payloadJson: "{}", writes: true, nonce: proposalId });
      emit(r, () => (r.success ? ok(r.message) : info(c.yellow(`⚠ ${r.message}`))));
      if (!r.success) process.exitCode = Exit.notConfirmed;
    });

  ai.command("reject <proposalId>").description(tr("từ chối một đề xuất ghi", "reject a proposed write"))
    .action(async (proposalId: string) => {
      await nf.rejectAction(proposalId);
      ok(tr("Đã từ chối.", "Rejected."));
    });

  ai.command("undo <proposalId>").description(tr("hoàn tác đề xuất đã ghi (trong 24 giờ)", "undo a written proposal (within 24 hours)"))
    .action(async (proposalId: string) => {
      if (hasTty() && !(await confirm(tr("Hoàn tác?", "Undo?")))) return;
      ok(await nf.undo(nf.undoTarget(proposalId)));
    });

  const mem = ai.command("memory").description(tr("trợ lý đang nhớ gì về trang trại", "what the assistant remembers about the farm"));
  mem.command("list", { isDefault: true }).action(async () => {
    const m = await nf.memories();
    emit(m.items, () => info(m.items.length ? table(["ID", tr("Điều nhớ", "Memory"), tr("Dùng", "Uses")], m.items.map((x) => [x.id.slice(0, 8), x.display, x.uses])) : tr("Trợ lý chưa nhớ gì.", "Nothing remembered yet.")));
  });
  mem.command("forget <id>").description(tr("quên một điều (chỉ chủ trại)", "forget one item (farm owner only)")).action(async (id: string) => {
    const hit = (await nf.memories()).items.find((x) => x.id.startsWith(id));
    if (!hit) throw new CliError(tr("Không thấy điều nhớ này.", "Memory not found."), Exit.notFound);
    await nf.forgetMemory(hit.id);
    ok(tr("Đã quên.", "Forgotten."));
  });

  const sch = ai.command("schedule").description(tr("câu hỏi chạy định kỳ", "recurring questions"));
  sch.command("list", { isDefault: true }).action(async () => {
    const list = await nf.schedules();
    emit(list, () => info(table(["ID", tr("Tên", "Title"), tr("Lịch", "When"), tr("Lần tới", "Next")], list.map((s) => [s.id.slice(0, 8), s.title, s.when, when(s.nextRunAt)]))));
  });
  sch.command("add <question>")
    .requiredOption("--at <HH:mm>", tr("giờ chạy (giờ Việt Nam)", "time (Vietnam time)"))
    .option("--weekday <1-7>", tr("chỉ một ngày trong tuần (1 = thứ Hai); bỏ trống = hằng ngày", "one weekday only (1 = Monday); omit = daily"))
    .action(async (question: string, o: { at: string; weekday?: string }) => {
      const s = await nf.createSchedule(question, o.weekday ? "weekly" : "daily", o.at.padStart(5, "0"), o.weekday ? Number(o.weekday) : undefined);
      emit(s, () => {
        ok(tr(`Đã lên lịch · ${s.when}`, `Scheduled · ${s.when}`));
        info(c.dim(tr(`  Mở mục Trợ lý AI trong app ${brand().mobileApp} một lần để cho phép chạy nền.`, `  Open the AI assistant in the ${brand().mobileApp} app once to allow background runs.`)));
      });
    });
  sch.command("run <id>").action(async (id: string) => {
    const hit = (await nf.schedules()).find((s) => s.id.startsWith(id));
    if (!hit) throw new CliError(tr("Không thấy lịch.", "Schedule not found."), Exit.notFound);
    await nf.runSchedule(hit.id);
    ok(tr("Đã chạy.", "Run started."));
  });
  sch.command("delete <id>").action(async (id: string) => {
    const hit = (await nf.schedules()).find((s) => s.id.startsWith(id));
    if (!hit) throw new CliError(tr("Không thấy lịch.", "Schedule not found."), Exit.notFound);
    await nf.deleteSchedule(hit.id);
    ok(tr("Đã xoá.", "Deleted."));
  });

  ai.command("brief").description(tr("bản tin sáng mới nhất", "latest morning brief"))
    .action(async () => {
      const b = await nf.latestBrief();
      emit(b ?? null, () => info(b ? `${c.bold(b.title)} ${c.dim(when(b.createdAt))}\n${markdown(b.text)}` : tr("Chưa có bản tin sáng.", "No morning brief yet.")));
    });

  ai.command("pest <photo> [note...]").description(tr("chẩn đoán sâu bệnh từ ảnh", "diagnose pests and diseases from a photo"))
    .action(async (photo: string, note: string[]) => {
      const root = program.opts<RootFlags>();
      const q = note.length ? note.join(" ") : tr("Ảnh này cây bị sâu bệnh gì? Mức độ, cách xử lý và lô nào cần kiểm tra thêm.", "What pest or disease is in this photo? Severity, treatment and which plots to check.");
      await runRoot({ ...root, print: q, file: [photo, ...(root.file ?? [])] }, []);
    });

  ai.command("usage").description(tr("câu hỏi AI còn lại tuần này", "AI questions left this week"))
    .action(async () => {
      const u = await usage();
      emit(u, () => info(tr(`Tuần này: đã dùng ${u.used}/${u.limit} câu · còn ${u.remaining} · mở lại 00:00 thứ Hai`, `This week: ${u.used}/${u.limit} used · ${u.remaining} left · resets Monday 00:00`)));
    });

  ai.command("feedback <runId> <vote>").description(tr("báo câu trả lời tốt (up) / chưa tốt (down)", "rate an answer: up / down"))
    .action(async (runId: string, vote: string) => {
      await feedback(runId, vote === "up");
      ok(tr("Cảm ơn bạn đã góp ý.", "Thanks for the feedback."));
    });
}
