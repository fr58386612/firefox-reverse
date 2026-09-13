#!/usr/bin/env node
/* selftest-mcp.mjs — 二开 M5：MCP 客户端协议层 + 工具注册 + 配置规范化自测。
 * 内存假 MCP server（JSON-RPC over 行协议）驱动真实 MCPClient/MCPBackend/ToolRouter/ConfigStore。
 */
import { MCPJsonRpc, MCPClient, MCPBackend, mcpToolKey, resolveCommand, normalizePathEnv } from "../modules/MCPBackend.sys.mjs";
import { ConfigStore } from "../modules/ConfigStore.sys.mjs";
import { ToolRouter } from "../modules/ToolRouter.sys.mjs";

let fail = 0;
const ok = (c, m) => { console.log(`${c ? "PASS" : "FAIL"} ${m}`); if (!c) fail++; };

/* ── 假 MCP server：handle(msg) 生成回复 ── */
function makeFakeServer(tools, opts = {}) {
  const seen = { notifications: [], requests: [] };
  let clientRpc;
  const handle = msg => {
    seen.requests.push(msg);
    if (msg.method === "initialize") return { jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "fake", version: "9" } } };
    if (msg.method === "notifications/initialized") { seen.notifications.push(msg.method); return null; }
    if (msg.method === "tools/list") return { jsonrpc: "2.0", id: msg.id, result: { tools } };
    if (msg.method === "tools/call") {
      const { name, arguments: args } = msg.params;
      if (name === "boom") return { jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "炸了" }], isError: true } };
      if (name === "pic") return { jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "看图" }, { type: "image", mimeType: "image/jpeg", data: "QUJD" }] } };
      return { jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: `echo:${JSON.stringify(args)}` }] } };
    }
    return { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "no such method " + msg.method } };
  };
  const sent = [];
  clientRpc = new MCPJsonRpc({
    name: "fake",
    send: obj => {
      sent.push(obj);
      if (opts.blackhole) return; // 不回话 → 触发超时路径
      if (obj.method) queueMicrotask(() => { const r = handle(obj); if (r) clientRpc.feed(JSON.stringify(r) + "\n"); });
      else clientRpc.feed(""); // 响应帧没有 method，由 request() 调用方等待——本假 server 不消费响应
    },
  });
  // 真实 server 也会往 stdout 打日志/分块传输——喂协议前先混脏数据测试宽容度。
  clientRpc.feed("this is not json\n\n");
  return { rpc: clientRpc, sent, seen };
}

const TOOLS = [
  { name: "echo", description: "回显", inputSchema: { type: "object", properties: { v: { type: "string" } } } },
  { name: "pic", description: "返回图", inputSchema: { type: "object" } },
  { name: "boom", description: "失败样例", inputSchema: { type: "object" } },
  { name: "bad name/中文", description: "要净化", inputSchema: { type: "object" } },
];

// ── ① 握手 + tools/list ──
{
  const { rpc, seen } = makeFakeServer(TOOLS);
  const c = await MCPClient.connect({ name: "fake", rpc });
  ok(c.tools.length === 4 && c.serverInfo.name === "fake", "initialize 握手 + tools/list");
  ok(seen.notifications.includes("notifications/initialized"), "initialized 通知已发");
  ok(c.alive && !rpc.closed, "连接存活");
}

// ── ② callTool：text / image→_media / isError ──
{
  const { rpc } = makeFakeServer(TOOLS);
  const c = await MCPClient.connect({ name: "fake", rpc });
  const r1 = await c.callTool("echo", { v: "hi" });
  ok(r1.ok && r1.result.includes("echo"), "tools/call 文本结果");
  const r2 = await c.callTool("pic", {});
  ok(r2._media && r2._media[0].dataUrl === "data:image/jpeg;base64,QUJD", "image 内容转 _media dataUrl");
  let threw = "";
  try { await c.callTool("boom", {}); } catch (e) { threw = e.message; }
  ok(/炸了/.test(threw), "isError → 抛错（进 ToolRouter 错误信封）");
}

// ── ③ server→client 请求（ping/未知方法）自动答复；脏行被吞 ──
{
  const { rpc, sent } = makeFakeServer([]);
  rpc.feed("{ broken json\n"); // 不应炸
  rpc.feed(JSON.stringify({ jsonrpc: "2.0", id: 99, method: "ping" }) + "\n");
  rpc.feed(JSON.stringify({ jsonrpc: "2.0", id: 100, method: "sampling/createMessage" }) + "\n");
  await new Promise(r => setTimeout(r, 10));
  const ping = sent.find(s => s.id === 99);
  const sampling = sent.find(s => s.id === 100);
  ok(ping && ping.result, "ping 请求回 result");
  ok(sampling && sampling.error && sampling.error.code === -32601, "未知 server 请求回 method-not-found");
}

// ── ④ 超时路径 ──
{
  const { rpc } = makeFakeServer([], { blackhole: true });
  let msg = "";
  try { await rpc.request("tools/list", {}, 1200); } catch (e) { msg = e.message; }
  ok(/超时/.test(msg), "无响应 → 超时错误不悬挂");
  rpc.close("bye");
  let closedMsg = "";
  try { await rpc.request("x", {}); } catch (e) { closedMsg = e.message; }
  ok(/closed|关闭/.test(closedMsg), "close 后请求立即失败");
}

// ── ⑤ MCPBackend：注册进 ToolRouter、命名净化、分发、失败冷却 ──
{
  const cfg = {
    listMcpServers: () => [
      { id: "1", name: "fs", transport: "stdio", command: "x", enabled: true },
      { id: "2", name: "off", transport: "stdio", command: "y", enabled: false },
    ],
  };
  const backend = new MCPBackend({ config: cfg });
  let attempts = 0;
  backend._connect = async server => {
    attempts++;
    if (server.name === "off") throw new Error("不该被连接");
    const { rpc } = makeFakeServer(TOOLS);
    return MCPClient.connect({ name: server.name, rpc });
  };
  const router = new ToolRouter();
  const res = await backend.syncRouter(router);
  ok(res.connected === 1 && res.added === 4, `连接 1 个 server 注册 4 工具（实际 ${res.connected}/${res.added}）`);
  ok(router.has("mcp__fs__echo") && router.has(mcpToolKey("fs", "bad name/中文")), "命名空间前缀 + OpenAI 名字净化");
  const env = await router.dispatch("mcp__fs__echo", { v: "x" });
  ok(env.ok && /echo/.test(JSON.stringify(env.data)), "经 ToolRouter 分发到 MCP server");
  const envPic = await router.dispatch("mcp__fs__pic", {});
  ok(envPic.media && envPic.media.length === 1, "MCP 图片结果 → env.media（视觉链路可喂）");
  const envErr = await router.dispatch("mcp__fs__boom", {});
  ok(envErr.ok === false && /炸了/.test(envErr.error), "isError → 错误信封");
  // 幂等再 sync 不重复注册
  const res2 = await backend.syncRouter(router);
  ok(res2.added === 0, "重复 syncRouter 幂等");
  const st = backend.status();
  ok(st.find(s => s.name === "fs").connected && st.find(s => s.name === "off").enabled === false, "status 汇报");
  void attempts;
}
{
  // 坏 server：错误记录 + 60s 冷却不再重连（防每回合 30s 超时税）
  const cfg = { listMcpServers: () => [{ id: "1", name: "bad", transport: "stdio", command: "x", enabled: true }] };
  const backend = new MCPBackend({ config: cfg });
  let attempts = 0;
  backend._connect = async () => { attempts++; throw new Error("spawn ENOENT"); };
  const r1 = await backend.ensureConnected();
  const r2 = await backend.ensureConnected();
  ok(r1.errors.length === 1 && /ENOENT/.test(r1.errors[0]), "连接失败 → errors 汇报");
  ok(attempts === 1 && r2.errors.length === 1, "失败冷却：第二次 ensure 不再重连");
}

// ── ⑥ ConfigStore：MCP servers + 技能禁用集 ──
{
  const cs = new ConfigStore();
  const saved = cs.setMcpServers([
    { name: "File System!", transport: "stdio", command: "npx", args: ["-y", "x"], env: { K: "V" }, enabled: true },
    { name: "", command: "", enabled: true },          // 无效：无名无命令 → 被丢
    { name: "remote", transport: "http", url: "https://x/mcp", headers: { Authorization: "Bearer t" } },
    { name: "off", command: "z", enabled: false },
  ]);
  // set 保存规范化后的原样列表（半成品条目允许存着，listMcpServers 读取时才过滤无效项）
  ok(saved.length === 4, "setMcpServers 保存全部规范化条目");
  ok(saved[0].name === "File-System" && saved[0].args.length === 2 && saved[0].env.K === "V", "name 净化 + args/env 保留");
  ok(saved[2].transport === "http" && saved[2].headers.Authorization.includes("Bearer"), "http 传输与 headers 保留");
  ok(saved[3].enabled === false, "enabled 显式 false 保留");
  ok(cs.listMcpServers().length === 3, "读取时无名无命令条目被过滤");
  const again = cs.listMcpServers();
  ok(again.length === 3 && again[1].url === "https://x/mcp", "重读持久化不丢");
  ok(cs.getDisabledSkills().length === 0, "默认无禁用技能");
  cs.setSkillDisabled("abc", true);
  cs.setSkillDisabled("def", true);
  cs.setSkillDisabled("abc", false);
  ok(JSON.stringify(cs.getDisabledSkills()) === JSON.stringify(["def"]), "禁用集增删生效");
}

/* ── 安装版修复回归：Gecko pathSearch 大小写敏感地读 environment.PATH ──
 * Explorer 启动（双击/开始菜单 = 安装版）的进程环境块主键名是 "Path"（注册表值名），
 * 只有 shell 启动才常见 "PATH"；subprocess_win.sys.mjs 只认大写 → dirs 为空、
 * 全部候选落空（用户报错里的 ".COM" 就是第一个候选）。 */
{
  globalThis.PathUtils = globalThis.PathUtils || {
    isAbsolute: p => /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("/"),
    join: (...x) => x.join("\\"),
  };
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { platform: "Win32" },
  });
  const NPM = "C:\\Users\\pc\\AppData\\Roaming\\npm";
  const fakeGecko = {
    async pathSearch(bin, env) {
      if (/^[a-zA-Z]:[\\/]/.test(bin)) return bin; // 绝对路径：存在性检查（简化为通过）
      const dirs = env && typeof env.PATH === "string" ? env.PATH.split(";") : [];
      for (const d of dirs) {
        if (/npm$/i.test(d) && /^dbx-mcp-server(\.cmd)?$/i.test(bin)) {
          return `${NPM}\\dbx-mcp-server.cmd`;
        }
      }
      const err = new Error(`Executable not found: ${bin}`);
      err.errorCode = 15;
      throw err;
    },
  };
  const explorerEnv = { Path: `C:\\Windows;${NPM}`, PATHEXT: ".COM;.EXE;.BAT;.CMD" };

  let threw = "";
  try { await resolveCommand(fakeGecko, "dbx-mcp-server", explorerEnv); } catch (e) { threw = e.message; }
  ok(/dbx-mcp-server\.COM/.test(threw), `未归一的 "Path" 键名 → 候选全落空、首个错误是 .COM（复现安装版 bug：${threw}）`);

  const hit = await resolveCommand(fakeGecko, "dbx-mcp-server", normalizePathEnv(explorerEnv));
  ok(/dbx-mcp-server\.cmd$/i.test(hit), `normalizePathEnv 后命中 .cmd（${hit}）`);

  const shellEnv = { PATH: `C:\\Windows;${NPM}`, PATHEXT: explorerEnv.PATHEXT };
  const hit2 = await resolveCommand(fakeGecko, "dbx-mcp-server", normalizePathEnv(shellEnv));
  ok(/\.cmd$/i.test(hit2), "已是大写 PATH 时 normalize 不干扰（开发版 shell 启动路径）");

  const abs = await resolveCommand(fakeGecko, `${NPM}\\dbx-mcp-server.cmd`, explorerEnv);
  ok(/dbx-mcp-server\.cmd$/.test(abs), "绝对路径命令直接透传");
}

console.log(fail ? `\nmcp selftest: ${fail} FAILED` : "\nmcp selftest: ALL PASS");
process.exit(fail ? 1 : 0);
