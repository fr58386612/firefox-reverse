#!/usr/bin/env node
/* selftest-skills-admin.mjs — 二开 M5：技能沉淀/管理/禁用的后端自测（真实 SkillRegistry + 内存 FS 桩）。 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SkillRegistry } from "../modules/SkillBackend.sys.mjs";

let pass = 0, fail = 0;
const ok = (c, m) => (c ? (pass++, console.log("  OK", m)) : (fail++, console.error("  FAIL", m)));

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "frx-skills-admin-"));
const home = path.join(tmp, "home");
await fs.mkdir(home, { recursive: true });
globalThis.PathUtils = { homeDir: home, join: (...p) => path.join(...p), filename: p => path.basename(p) };
globalThis.Services = { env: { get: () => home ? home : "" } };
globalThis.IOUtils = {
  async getChildren(p) { return (await fs.readdir(p)).map(n => path.join(p, n)); },
  async stat(p) { const s = await fs.stat(p); return { type: s.isDirectory() ? "directory" : "regular", size: s.size }; },
  readUTF8: p => fs.readFile(p, "utf8"),
  writeUTF8: (p, t) => fs.writeFile(p, t, "utf8"),
  async makeDirectory(p) { await fs.mkdir(p, { recursive: true }); },
  async remove(p) { await fs.rm(p, { recursive: true, force: true }); },
  realPath: p => fs.realpath(p),
};

let disabled = new Set();
const reg = new SkillRegistry({ isDisabled: () => disabled });
const ctx = {};

// ① save_skill 沉淀
const s1 = await reg.saveSkill({ name: "sign-flow", description: "抖音 a-bogus 签名还原 流程", content: "# 步骤\n1. hook 入口\n2. 对照" }, ctx);
ok(s1.ok && (await fs.readFile(s1.path, "utf8")).includes("name: sign-flow"), "saveSkill 自动补 frontmatter 并落盘");
const dupe = await reg.saveSkill({ name: "sign-flow", description: "x", content: "y" }, ctx);
ok(dupe.ok === false && /已存在/.test(dupe.error), "同名默认拒绝");
const over = await reg.saveSkill({ name: "sign-flow", description: "x", content: "# 新正文", overwrite: true }, ctx);
ok(over.ok && (await fs.readFile(over.path, "utf8")).includes("# 新正文"), "overwrite:true 覆盖");
const front = await reg.saveSkill({ name: "own-front", content: "---\nname: own-front\ndescription: 自带头\n---\n正文" }, ctx);
const frontText = await fs.readFile(front.path, "utf8");
ok(front.ok && frontText.split("---").length === 3 && frontText.includes("自带头"), "正文自带 frontmatter 不重复包");
const badName = await reg.saveSkill({ name: "Bad Name!!", content: "x" }, ctx);
ok(badName.ok === false, "非法名称拒绝");

// ② 发现 + 禁用
const listed = await reg.list({}, ctx);
const names = listed.skills.map(s => s.name);
ok(names.includes("sign-flow") && names.includes("reverse-engineering"), "新技能被 skill_list 发现");
disabled = new Set(["sign-flow"]);
const listed2 = await reg.list({}, ctx);
ok(!listed2.skills.some(s => s.name === "sign-flow"), "禁用后从 skill_list 消失");
ok(listed2.skills.some(s => s.name === "reverse-engineering"), "内置不受禁用影响");
const got = await reg.get({ name: "sign-flow" }, ctx);
ok(got.ok === false && /禁用/.test(got.error), "禁用后 skill_get 拒绝并提示");
const uiList = await reg.list({ includeDisabled: true }, ctx);
const sgn = uiList.skills.find(s => s.name === "sign-flow");
ok(sgn && sgn.disabled === true, "UI 视图 includeDisabled 仍可见且带标记");

// ③ 编辑 / 删除
const full = await reg.get({ name: "own-front", includeDisabled: true }, ctx);
const upd = await reg.updateSkill({ name: "own-front", content: full.skill.replace("正文", "改过的正文") }, ctx);
ok(upd.ok && (await fs.readFile(upd.path, "utf8")).includes("改过的正文"), "updateSkill 整文保存");
const builtinEdit = await reg.updateSkill({ name: "reverse-engineering", content: "hack" }, ctx);
ok(builtinEdit.ok === false && /内置/.test(builtinEdit.error), "内置技能不可编辑");
const del = await reg.deleteSkill({ name: "own-front" }, ctx);
ok(del.ok && !(await fs.stat(path.join(home, ".firefox-reverse", "skills", "own-front")).catch(() => null)), "deleteSkill 移除目录");
const builtinDel = await reg.deleteSkill({ name: "reverse-engineering" }, ctx);
ok(builtinDel.ok === false, "内置技能不可删除");

// ④ matchTask 自动匹配
disabled = new Set();
await reg.saveSkill({ name: "wasm-emu", description: "wasm 补环境 与 签名还原 配方", content: "x" }, ctx);
const m1 = await reg.matchTask({ text: "帮我还原这个站 sign 里的 wasm 签名逻辑" }, ctx);
ok(m1.matches.some(x => x.name === "wasm-emu"), "描述短语命中 → 匹配");
const m2 = await reg.matchTask({ text: "帮我把 sign-flow 流程跑一遍" }, ctx);
ok(m2.matches.some(x => x.name === "sign-flow"), "技能名出现 → 匹配");
const m3 = await reg.matchTask({ text: "今天天气不错我们聊聊别的" }, ctx);
ok(m3.matches.length === 0, "无关任务不误注入");
const m4 = await reg.matchTask({ text: "还原 sign 并用 wasm 补环境验证 a-bogus" }, ctx);
ok(m4.matches.length <= 3, "匹配数封顶");
const mBuiltin = m4.matches.some(x => x.name === "reverse-engineering");
ok(!mBuiltin, "内置方法论不参与自动注入");
const mDis = await (async () => { disabled = new Set(["wasm-emu"]); const r = await reg.matchTask({ text: "wasm 补环境 签名还原 配方" }, ctx); disabled = new Set(); return r; })();
ok(!mDis.matches.some(x => x.name === "wasm-emu"), "禁用技能不会被自动匹配");

console.log(fail ? `\nskills-admin selftest: ${fail} FAILED` : `\nskills-admin selftest: ALL PASS (${pass})`);
process.exit(fail ? 1 : 0);
