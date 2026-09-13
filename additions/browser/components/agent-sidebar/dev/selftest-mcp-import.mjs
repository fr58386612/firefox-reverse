#!/usr/bin/env node
/* selftest-mcp-import.mjs — 二开修复自测：
 * ① ConfigStore.parseMcpInput：宽容解析常见格式（mcpServers 映射/单对象/type/serverUrl 别名/
 *    config 嵌套），且坏条目逐条报错、整批拒绝——不再静默存空壳；
 * ② SkillRegistry.importSkill：.md 文件/目录导入、名字兜底、同名覆盖确认、资源目录复制。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ConfigStore } from "../modules/ConfigStore.sys.mjs";
import { SkillRegistry } from "../modules/SkillBackend.sys.mjs";

let pass = 0, fail = 0;
const ok = (c, m) => (c ? (pass++, console.log("  OK", m)) : (fail++, console.error("  FAIL", m)));

/* ── ① parseMcpInput ── */
const cs = new ConfigStore();

{
  const r = cs.parseMcpInput('{"mcpServers":{"everything":{"command":"npx","args":["-y","@modelcontextprotocol/server-everything"]}}}');
  ok(!r.errors.length && r.servers.length === 1 && r.servers[0].name === "everything" && r.servers[0].command === "npx",
    "Claude Desktop mcpServers 映射正常解析");
}
{
  // 用户事故现场复现：字段放错位置的对象必须报错，而不是存成 name:"mcp" 的空壳
  const r = cs.parseMcpInput('{"id":"mcp_x","name":"我的服务","config":{"command":"npx -y foo"}}');
  ok(r.servers.length === 0 && r.errors.length === 1 && /name 需为 ASCII/.test(r.errors[0]),
    "中文 name → 明确报 ASCII 要求，整批拒绝");
}
{
  const r = cs.parseMcpInput([{ name: "broken" }, { name: "good", command: "node" }]);
  ok(r.servers.length === 0 && r.errors.length === 1 && /第 1 条/.test(r.errors[0]) && /stdio/.test(r.errors[0]),
    "坏条目报「第 N 条」且好条目也不入库（拒绝空壳语义）");
}
{
  const r = cs.parseMcpInput({ name: "remote", type: "streamable_http", serverUrl: "https://example.com/mcp", httpHeaders: { Authorization: "Bearer x" } });
  ok(!r.errors.length && r.servers[0].transport === "http" && r.servers[0].url === "https://example.com/mcp" && r.servers[0].headers.Authorization === "Bearer x",
    "type/serverUrl/httpHeaders 别名 → http 传输");
}
{
  const r = cs.parseMcpInput('{"mcpServers":{"nested":{"config":{"cmd":"uvx","arguments":["pkg"],"env":{"K":"V"}}}}}');
  const s = r.servers[0];
  ok(!r.errors.length && s.command === "uvx" && s.args[0] === "pkg" && s.env.K === "V",
    "config 嵌套 + cmd/arguments 别名拆包");
}
{
  const r = cs.parseMcpInput([{ name: "web", transport: "http", url: "not-a-url" }]);
  ok(r.servers.length === 0 && /http\(s\)/.test(r.errors[0]), "http 条目缺合法 url → 报错");
}
{
  let threw = false;
  try { cs.parseMcpInput("{{{坏 JSON"); } catch { threw = true; }
  ok(threw, "非法 JSON 直接抛给调用方（UI 提示解析错误）");
}
{
  const r = cs.parseMcpInput([{ name: "keepid", id: "mcp_abc", command: "c", enabled: false }]);
  ok(r.servers[0].id === "mcp_abc" && r.servers[0].enabled === false, "id/enabled 透传");
}

/* ── ② importSkill（内存 FS 桩） ──
 * 桩对齐 FF153 新 IOUtils/PathUtils WebIDL：只有 stat(path)（无 followSymlinks）、
 * getChildren(全路径)、copy({recursive})、readDirectory/copyTree/realPath/baseName 均已删除。
 * junctions 集合模拟 Windows 装入点：stat 直接抛「不存在」，但枚举/读取照常（用户事故现场）。 */
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "frx-import-"));
const home = path.join(tmp, "home");
const src = path.join(tmp, "src");
await fs.mkdir(home, { recursive: true });
await fs.mkdir(src, { recursive: true });
globalThis.PathUtils = { join: (...p) => path.join(...p), filename: p => path.basename(p) };
globalThis.Services = { env: { get: () => home } };
const junctions = new Set();
globalThis.IOUtils = {
  async getChildren(p) { return (await fs.readdir(p)).map(n => path.join(p, n)); },
  async stat(p) {
    if (junctions.has(path.resolve(p))) { const e = new Error("Could not stat: file does not exist"); e.code = "ENOENT"; throw e; }
    const s = await fs.stat(p); return { type: s.isDirectory() ? "directory" : "regular", size: s.size };
  },
  readUTF8: p => fs.readFile(p, "utf8"),
  writeUTF8: (p, t) => fs.writeFile(p, t, "utf8"),
  async makeDirectory(p) { await fs.mkdir(p, { recursive: true }); },
  async remove(p) { await fs.rm(p, { recursive: true, force: true }); },
  async copy(from, to, opts = {}) { await fs.cp(from, to, { recursive: !!opts.recursive }); },
};
const reg = new SkillRegistry({});

{
  const f = path.join(src, "api-notes.md");
  await fs.writeFile(f, "---\nname: API-Notes\ndescription: 接口逆向备忘\n---\n# 用法\n看 references\n", "utf8");
  const r = await reg.importSkill({ path: f });
  ok(r.ok && r.name === "api-notes", `frontmatter name 生效（${r.name}）`);
  const listed = await reg.list({});
  ok(listed.skills.some(s => s.name === "api-notes"), "导入后立即被 skill_list 发现");
  const dupe = await reg.importSkill({ path: f });
  ok(!dupe.ok && dupe.needOverwrite === true && dupe.name === "api-notes", "同名再导入 → needOverwrite 让 UI 确认");
  const over = await reg.importSkill({ path: f, overwrite: true });
  ok(over.ok && /覆盖/.test(over.note), "overwrite:true 覆盖成功");
}
{
  const f = path.join(src, "My Skill Notes.md");
  await fs.writeFile(f, "# 裸文档\n没有 frontmatter\n", "utf8");
  const r = await reg.importSkill({ path: f });
  ok(r.ok && r.name === "my-skill-notes", `文件名兜底取名（${r.name}）`);
  const text = await fs.readFile(r.path, "utf8");
  ok(text.startsWith("---\nname: my-skill-notes") && text.includes("裸文档"), "裸 md 自动补 frontmatter 且正文保留");
}
{
  const dir = path.join(src, "wasm-kit");
  await fs.mkdir(path.join(dir, "references"), { recursive: true });
  await fs.writeFile(path.join(dir, "SKILL.md"), "---\nname: wasm-kit\ndescription: wasm 工具包\n---\n正文\n", "utf8");
  await fs.writeFile(path.join(dir, "references", "api.md"), "资源内容", "utf8");
  const r = await reg.importSkill({ path: dir });
  ok(r.ok && r.name === "wasm-kit" && r.copiedResources === 1, `目录导入含资源（copiedResources=${r.copiedResources}）`);
  const res = await reg.readResource({ name: "wasm-kit", path: "references/api.md" });
  ok(res.ok && res.content === "资源内容", "导入技能后 skill_read_resource 可用");
}
{
  // 选到技能包的父目录：唯一含 SKILL.md 的子目录被自动下钻，名字取自子目录
  const outer = path.join(src, "skill-pack");
  const inner = path.join(outer, "pack-item");
  await fs.mkdir(inner, { recursive: true });
  await fs.writeFile(path.join(inner, "SKILL.md"), "# 无 frontmatter\n正文\n", "utf8");
  const r = await reg.importSkill({ path: outer });
  ok(r.ok && r.name === "pack-item", `选父目录自动下钻唯一子目录（${r.name}）`);
}
{
  const r = await reg.importSkill({ path: path.join(src, "nope.md") });
  ok(!r.ok && /不存在/.test(r.error), "路径不存在 → 明确报错");
  const emptyDir = path.join(src, "empty-dir");
  await fs.mkdir(emptyDir, { recursive: true });
  const r2 = await reg.importSkill({ path: emptyDir });
  ok(!r2.ok && /没有 SKILL.md/.test(r2.error), "目录无 md → 明确报错");
}

{
  const r = cs.parseMcpInput('{"dbx":{"type":"stdio","command":"dbx-mcp-server","args":[]}}');
  ok(!r.errors.length && r.servers.length === 1 && r.servers[0].name === "dbx" && r.servers[0].transport === "stdio" && r.servers[0].command === "dbx-mcp-server",
    "Claude Desktop 裸映射 {\"dbx\":{type,command}} → 键即名字");
  const r2 = cs.parseMcpInput('{"multi":{"command":"a"},"other":{"type":"http","url":"https://x.y/mcp"}}');
  ok(!r2.errors.length && r2.servers.length === 2 && r2.servers[1].transport === "http", "裸映射多 server");
  const r3 = cs.parseMcpInput('{"name":"solo","command":"node"}');
  ok(!r3.errors.length && r3.servers.length === 1 && r3.servers[0].name === "solo", "单 server 对象不被误判为映射");
}
{
  // Windows junction（装入点）：目录本身 stat 抛「不存在」，但可枚举、SKILL.md 可读——
  // 用户现场 C:/Users/pc/.zcode/skills/pdf 就是 junction，旧实现卡死在这一步。
  const jdir = path.join(src, "pdf");
  await fs.mkdir(jdir, { recursive: true });
  await fs.mkdir(path.join(jdir, "scripts"), { recursive: true });
  await fs.writeFile(path.join(jdir, "SKILL.md"), "---\nname: pdf\ndescription: PDF 处理\n---\n正文\n", "utf8");
  await fs.writeFile(path.join(jdir, "scripts", "run.js"), "// res", "utf8");
  junctions.add(path.resolve(jdir));
  const r = await reg.importSkill({ path: jdir });
  ok(r.ok && r.name === "pdf", `junction 目录可导入（${r.error || r.name}）`);
  const listed = await reg.list({});
  ok(listed.skills.some(s => s.name === "pdf"), "junction 导入的技能可被 skill_list 发现");
  const res = await reg.readResource({ name: "pdf", path: "scripts/run.js" });
  ok(res.ok && res.content === "// res", "junction 内资源目录已随包复制");
}

console.log(`\nselftest-mcp-import: ${pass} PASS / ${fail} FAIL`);
process.exitCode = fail ? 1 : 0;
