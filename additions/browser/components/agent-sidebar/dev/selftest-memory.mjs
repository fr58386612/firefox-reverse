#!/usr/bin/env node
/* selftest-memory.mjs — 二开 M7：profile 全局记忆（GlobalMemoryBackend）自测。
 * 用 Node fs 垫片冒充 IOUtils/PathUtils，覆盖 upsert/过滤/预算注入/持久化/删除/校验。
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

let fail = 0;
const ok = (c, m) => { console.log(`${c ? "PASS" : "FAIL"} ${m}`); if (!c) fail++; };

const root = await fs.mkdtemp(path.join(os.tmpdir(), "frx-mem-selftest-"));
globalThis.PathUtils = {
  profileDir: root,
  join: (...parts) => path.join(...parts),
  parent: p => path.dirname(p),
};
globalThis.IOUtils = {
  async readUTF8(p) {
    return await fs.readFile(p, "utf8"); // 缺文件 → Error 含 ENOENT，走 _missing 分支
  },
  async writeUTF8(p, data) {
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, data, "utf8");
  },
  async makeDirectory(p) {
    await fs.mkdir(p, { recursive: true });
  },
};

const { GlobalMemoryBackend } = await import("../modules/GlobalMemory.sys.mjs");
const memPath = path.join(root, "firefox-reverse-agent", "global-memory.json");

try {
  const mem = new GlobalMemoryBackend();

  // 空库
  ok((await mem.list()).count === 0, "初始为空");
  ok((await mem.summarizeForPrompt()) === "", "空库注入块 = 空串");

  // 保存 + 字段
  const r1 = await mem.save({ name: "回复语言偏好", body: "用户要求始终用中文回复。", kind: "user", description: "全局语言" });
  ok(r1.ok && r1.total === 1 && !r1.updated, "memory_save 新建 1 条");
  const one = (await mem.list()).memories[0];
  ok(one.name === "回复语言偏好" && one.kind === "user" && one.body.includes("中文"), "字段回读一致");

  // 同名(大小写不同) = 更新不新增
  const r2 = await mem.save({ name: "回复语言偏好", body: "用户要求中文回复，代码注释用英文。", kind: "user" });
  ok(r2.updated && r2.total === 1 && r2.saved.body.includes("注释"), "同名=更新（total 不变）");

  // 非法 kind 归 note；缺参报错
  const r3 = await mem.save({ name: "端点惯例", body: "公司接口都走 /api/v2。", kind: "bogus" });
  ok(r3.saved.kind === "note", "非法 kind 归一为 note");
  await assert.rejects(() => mem.save({ body: "x" }), /name 必填/, "缺 name 报错");
  await assert.rejects(() => mem.save({ name: "x" }), /body 必填/, "缺 body 报错");

  // 再来一条 + 过滤
  await mem.save({ name: "逆向开工流程", body: "先看 notes/账本再动手，避免重复发现。", kind: "feedback" });
  ok((await mem.list({ kind: "user" })).count === 1, "kind 过滤");
  ok((await mem.list({ query: "/api/v2" })).count === 1, "query 子串命中正文");
  ok((await mem.list({ query: "不存在xyz" })).count === 0, "query 无命中");

  // 注入块：包含全部条目 + 表头表尾
  const block = await mem.summarizeForPrompt();
  ok(block.includes("【全局记忆】") && block.includes("回复语言偏好") && block.includes("逆向开工流程") && block.includes("[feedback]"),
    "注入块含全部条目与类别标记");

  // 预算：超长正文截断、超额条目走 skipped 提示
  await mem.save({ name: "长条目", body: "长".repeat(400), kind: "note" });
  const tight = await mem.summarizeForPrompt({ maxChars: 120, maxBody: 60 });
  ok(tight.includes("…"), "超预算正文截断");
  ok(/未展示/.test(tight), "超预算旧条目折叠为 skipped 提示");
  ok(tight.length < 120 + 300, "注入块行部分受 maxChars 约束（表头表尾另计）");

  // 删除
  const del = await mem.remove({ name: "长条目" });
  ok(del.removed === 1 && (await mem.list()).count === 3, "memory_delete 生效");
  ok((await mem.remove({ name: "不存在" })).removed === 0, "删不存在的返回 removed=0");

  // 持久化：新实例读同一文件
  const mem2 = new GlobalMemoryBackend();
  ok((await mem2.list()).count === 3 && (await mem2.list({ query: "/api/v2" })).count === 1, "新实例从磁盘恢复");

  // 显式 filePath 覆盖（自测/多库场景）
  const alt = new GlobalMemoryBackend({ filePath: path.join(root, "alt.json") });
  await alt.save({ name: "隔离库", body: "独立文件互不干扰", kind: "note" });
  ok((await alt.list()).count === 1 && (await mem2.list()).count === 3, "filePath 覆盖=独立库");

  console.log(fail ? `\nmemory selftest: ${fail} FAILED` : "\nmemory selftest: ALL PASS");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
process.exit(fail ? 1 : 0);
