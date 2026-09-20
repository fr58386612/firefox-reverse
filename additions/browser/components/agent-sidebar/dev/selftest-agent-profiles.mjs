#!/usr/bin/env node
/* selftest-agent-profiles.mjs — 二开 M8：Agent 能力档案自测。
 * 共享一个内存 backend 冒充 prefs，覆盖：内置档案只读合成、增删改查、激活切换、
 * 上限/校验/重名、删除激活项回退内置、跨"重启"持久化、BUILTIN 文本单一来源。
 */
import assert from "node:assert/strict";

let fail = 0;
const ok = (c, m) => { console.log(`${c ? "PASS" : "FAIL"} ${m}`); if (!c) fail++; };

function makeBackend() {
  const mem = new Map();
  return {
    persistent: false,
    getString: (k, def = "") => (mem.has(k) ? mem.get(k) : def),
    setString: (k, v) => void mem.set(k, v),
    clear: (k) => void mem.delete(k),
    _mem: mem,
  };
}

const { ConfigStore, BUILTIN_REVERSE_PROFILE_TEXT } = await import("../modules/ConfigStore.sys.mjs");

const backend = makeBackend();
const store = new ConfigStore(backend);

try {
  // ── 内置档案 ──
  const list0 = store.listAgentProfiles();
  ok(list0.length === 1 && list0[0].builtin === true && list0[0].id === "ap_reverse", "初始只有内置档案 ap_reverse");
  ok(list0[0].system === BUILTIN_REVERSE_PROFILE_TEXT, "内置 system === BUILTIN_REVERSE_PROFILE_TEXT（单一来源）");
  ok(BUILTIN_REVERSE_PROFILE_TEXT.startsWith("你是 firefox-reverse") && BUILTIN_REVERSE_PROFILE_TEXT.includes("【红线】"), "内置文本=原逆向人设（含红线）");
  const act0 = store.getActiveAgentProfile();
  ok(act0.id === "ap_reverse", "默认激活 = 内置档案");

  // ── 校验 ──
  let err = null;
  try { store.createAgentProfile({ name: "", system: "x".repeat(20) }); } catch (e) { err = e; }
  ok(err && /名称/.test(err.message), "无名 → 报错");
  err = null;
  try { store.createAgentProfile({ name: "太短", system: "只有几个字" }); } catch (e) { err = e; }
  ok(err && /太短/.test(err.message), "system <10 字 → 报错");

  // ── 新建 + 自动激活（UI 调 setActiveAgentProfileId）+ 持久化 ──
  const p1 = store.createAgentProfile({ name: "技术翻译", description: "英中技术文档", system: "你是一名资深英中技术文档翻译，逐句对照，保留代码与术语原文。" });
  ok(p1.id !== "ap_reverse" && p1.builtin === false && p1.name === "技术翻译", "createAgentProfile 返回自定义档案");
  ok(store.listAgentProfiles().length === 2, "列表 = 内置 + 1 自定义");
  store.setActiveAgentProfileId(p1.id);
  ok(store.getActiveAgentProfile().id === p1.id, "切换激活到自定义档案");

  // 跨"重启"（同一 backend 新实例）仍在
  const store2 = new ConfigStore(backend);
  ok(store2.listAgentProfiles().length === 2 && store2.getActiveAgentProfile().id === p1.id, "重启后列表/激活仍在");
  ok(!backend._mem.get("extensions.firefox-reverse.agent.agentProfiles.v1").includes("\"builtin\":true"), "prefs 里不存内置档案（升级安全）");

  // ── 编辑 ──
  const u1 = store.updateAgentProfile(p1.id, { description: "改过的说明" });
  ok(u1.description === "改过的说明" && u1.system === p1.system, "update 空 system 保留原文");
  err = null;
  try { store.updateAgentProfile("ap_reverse", { name: "hack" }); } catch (e) { err = e; }
  ok(err && /内置档案不可修改/.test(err.message), "内置不可修改");

  // ── 重名去重 ──
  const p2 = store.createAgentProfile({ name: "技术翻译", system: "另一个足够长的能力定义文本内容。" });
  ok(p2.name !== "技术翻译" && /^技术翻译/.test(p2.name), "重名自动加后缀：" + p2.name);

  // ── 复制 ──
  const dup = store.duplicateAgentProfile("ap_reverse");
  ok(dup.builtin === false && dup.name.includes("副本") && dup.system === BUILTIN_REVERSE_PROFILE_TEXT, "duplicate 内置 → 自定义副本（含全文）");

  // ── 删除激活项 → 回退内置 ──
  store.setActiveAgentProfileId(p1.id);
  ok(store.deleteAgentProfile(p1.id) === true, "删除自定义成功");
  ok(store.getActiveAgentProfile().id === "ap_reverse", "删除激活项后回退内置");
  err = null;
  try { store.deleteAgentProfile("ap_reverse"); } catch (e) { err = e; }
  ok(err && /不可删除/.test(err.message), "内置不可删除");
  ok(store.deleteAgentProfile("no-such") === false, "删不存在 → false");

  // ── 上限 20 ──
  let err2 = null;
  for (let i = 0; i < 40; i++) {
    try {
      store.createAgentProfile({ name: "档案" + i, system: "足够长的能力定义正文内容" + i });
    } catch (e) {
      err2 = e;
      break;
    }
  }
  ok(store.listAgentProfiles().length - 1 === 20 && err2 && /最多/.test(err2.message), "上限 20：第 21 条被拒");

  // ── 坏数据自愈 ──
  backend.setString("extensions.firefox-reverse.agent.agentProfiles.v1", "{坏 JSON");
  ok(store.listAgentProfiles().length === 1, "坏 JSON 自愈为只剩内置");
  backend.setString("extensions.firefox-reverse.agent.agentProfiles.v1", JSON.stringify([{ id: "x", name: "ok", system: "这是一条足够长的自定义能力定义" }, { builtin: true, id: "y", name: "夹带内置", system: "aaaaaaaaaaaaaaaaaaaa" }]));
  const lst = store.listAgentProfiles();
  ok(lst.length === 2 && lst[1].name === "ok" && !lst.some(p => p.name === "夹带内置"), "夹带 builtin 标记的脏条目被过滤");
} catch (e) {
  ok(false, "未捕获异常: " + (e && e.stack || e));
}

console.log(fail ? `FAIL ${fail}` : "ALL PASS");
process.exit(fail ? 1 : 0);
