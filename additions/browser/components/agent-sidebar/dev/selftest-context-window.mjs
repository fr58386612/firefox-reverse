#!/usr/bin/env node
/* selftest-context-window.mjs — 二开 M3：上下文窗口可配置 + 压缩阈值缩放自测。
 * ① ConfigStore：contextWindowK/vision/video 入库规范化（默认 0/false、钳位、脏值兜底）；
 * ② buildClientFromStore：profile 字段透传进 LlmClient，overrides 优先；
 * ③ runAgentTurn：用户显式窗口**压过**模型名启发式（小窗提前压缩、发出 checkpoint）；
 *    不配置时行为与旧版一致（大窗口名不触发压缩）。
 */
import { ConfigStore } from "../modules/ConfigStore.sys.mjs";
import { buildClientFromStore } from "../modules/providers.sys.mjs";
import { ToolRouter } from "../modules/ToolRouter.sys.mjs";
import { runAgentTurn } from "../modules/AgentLoop.sys.mjs";

let fail = 0;
const ok = (cond, name) => { console.log(`${cond ? "PASS" : "FAIL"} ${name}`); if (!cond) fail++; };

// ── ① ConfigStore 规范化 ────────────────────────────────────────────────
{
  const cs = new ConfigStore();
  const d = cs.createModelProfile({ name: "d", provider: "deepseek" });
  ok(d.contextWindowK === 0 && d.vision === false && d.video === false, "缺省字段落到自动档/关闭");
  const p = cs.createModelProfile({ name: "x", provider: "deepseek", contextWindowK: 200, vision: true, video: true });
  ok(p.contextWindowK === 200 && p.vision === true && p.video === true, "合法值原样入库");
  const c = cs.updateModelProfile(p.id, { contextWindowK: 99999 });
  ok(c.contextWindowK === 2000, "超大窗口钳位到 2000k");
  const bad = cs.updateModelProfile(p.id, { contextWindowK: "abc" });
  ok(bad.contextWindowK === 0, "脏值(非数字)兜底为 0 → 自动档，绝不炸配置");
  const zero = cs.updateModelProfile(p.id, { contextWindowK: 0, vision: "yes" });
  ok(zero.contextWindowK === 0 && zero.vision === true, "0=回到自动档；字符串真值转 true");
  const round = cs.listModelProfiles().find(x => x.id === p.id);
  ok(round.contextWindowK === 0 && round.vision === true, "重读持久化层字段不丢");
}

// ── ② buildClientFromStore 透传 ─────────────────────────────────────────
{
  const cs = new ConfigStore();
  const p = cs.createModelProfile({
    name: "c", provider: "custom", baseUrl: "https://x.example/v1",
    model: "some-model", apiKey: "k", contextWindowK: 128, vision: true,
  });
  cs.setActiveModelProfileId(p.id);
  const client = buildClientFromStore(cs);
  ok(client.contextWindowK === 128 && client.vision === true && client.video === false,
    "profile 字段进入 LlmClient");
  const c2 = buildClientFromStore(cs, { contextWindowK: 64, vision: false });
  ok(c2.contextWindowK === 64 && c2.vision === false, "overrides 优先于 profile");
  const bare = new ConfigStore();
  ok(buildClientFromStore(bare).contextWindowK === 0, "无 profile 配置 → 0（自动档）");
}

// ── ③ runAgentTurn：窗口设置驱动压缩 ───────────────────────────────────
function fakeClient(script, contextWindowK) {
  const calls = [];
  return {
    model: "deepseek-v4-tiny", // 名字落 XL 启发式档(compactAt=800k)——用来证明用户配置压过名字
    contextWindowK,
    calls,
    async chat(msgs) {
      calls.push(JSON.parse(JSON.stringify(msgs)));
      const next = script.shift();
      if (!next) throw new Error("fake client script exhausted");
      return next;
    },
  };
}
const tc = (name, args) => ({ id: `call_${Math.random().toString(36).slice(2, 8)}`, type: "function", function: { name, arguments: JSON.stringify(args || {}) } });

function makeRouter() {
  const router = new ToolRouter();
  router.register({
    name: "big_note",
    description: "test",
    parameters: { type: "object", properties: {} },
    handler: async () => ({ text: "回".repeat(7500) }), // 工具结果 ≈7.5k 字符
  });
  return router;
}

// C1：用户显式 8k 窗口 → compactAt=6400 → 轮2前触发压缩（checkpoint + onCheckpoint + 摘要进 msgs）
{
  const client = fakeClient([
    { content: "取个大结果", toolCalls: [tc("big_note")], finishReason: "tool_calls" },
    { content: "【交接摘要】已确认 sign 由 wasm 生成", finishReason: "stop" }, // handoff 摘要调用
    { content: "结论完成", toolCalls: [], finishReason: "stop" },
  ], 8);
  const events = [];
  let saved = "";
  const res = await runAgentTurn({
    client, router: makeRouter(),
    messages: [{ role: "user", content: "逆向 sign" }],
    systemPrompt: "s", dynamicContext: "", maxRounds: 4, assist: true,
    onEvent: ev => events.push(ev),
    onCheckpoint: async summary => { saved = summary; },
  });
  const cp = events.find(e => e.type === "checkpoint");
  ok(!!cp, "小窗配置触发压缩：发出 checkpoint 事件");
  ok(/交接摘要/.test(saved), "onCheckpoint 收到 LLM 交接摘要");
  ok(JSON.stringify(res.messages).includes("已确认 sign 由 wasm 生成"), "摘要折回上下文（压缩后续跑带状态）");
  ok(res.stopReason === "final", `压缩后正常收尾（实际 ${res.stopReason}）`);
}

// C2：不配置窗口 → 名字启发式 XL(800k) → 同样历史不压缩（回归保护 = 旧行为）
{
  const client = fakeClient([
    { content: "取个大结果", toolCalls: [tc("big_note")], finishReason: "tool_calls" },
    { content: "结论完成", toolCalls: [], finishReason: "stop" },
  ], 0);
  const events = [];
  const res = await runAgentTurn({
    client, router: makeRouter(),
    messages: [{ role: "user", content: "逆向 sign" }],
    systemPrompt: "s", dynamicContext: "", maxRounds: 4, assist: true,
    onEvent: ev => events.push(ev),
  });
  ok(!events.some(e => e.type === "checkpoint"), "未配置时维持名字启发式：不压缩");
  ok(client.calls.length === 2 && res.stopReason === "final", "无 handoff 额外调用、正常 final");
}

console.log(fail ? `\ncontext-window selftest: ${fail} FAILED` : "\ncontext-window selftest: ALL PASS");
process.exit(fail ? 1 : 0);
