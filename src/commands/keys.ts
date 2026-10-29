import type { Command } from "commander";
import { brand } from "../core/brand.js";
import { CliError, Exit } from "../core/errors.js";
import { tr } from "../core/i18n.js";
import { c, emit, info, ok, table, warn } from "../core/output.js";
import { get, post, del } from "../core/http.js";
import { confirm, hasTty } from "../core/prompt.js";
import { requirePerson } from "../auth/session.js";

interface ApiKey {
  id: string;
  name: string;
  keyPrefix: string;
  isActive: boolean;
  expiresAt?: string | null;
  revokedAt?: string | null;
  description?: string | null;
  createdAt: string;
  scopes: string[];
  source?: string;
}

/** 90d, 12h, 2w → ISO date from now. */
export function parseDuration(s: string): string {
  const m = /^(\d+)([hdwmy])$/.exec(s.trim());
  if (!m) throw new CliError(tr(`Thời hạn không hợp lệ: ${s} (vd 30d, 12h, 6m, 1y)`, `Invalid duration: ${s} (e.g. 30d, 12h, 6m, 1y)`), Exit.usage);
  const n = Number(m[1]);
  const ms = { h: 3600e3, d: 86400e3, w: 7 * 86400e3, m: 30 * 86400e3, y: 365 * 86400e3 }[m[2] as "h" | "d" | "w" | "m" | "y"];
  return new Date(Date.now() + n * ms).toISOString();
}

async function findKey(id: string): Promise<ApiKey> {
  const k = (await get<ApiKey[]>("/iam/api-keys")).find((x) => x.id === id || x.id.startsWith(id) || x.keyPrefix === id || x.name === id);
  if (!k) throw new CliError(tr("Không thấy khoá này.", "Key not found."), Exit.notFound);
  return k;
}

const scopeExample = () => brand().examples.scopes;

export function registerKeys(program: Command): void {
  const keys = program.command("keys").description(tr("API key của workspace", "workspace API keys"));
  keys.hook("preAction", async () => void (await requirePerson()));

  keys.command("list", { isDefault: true }).description(tr("danh sách khoá", "list keys")).action(async () => {
    const list = await get<ApiKey[]>("/iam/api-keys");
    emit(list, () =>
      info(table(["ID", tr("Tên", "Name"), tr("Đầu khoá", "Prefix"), tr("Quyền", "Scopes"), tr("Hết hạn", "Expires"), ""], list.map((k) => [
        k.id.slice(0, 8), k.name, k.keyPrefix, k.scopes.length ? `${k.scopes.slice(0, 3).join(", ")}${k.scopes.length > 3 ? ` +${k.scopes.length - 3}` : ""}` : c.yellow(tr("không giới hạn", "unlimited")),
        k.expiresAt?.slice(0, 10) ?? "", k.revokedAt ? c.red(tr("đã thu hồi", "revoked")) : k.isActive ? c.green("●") : c.dim(tr("tắt", "off")),
      ]))),
    );
  });

  keys.command("create")
    .description(tr("tạo khoá mới (in khoá đúng một lần)", "create a key (printed once)"))
    .requiredOption("--name <name>")
    .requiredOption("--scopes <codes>", tr(`mã quyền, phẩy ngăn cách, vd ${scopeExample()}`, `permission codes, comma separated, e.g. ${scopeExample()}`))
    .option("--expires <dur>", tr("thời hạn: 30d, 6m, 1y", "lifetime: 30d, 6m, 1y"), "90d")
    .option("--description <text>")
    .action(async (o: { name: string; scopes: string; expires: string; description?: string }) => {
      const r = await post<Record<string, unknown>>("/iam/api-keys", {
        name: o.name,
        scopes: o.scopes.split(",").map((s) => s.trim()).filter(Boolean),
        expiresAt: parseDuration(o.expires),
        description: o.description,
        source: "integration",
      });
      const raw = String(r.rawKey ?? r.key ?? r.apiKey ?? "");
      emit(r, () => {
        ok(tr(`Đã tạo khoá "${o.name}"`, `Created key "${o.name}"`));
        info(`\n  ${c.bold(raw)}\n`);
        warn(tr("Chỉ hiện một lần. Lưu ngay vào nơi an toàn (biến secret của CI, trình quản lý mật khẩu).", "Shown only once. Store it now (CI secret, password manager)."));
        info(c.dim(`  ${brand().envPrefix}_API_KEY=${raw.slice(0, 8)}… ${brand().bin} tools list`));
      });
    });

  keys.command("revoke <id>").description(tr("thu hồi khoá (dừng ngay)", "revoke a key (stops immediately)")).action(async (id: string) => {
    const k = await findKey(id);
    if (hasTty() && !(await confirm(tr(`Thu hồi khoá "${k.name}" (${k.keyPrefix})? Mọi hệ thống đang dùng sẽ ngừng chạy.`, `Revoke "${k.name}" (${k.keyPrefix})? Anything using it stops working.`)))) return;
    await post(`/iam/api-keys/${k.id}/revoke`, {});
    ok(tr("Đã thu hồi.", "Revoked."));
  });

  keys.command("delete <id>").description(tr("xoá khoá", "delete a key")).action(async (id: string) => {
    const k = await findKey(id);
    if (hasTty() && !(await confirm(tr(`Xoá khoá "${k.name}"?`, `Delete "${k.name}"?`)))) return;
    await del(`/iam/api-keys/${k.id}`);
    ok(tr("Đã xoá.", "Deleted."));
  });

  keys.command("usage [id]").description(tr("số lượt gọi 7 ngày", "calls over 7 days")).action(async (id?: string) => {
    const u = await get<{ limitPerMinute?: number; keys?: { id: string; name?: string; days?: { date: string; count: number }[] }[] } & Record<string, unknown>>("/iam/api-keys/usage");
    const rows = (u.keys ?? []).filter((k) => !id || k.id.startsWith(id));
    emit(u, () => {
      if (!rows.length) return void info(JSON.stringify(u, null, 2));
      info(table([tr("Khoá", "Key"), ...(rows[0]?.days ?? []).map((d) => d.date.slice(5))], rows.map((k) => [k.name ?? k.id.slice(0, 8), ...(k.days ?? []).map((d) => d.count)])));
      if (u.limitPerMinute) info(c.dim(`  ${tr("Hạn mức", "Limit")}: ${u.limitPerMinute}/${tr("phút", "min")}`));
    });
  });

  keys.command("calls <id>").description(tr("50 lượt gọi gần nhất của một khoá", "last 50 calls of a key")).action(async (id: string) => {
    const k = await findKey(id);
    const calls = await get<{ at?: string; method?: string; path?: string; status?: string | number; durationMs?: number }[]>(`/iam/api-keys/${k.id}/calls`);
    emit(calls, () => info(table([tr("Lúc", "At"), "", tr("Đường", "Path"), tr("Kết quả", "Status"), "ms"], calls.map((x) => [(x.at ?? "").slice(0, 19).replace("T", " "), x.method ?? "", x.path ?? "", String(x.status ?? ""), x.durationMs ?? ""]))));
  });
}
