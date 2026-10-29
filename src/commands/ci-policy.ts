// `ci policy` — pre-approval policies that let a CI session write without a person confirming.
//   GET  /ai/ci-write-policies (+ /kinds) · POST /ai/ci-write-policies · POST /{id}/revoke
// The server is the gate: a CI session applies a proposal only when every line is a kind of one active policy of that CI trust, the
// ceiling has room and it has not expired (≤ 30 days). Devices and money never qualify. Approval happens on the web or from a
// person's session — a CI session cannot request or approve a policy for itself.
import type { Command } from "commander";
import { brand } from "../core/brand.js";
import { CliError, Exit } from "../core/errors.js";
import { tr } from "../core/i18n.js";
import { c, emit, info, ok, table } from "../core/output.js";
import { get, post } from "../core/http.js";
import { confirm, hasTty } from "../core/prompt.js";
import { context } from "../core/context.js";
import { requirePerson } from "../auth/session.js";
import { parseDuration } from "./keys.js";

interface Policy {
  id: string;
  ciTrustId: string;
  repository?: string | null;
  kinds: string[];
  maxRecords: number;
  usedRecords: number;
  expiresAt: string;
  state: "pending" | "active" | "revoked" | "expired" | "exhausted";
  note?: string | null;
  lastUsedAt?: string | null;
}

interface Trust { id: string; repository: string; provider: string; refPattern: string; revokedAt?: string | null }

const BASE = "/ai/ci-write-policies";
// Examples and the approval screen differ per platform: some write by entry kind, others by permission code.
const exampleKinds = () => brand().examples.ciKinds;
function approvePlace(): string {
  return tr("Thiết lập › Ứng dụng & API › CI", "Settings › Apps & API › CI");
}
const day = (s?: string | null) => (s ? s.slice(0, 10) : "—");
const shortId = (id: string) => id.slice(-8);

function stateLabel(s: Policy["state"]): string {
  switch (s) {
    case "active": return c.green(tr("đang hiệu lực", "active"));
    case "pending": return c.yellow(tr("chờ duyệt", "pending"));
    case "exhausted": return c.dim(tr("hết trần", "ceiling reached"));
    case "expired": return c.dim(tr("hết hạn", "expired"));
    default: return c.red(tr("đã thu hồi", "revoked"));
  }
}

async function findPolicy(id: string): Promise<Policy> {
  // UUID v7 ids share their first characters (time prefix), so the table shows the LAST 8 and lookup matches either end.
  const all = (await get<{ items: Policy[] }>(BASE)).items;
  const hits = all.filter((x) => x.id === id || x.id.startsWith(id) || x.id.endsWith(id));
  if (hits.length > 1) throw new CliError(tr("Mã ngắn trùng nhiều chính sách — gõ thêm ký tự.", "Short id matches several policies — type more characters."), Exit.usage);
  const p = hits[0];
  if (!p) throw new CliError(tr("Không thấy chính sách này.", "Policy not found."), Exit.notFound);
  return p;
}

export function registerCiPolicy(ci: Command): void {
  const policy = ci.command("policy")
    .description(tr("chính sách duyệt trước: cho CI tự ghi trong trần", "pre-approval policies: let CI write within a ceiling"));
  policy.hook("preAction", async () => { await requirePerson(); });

  policy.command("list", { isDefault: true }).action(async () => {
    const { items } = await get<{ items: Policy[] }>(BASE);
    emit(items, () => info(items.length
      ? table(["ID", tr("Kho", "Repository"), tr("Được ghi", "Kinds"), tr("Đã dùng", "Used"), tr("Hết hạn", "Expires"), ""], items.map((p) => [
          shortId(p.id), p.repository ?? shortId(p.ciTrustId), p.kinds.join(", "), `${p.usedRecords}/${p.maxRecords}`, day(p.expiresAt), stateLabel(p.state),
        ]))
      : tr(`Chưa có chính sách — CI chỉ in link để xác nhận. Xin: ${brand().bin} ci policy request --trust <kho> --kinds ${exampleKinds()}`,
          `No policy — CI only prints a link to confirm. Request one: ${brand().bin} ci policy request --trust <repo> --kinds ${exampleKinds()}`)));
  });

  policy.command("kinds").description(tr("loại ghi đưa được vào chính sách", "kinds a policy can cover")).action(async () => {
    const { items } = await get<{ items: string[] }>(`${BASE}/kinds`);
    emit(items, () => info(items.join("\n")));
  });

  policy.command("show <id>").action(async (id: string) => {
    const p = await findPolicy(id);
    emit(p, () => {
      info(`${c.bold(p.repository ?? p.ciTrustId)}  ${stateLabel(p.state)}`);
      info(tr(`Được ghi: ${p.kinds.join(", ")}`, `Kinds: ${p.kinds.join(", ")}`));
      info(tr(`Đã dùng: ${p.usedRecords}/${p.maxRecords} · hết hạn ${day(p.expiresAt)} · ghi lần cuối ${day(p.lastUsedAt)}`,
        `Used: ${p.usedRecords}/${p.maxRecords} · expires ${day(p.expiresAt)} · last write ${day(p.lastUsedAt)}`));
      if (p.note) info(c.dim(p.note));
    });
  });

  policy.command("request")
    .description(tr("xin cho một kho CI tự ghi (người quản lý khoá API duyệt; có quyền thì có hiệu lực ngay)",
      "ask to let a CI repository write (an API-key manager approves; with that permission it is active at once)"))
    .requiredOption("--trust <id|owner/repo>", tr("khai báo CI (xem: ci trust list)", "CI trust (see: ci trust list)"))
    .requiredOption("--kinds <a,b>", tr("loại ghi (xem: ci policy kinds)", "kinds (see: ci policy kinds)"))
    .option("--max <n>", tr("trần số bản ghi (1–1000)", "record ceiling (1–1000)"), "50")
    .option("--expires <dur>", tr("thời hạn tối đa 30d", "lifetime, at most 30d"), "14d")
    .option("--note <text>")
    .option("--approve", tr("duyệt luôn (cần quyền quản lý khoá API)", "approve now (needs API-key manage permission)"))
    .action(async (o: { trust: string; kinds: string; max: string; expires: string; note?: string; approve?: boolean }) => {
      const want = o.trust.trim().toLowerCase();
      const trust = (await get<Trust[]>("/iam/ci-trusts")).find((t) => !t.revokedAt && (t.id.startsWith(want) || t.repository === want));
      if (!trust) throw new CliError(tr(`Không thấy kho CI "${o.trust}".`, `No CI trust "${o.trust}".`), Exit.notFound, `${brand().bin} ci trust list`);
      const max = Number(o.max);
      if (!Number.isInteger(max) || max < 1 || max > 1000) throw new CliError(tr("--max từ 1 đến 1000.", "--max must be 1–1000."), Exit.usage);
      const p = await post<Policy>(BASE, {
        ciTrustId: trust.id, repository: trust.repository, kinds: o.kinds.split(",").map((k) => k.trim()).filter(Boolean),
        maxRecords: max, expiresAt: parseDuration(o.expires), note: o.note ?? null, approve: !!o.approve,
      });
      emit(p, () => {
        ok(p.state === "active"
          ? tr(`CI của ${trust.repository} được tự ghi ${p.kinds.join(", ")} — tối đa ${p.maxRecords} bản ghi tới ${day(p.expiresAt)}.`,
            `CI of ${trust.repository} may write ${p.kinds.join(", ")} — up to ${p.maxRecords} records until ${day(p.expiresAt)}.`)
          : tr(`Đã gửi duyệt (${shortId(p.id)}). Người quản lý duyệt tại ${context().endpoints.app} › ${approvePlace()}.`,
            `Sent for approval (${shortId(p.id)}). A manager approves in ${context().endpoints.app} › ${approvePlace()}.`));
      });
    });

  policy.command("revoke <id>").description(tr("thu hồi (lượt ghi kế tiếp quay về chỉ in link)", "revoke (the next write goes back to a link)"))
    .action(async (id: string) => {
      const p = await findPolicy(id);
      if (hasTty() && !(await confirm(tr(`Thu hồi chính sách của ${p.repository ?? shortId(p.id)}?`, `Revoke the policy for ${p.repository ?? shortId(p.id)}?`)))) return;
      await post(`${BASE}/${p.id}/revoke`, {});
      ok(tr("Đã thu hồi.", "Revoked."));
    });
}
