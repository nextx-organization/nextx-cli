import type { Command } from "commander";
import { brand } from "../core/brand.js";
import { CliError, Exit } from "../core/errors.js";
import { tr } from "../core/i18n.js";
import { c, emit, info, ok, table } from "../core/output.js";
import { get, post } from "../core/http.js";
import { confirm, hasTty } from "../core/prompt.js";
import { requirePerson } from "../auth/session.js";
import { parseDuration } from "./keys.js";
import { registerCiPolicy } from "./ci-policy.js";

interface CiTrust {
  id: string;
  name: string;
  provider: string;
  repository: string;
  refPattern: string;
  environment?: string | null;
  expiresAt?: string | null;
  revokedAt?: string | null;
  lastUsedAt?: string | null;
  createdAt: string;
  firstWriteAt?: string | null;
}

async function findTrust(id: string): Promise<CiTrust> {
  const t = (await get<CiTrust[]>("/iam/ci-trusts")).find((x) => x.id.startsWith(id) || x.repository === id);
  if (!t) throw new CliError(tr("Không thấy khai báo này.", "Not found."), Exit.notFound);
  return t;
}

const when = (s?: string | null) => (s ? s.slice(0, 16).replace("T", " ") : "—");

export function workflowSample(repo = "acme/web", ws = "my-workspace"): string {
  const b = brand();
  return `# .github/workflows/report.yml  (${repo})
permissions:
  id-token: write   # cho phép lấy token OIDC — không cần secret nào
  contents: read
jobs:
  report:
    runs-on: ubuntu-latest
    steps:
      - run: npx -y ${b.pkg} login --ci --workspace ${ws}
      - run: npx -y ${b.pkg} -p "${tr(b.example.vi, b.example.en)}" --json > report.json`;
}

/** Sample CI job that writes: works once an admin approves a pre-approval policy (`ci policy request`). */
export function workflowWriteSample(repo = "acme/web", ws = "my-workspace"): string {
  const b = brand();
  return `# .github/workflows/follow-up.yml  (${repo})
# ${tr("Ghi chỉ trong chính sách duyệt trước (ci policy request); ngoài phạm vi thì để lại đề xuất chờ người duyệt (mã thoát 7).", "Writes only within an approved policy (ci policy request); anything else stays a proposal for a person (exit code 7).")}
permissions:
  id-token: write
  contents: read
jobs:
  follow-up:
    runs-on: ubuntu-latest
    steps:
      - run: npx -y ${b.pkg} login --ci --workspace ${ws}
      - run: npx -y ${b.pkg} -p "${tr("tạo việc gọi lại cho khách quá hạn chăm sóc 7 ngày", "create call-back tasks for customers not contacted in 7 days")}" --mode auto`;
}

export function registerCi(program: Command): void {
  const ci = program.command("ci").description(tr("đăng nhập từ CI không cần bí mật (OIDC)", "secretless CI login (OIDC)"));
  const trust = ci.command("trust").description(tr("kho CI được phép đăng nhập workspace này", "CI repositories allowed to log in to this workspace"));
  trust.hook("preAction", async () => {
    if (brand().notYet?.includes("ci")) {
      const { notYetError } = await import("../core/errors.js");
      throw notYetError(tr(`${brand().name} chưa mở đăng nhập CI bằng OIDC`, `${brand().name} does not offer CI OIDC login yet`), tr(`dùng khoá API: ${brand().envPrefix}_API_KEY`, `use an API key: ${brand().envPrefix}_API_KEY`));
    }
    await requirePerson();
  });

  trust.command("list", { isDefault: true }).action(async () => {
    const list = await get<CiTrust[]>("/iam/ci-trusts");
    emit(list, () => info(list.length
      ? table(["ID", tr("Kho", "Repository"), "Ref", "Env", tr("Dùng lần cuối", "Last used"), ""], list.map((t) => [
          t.id.slice(0, 8), `${t.provider}:${t.repository}`, t.refPattern, t.environment ?? "", when(t.lastUsedAt), t.revokedAt ? c.red(tr("đã thu hồi", "revoked")) : c.green("●"),
        ]))
      : tr(`Chưa có kho nào. Thêm: ${brand().bin} ci trust add --repo owner/repo`, `None yet. Add one: ${brand().bin} ci trust add --repo owner/repo`)));
  });

  trust.command("add")
    .description(tr("cho một kho đăng nhập (token đứng tên bạn, sống 15 phút)", "allow a repository to log in (tokens act as you, live 15 minutes)"))
    .requiredOption("--repo <owner/repo>")
    .option("--provider <p>", "github | gitlab", "github")
    .option("--ref <ref>", tr("nhánh hoặc tiền tố tag, vd main · refs/tags/v*", "branch or tag prefix, e.g. main · refs/tags/v*"), "main")
    .option("--environment <name>", tr("environment GitHub bắt buộc (khuyên dùng cho nhánh chính)", "required GitHub environment (recommended for the main branch)"))
    .option("--expires <dur>", tr("thời hạn: 90d, 1y", "lifetime: 90d, 1y"))
    .option("--name <name>")
    .action(async (o: { repo: string; provider: string; ref: string; environment?: string; expires?: string; name?: string }) => {
      const t = await post<CiTrust>("/iam/ci-trusts", {
        provider: o.provider, repository: o.repo, refPattern: o.ref, environment: o.environment, name: o.name,
        expiresAt: o.expires ? parseDuration(o.expires) : null,
      });
      emit(t, () => {
        ok(tr(`Đã cho ${t.provider}:${t.repository} (${t.refPattern}) đăng nhập`, `Allowed ${t.provider}:${t.repository} (${t.refPattern})`));
        info(c.dim(tr(`\nCho CI tự ghi trong trần: ${brand().bin} ci policy request --trust ${t.repository} --kinds <mã>`, `\nLet CI write within a ceiling: ${brand().bin} ci policy request --trust ${t.repository} --kinds <code>`)));
        info(c.dim(tr("\nMẫu workflow:", "\nSample workflow:")));
        info(workflowSample(t.repository));
      });
    });


  trust.command("revoke <id>").description(tr("thu hồi (có hiệu lực ngay)", "revoke (immediate)")).action(async (id: string) => {
    const t = await findTrust(id);
    if (hasTty() && !(await confirm(tr(`Thu hồi ${t.repository}?`, `Revoke ${t.repository}?`)))) return;
    await post(`/iam/ci-trusts/${t.id}/revoke`, {});
    ok(tr("Đã thu hồi.", "Revoked."));
  });

  // Pre-approval policies: the same /ai/ci-write-policies contract on every platform.
  registerCiPolicy(ci);

  ci.command("example").description(tr("in mẫu workflow GitHub Actions", "print a sample GitHub Actions workflow"))
    .option("--repo <owner/repo>").option("--workspace <code>")
    .option("--write", tr("mẫu có tự ghi (cần chính sách: ci policy request)", "sample that writes (needs a policy: ci policy request)"))
    .action((o: { repo?: string; workspace?: string; write?: boolean }) => info(o.write ? workflowWriteSample(o.repo, o.workspace) : workflowSample(o.repo, o.workspace)));
}
