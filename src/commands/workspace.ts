import type { Command } from "commander";
import { context } from "../core/context.js";
import { CliError, Exit } from "../core/errors.js";
import { tr } from "../core/i18n.js";
import { c, emit, info, ok, table } from "../core/output.js";
import { getProfile } from "../core/config.js";
import { hasTty, select } from "../core/prompt.js";
import { findWorkspace, listWorkspaces, requirePerson, switchWorkspace, type WorkspaceSummary } from "../auth/session.js";

export async function pickWorkspace(key?: string): Promise<WorkspaceSummary> {
  await requirePerson();
  const list = await listWorkspaces();
  if (key) {
    const w = findWorkspace(list, key);
    if (!w) throw new CliError(tr(`Không thấy workspace "${key}".`, `Workspace "${key}" not found.`), Exit.notFound, tr("Xem danh sách: workspace list", "See: workspace list"));
    return w;
  }
  if (!hasTty()) throw new CliError(tr("Cần mã workspace khi không có terminal.", "Pass a workspace code without a terminal."), Exit.usage);
  const cur = getProfile(context().profile)?.workspaceId;
  const w = await select(
    tr("Chọn workspace:", "Choose a workspace:"),
    list.map((x) => ({ label: x.name, hint: [x.code, x.primaryGroupName, x.id === cur ? tr("đang dùng", "current") : ""].filter(Boolean).join(" · "), value: x })),
    Math.max(0, list.findIndex((x) => x.id === cur)),
  );
  if (!w) throw new CliError(tr("Đã huỷ.", "Cancelled."), Exit.interrupted);
  return w;
}

export function registerWorkspace(program: Command): void {
  const ws = program.command("workspace").alias("ws").description(tr("các workspace (công ty) của bạn", "your workspaces (companies)"));
  ws.command("list", { isDefault: true })
    .description(tr("danh sách workspace", "list workspaces"))
    .action(async () => {
      await requirePerson();
      const list = await listWorkspaces();
      const cur = getProfile(context().profile)?.workspaceId;
      emit(list.map((w) => ({ ...w, current: w.id === cur })), () =>
        info(table(["", tr("Tên", "Name"), tr("Mã", "Code"), tr("Vai trò", "Role"), tr("Trạng thái", "Status")], list.map((w) => [
          w.id === cur ? c.green("●") : "", w.name, w.code, w.primaryGroupName ?? "", w.status ?? "",
        ]))),
      );
    });
  ws.command("use [code]")
    .description(tr("đổi workspace đang làm việc (lưu vào hồ sơ)", "switch the working workspace (saved in the profile)"))
    .action(async (code?: string) => {
      const w = await pickWorkspace(code);
      await switchWorkspace(w);
      emit({ workspace: w }, () => ok(tr(`Đang làm việc trên ${c.bold(w.name)}`, `Now working on ${c.bold(w.name)}`)));
    });
}
