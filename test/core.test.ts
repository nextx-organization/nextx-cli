import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { brand, setBrand } from "../src/core/brand.js";

/** In a NextFarm-only tree the default brand is gone and these cases do not apply. */
const onDefaultPlatform = () => { setBrand("nextx"); return brand().platform === "nextx"; };
const skip = { skip: !onDefaultPlatform() };
setBrand("nextx");
const { verifySignature } = await import("../src/commands/webhooks.js");
const { parseArgs } = await import("../src/commands/tools.js");
const { select } = await import("../src/commands/api.js");
const { riskOf, confirmWord, composeText, attachmentKind } = await import("../src/ai/client.js");
const { markdown } = await import("../src/repl/markdown.js");
const { isOlder, apiPath } = await import("../src/core/http.js");
const { decodeJwt, sessionFrom, findWorkspace } = await import("../src/auth/session.js");
const { compact } = await import("../src/core/output.js");
const { parseDuration } = await import("../src/commands/keys.js");
const { setLang } = await import("../src/core/i18n.js");
setLang("vi");

const strip = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, "");

test("chữ ký X-NextX-Signature-256 đúng thì hợp lệ, sửa một byte thì không", skip, () => {
  const secret = "whsec_dGVzdA==";
  const ts = String(Math.floor(Date.now() / 1000));
  const body = '{"type":"contact.created"}';
  const sig = "sha256=" + createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
  assert.equal(verifySignature(secret, body, { "X-NextX-Timestamp": ts, "X-NextX-Signature-256": sig }).ok, true);
  assert.equal(verifySignature(secret, body + " ", { "X-NextX-Timestamp": ts, "X-NextX-Signature-256": sig }).ok, false);
});

test("chữ ký Standard Webhooks (webhook-signature v1,base64) hợp lệ", () => {
  const key = Buffer.from("khoa-bi-mat-32-byte-cho-test-abc");
  const secret = "whsec_" + key.toString("base64");
  const ts = String(Math.floor(Date.now() / 1000));
  const body = "{}";
  const sig = "v1," + createHmac("sha256", key).update(`evt_1.${ts}.${body}`).digest("base64");
  assert.equal(verifySignature(secret, body, { "webhook-id": "evt_1", "webhook-timestamp": ts, "webhook-signature": sig }).ok, true);
});

test("dấu thời gian quá 5 phút bị từ chối (chống phát lại)", () => {
  const secret = "s";
  const ts = String(Math.floor(Date.now() / 1000) - 600);
  const sig = "sha256=" + createHmac("sha256", secret).update(`${ts}.{}`).digest("hex");
  assert.equal(verifySignature(secret, "{}", { "x-nextx-timestamp": ts, "x-nextx-signature-256": sig }).ok, false);
});

test("-a khoá=giá_trị đoán đúng kiểu, --args gộp, JSON hỏng báo lỗi dùng sai", () => {
  assert.deepEqual(parseArgs({ arg: ["q=Minh Phát", "limit=20", "active=true", "ids=[1,2]"] }), { q: "Minh Phát", limit: 20, active: true, ids: [1, 2] });
  assert.deepEqual(parseArgs({ args: '{"a":1}', arg: ["b=x"] }), { a: 1, b: "x" });
  assert.throws(() => parseArgs({ args: "{sai" }), (e: { exitCode: number }) => e.exitCode === 2);
  assert.throws(() => parseArgs({ arg: ["khongdau"] }), (e: { exitCode: number }) => e.exitCode === 2);
});

test("--select đi theo đường .a[0].b và ánh xạ qua mảng", () => {
  const v = { items: [{ name: "A", tags: ["x"] }, { name: "B" }] };
  assert.equal(select(v, ".items[1].name"), "B");
  assert.deepEqual(select(v, ".items.name"), ["A", "B"]);
  assert.equal(select(v, ".khong.co"), undefined);
});

test("mức rủi ro: tài chính, ghi lớn, ghi thường", () => {
  const base = { label: "", confirmPrompt: "", writes: true, nonce: "n" };
  assert.equal(riskOf({ ...base, kind: "einvoice.issue", payloadJson: "{}" }), "finance");
  assert.equal(riskOf({ ...base, kind: "crm.contacts.merge", payloadJson: "{}" }), "large");
  assert.equal(riskOf({ ...base, kind: "marketing.send", payloadJson: "{}", recipientCount: 500 }), "large");
  assert.equal(riskOf({ ...base, kind: "crm.quote.create", payloadJson: JSON.stringify({ lines: Array(25).fill(1) }) }), "large");
  assert.equal(riskOf({ ...base, kind: "crm.quote.create", payloadJson: JSON.stringify({ lines: [1, 2] }) }), "normal");
  assert.equal(confirmWord({ ...base, kind: "x", payloadJson: "{}", recipientCount: 47 }), "47");
});

test("đính kèm: nhận đúng loại, từ chối PDF", skip, async () => {
  assert.equal(attachmentKind("a.xlsx"), "table");
  assert.equal(attachmentKind("A.CSV"), "table");
  assert.equal(attachmentKind("chup.png"), "image");
  assert.equal(attachmentKind("ghi-chu.md"), "text");
  assert.equal(attachmentKind("hop-dong.pdf"), undefined);
  const t = composeText("tóm tắt", [{ path: "-", name: "stdin", kind: "text", text: "dòng 1" }], "khách VIP > 100tr");
  const { brand } = await import("../src/core/brand.js");
  assert.ok(t.includes(`${brand().bin.toUpperCase()}.md`));
  assert.match(t, /tóm tắt[\s\S]*dòng 1[\s\S]*khách VIP/);
});

test("markdown: bảng thành khung, cột số căn phải, đậm/code giữ chữ", () => {
  const out = strip(markdown("**Tổng** là `412tr`\n\n| Chi nhánh | Doanh thu |\n|---|---|\n| HN | 1.200 |\n| HCM | 98 |"));
  assert.match(out, /Tổng là 412tr/);
  assert.match(out, /│ HN\s+│\s+1\.200 │/);
  assert.match(out, /│ HCM\s+│\s+98 │/);
});

test("so phiên bản và đường API", () => {
  assert.equal(isOlder("0.1.0", "0.2.0"), true);
  assert.equal(isOlder("1.10.0", "1.9.9"), false);
  assert.equal(isOlder("1.0.0", "1.0.0"), false);
  assert.equal(apiPath("/crm/contacts"), "/api/v1/crm/contacts");
  assert.equal(apiPath("api/v2/x"), "/api/v1/api/v2/x".replace("/api/v1/api", "/api"));
  assert.equal(apiPath("/api/v1/iam/auth/me"), "/api/v1/iam/auth/me");
});

test("JWT: đọc sub/wid, phiên lấy hạn theo expires_in, thiếu refresh thì báo hết phiên", () => {
  const payload = Buffer.from(JSON.stringify({ sub: "u1", wid: "w1", exp: 2000000000 })).toString("base64url");
  const jwt = `h.${payload}.s`;
  assert.equal(decodeJwt(jwt).wid, "w1");
  const s = sessionFrom({ accessToken: jwt, refreshToken: "r", expiresIn: 900 }, "qr");
  assert.equal(s.userId, "u1");
  assert.ok(s.expiresAt > Date.now() + 890_000 && s.expiresAt <= Date.now() + 900_000);
  assert.throws(() => sessionFrom({ accessToken: jwt }, "qr"), (e: { exitCode: number }) => e.exitCode === 3);
});

test("tìm workspace theo mã, id hoặc tên", () => {
  const list = [{ id: "1", name: "Giấy Việt", code: "giayviet" }, { id: "2", name: "Chi nhánh HN", code: "gv-hn" }];
  assert.equal(findWorkspace(list, "GV-HN")?.id, "2");
  assert.equal(findWorkspace(list, "giấy việt")?.id, "1");
  assert.equal(findWorkspace(list, "2")?.id, "2");
  assert.equal(findWorkspace(list, "khong"), undefined);
});

test("compact bỏ null, giữ số 0 và chuỗi rỗng", () => {
  assert.deepEqual(compact({ a: null, b: 0, c: "", d: [{ e: null, f: 1 }] }), { b: 0, c: "", d: [{ f: 1 }] });
});

test("thời hạn khoá: 90d, 6m, sai cú pháp", () => {
  const d = Date.parse(parseDuration("90d"));
  assert.ok(Math.abs(d - (Date.now() + 90 * 86400e3)) < 5000);
  assert.throws(() => parseDuration("mai"), (e: { exitCode: number }) => e.exitCode === 2);
});

test("--model: tên nhà, nhà/model, tên lệnh = Trợ lý; thiếu khoá/tên model báo cách sửa", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "nx-model-"));
  process.env.NEXTX_NO_KEYCHAIN = "1";
  const { resolveModel } = await import("../src/ai/models.js");
  const { brand } = await import("../src/core/brand.js");
  assert.equal(resolveModel(brand().bin), undefined);
  process.env.ANTHROPIC_API_KEY = "k";
  assert.equal(resolveModel("claude")?.model, "claude-opus-5-5");
  assert.equal(resolveModel("claude/claude-sonnet-5-5")?.label, "claude/claude-sonnet-5-5");
  const o = resolveModel("ollama/qwen3:32b");
  assert.equal(o?.baseUrl, "http://localhost:11434/v1");
  assert.equal(o?.apiKey, undefined);
  assert.throws(() => resolveModel("gpt"), /Cần tên model/);
  delete process.env.OPENAI_API_KEY;
  assert.throws(() => resolveModel("gpt/x"), /Chưa có khoá/);
  assert.throws(() => resolveModel("abc"), /Không biết nhà model/);
  delete process.env.ANTHROPIC_API_KEY;
});
