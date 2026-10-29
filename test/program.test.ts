import { test } from "node:test";
import assert from "node:assert/strict";
import { brand, setBrand } from "../src/core/brand.js";

/** In a tree without the default brand these cases do not apply. */
const onDefaultPlatform = () => { setBrand("nextx"); return brand().platform === "nextx"; };
const skip = { skip: !onDefaultPlatform() };

test("cây lệnh nextx: đủ nhóm lệnh, lệnh gạch chéo và mã thoát", skip, async () => {
  setBrand("nextx");
  const { buildProgram } = await import("../src/program.js");
  const { helpTree } = await import("../src/commands/help.js");
  const tree = helpTree(buildProgram());
  const names = tree.root.commands.map((c) => c.name);
  for (const n of ["login", "logout", "status", "workspace", "ai", "tools", "api", "keys", "webhooks", "mcp", "doctor", "completion", "update", "init"])
    assert.ok(names.includes(n), `thiếu lệnh ${n}`);
  assert.ok(tree.slashCommands.length >= 30);
  assert.deepEqual(tree.exitCodes.find((e) => e.name === "notConfirmed"), { name: "notConfirmed", code: 7 });
});

test("gợi ý Tab: lệnh con và cờ", async () => {
  setBrand("nextx");
  const { buildProgram } = await import("../src/program.js");
  const { completions } = await import("../src/commands/util.js");
  const p = buildProgram();
  assert.deepEqual(completions(p, ["webh"]), ["webhooks"]);
  assert.ok(completions(p, ["webhooks", ""]).includes("listen"));
  assert.ok(completions(p, ["login", "--q"]).includes("--qr"));
});


test("bản nextx không nhắc tới gym trong trợ giúp, không lấy công cụ / scope của gym", skip, async () => {
  setBrand("nextx");
  const { buildProgram } = await import("../src/program.js");
  const { helpTree } = await import("../src/commands/help.js");
  const { visibleModule } = await import("../src/core/brand.js");
  const text = JSON.stringify(helpTree(buildProgram()));
  assert.equal(/\bgym/i.test(text), false, text.match(/.{40}gym.{40}/i)?.[0]);
  assert.equal(visibleModule("gym:read"), false);
  assert.equal(visibleModule("crm.contacts.view"), true);
});

test("cờ chung đặt sau lệnh con vẫn nhận (nextx login --sandbox)", async () => {
  setBrand("nextx");
  const { buildProgram } = await import("../src/program.js");
  const { context } = await import("../src/core/context.js");
  const p = buildProgram();
  p.exitOverride();
  const sub = p.commands.find((c) => c.name() === "config")!.commands.find((c) => c.name() === "get")!;
  sub.action(() => undefined);
  await p.parseAsync(["node", "nextx", "config", "get", "lang", "--sandbox", "--profile", "t1"]);
  assert.equal(context().env, "sandbox");
  assert.equal(context().profile, "t1");
});
