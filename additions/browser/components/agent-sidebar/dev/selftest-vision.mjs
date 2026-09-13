#!/usr/bin/env node
/* selftest-vision.mjs — 二开 M4：vision/video 能力开关 + video_snapshots + 视觉预算自测。
 * ① video_snapshots 注册门（有 page.videoSnapshots 后端才出现）；
 * ② hiddenTools：未勾选视频 → 工具声明里不下发；勾选 → 下发；
 * ③ 视觉回喂滚动预算：每轮回喂图片总数 ≤3，更早的换成文字占位；vision=false 完全不回喂。
 */
import { ToolRouter } from "../modules/ToolRouter.sys.mjs";
import { createBuiltinTools } from "../modules/Tools.sys.mjs";
import { runAgentTurn } from "../modules/AgentLoop.sys.mjs";

let fail = 0;
const ok = (cond, name) => { console.log(`${cond ? "PASS" : "FAIL"} ${name}`); if (!cond) fail++; };

// ── ① 注册门 ────────────────────────────────────────────────────────────
{
  const none = createBuiltinTools({});
  ok(!none.some(t => t.name === "video_snapshots"), "无 page 后端 → 不注册 video_snapshots");
  const fakePage = { videoSnapshots: async a => ({ ok: true, note: "抽了2帧", frames: [{ t: 1 }, { t: 2 }], _media: [{ type: "image", mime: "image/jpeg", dataUrl: "data:image/jpeg;base64,A" }, { type: "image", mime: "image/jpeg", dataUrl: "data:image/jpeg;base64,B" }] }) };
  const some = createBuiltinTools({ page: fakePage });
  ok(some.some(t => t.name === "video_snapshots"), "有 page.videoSnapshots → 注册");
  const router = new ToolRouter();
  router.registerAll(some);
  const env = await router.dispatch("video_snapshots", { count: 2 });
  ok(env.ok && Array.isArray(env.media) && env.media.length === 2, "dispatch 后 _media 进 env.media");
  ok(!JSON.stringify(env.data).includes("data:image"), "data 里不带 base64 大数据");
}

// ── 公共夹具 ────────────────────────────────────────────────────────────
function fakeClient(script) {
  const calls = [];
  return {
    model: "vision-fake",
    calls,
    async chat(msgs, opts) {
      calls.push({ msgs: JSON.parse(JSON.stringify(msgs)), tools: (opts && opts.tools || []).map(t => t.function.name) });
      const next = script.shift();
      if (!next) throw new Error("script exhausted");
      return next;
    },
  };
}
const tc = (name, args) => ({ id: `c${Math.random().toString(36).slice(2, 7)}`, type: "function", function: { name, arguments: JSON.stringify(args || {}) } });

function shotRouter(imgsPerCall) {
  const router = new ToolRouter();
  router.register({
    name: "snap",
    description: "t",
    parameters: { type: "object", properties: {} },
    handler: async () => ({ ok: true, note: "shot", _media: Array.from({ length: imgsPerCall }, (_, i) => ({ type: "image", mime: "image/jpeg", dataUrl: `data:image/jpeg;base64,IMG${i}` })) }),
  });
  // video_snapshots 用假 page 后端注册（验证 hiddenTools 时按名过滤）
  router.registerAll(createBuiltinTools({ page: { videoSnapshots: async () => ({ ok: true }) } }));
  return router;
}

// ── ② hiddenTools 声明面 ────────────────────────────────────────────────
{
  const final = { content: "完成", toolCalls: [], finishReason: "stop" };
  const hidden = await fakeClient([{ ...final }]);
  await runAgentTurn({ client: hidden, router: shotRouter(1), messages: [{ role: "user", content: "t" }], systemPrompt: "s", dynamicContext: "", maxRounds: 2, assist: true, hiddenTools: ["video_snapshots"], onEvent: () => {} });
  ok(!hidden.calls[0].tools.includes("video_snapshots"), "hiddenTools 后不下发 video_snapshots");
  ok(hidden.calls[0].tools.includes("snap"), "其余工具不受影响");
  const shown = await fakeClient([{ ...final }]);
  await runAgentTurn({ client: shown, router: shotRouter(1), messages: [{ role: "user", content: "t" }], systemPrompt: "s", dynamicContext: "", maxRounds: 2, assist: true, onEvent: () => {} });
  ok(shown.calls[0].tools.includes("video_snapshots"), "不传 hiddenTools → 正常下发");
}

// ── ③ 视觉滚动预算 ──────────────────────────────────────────────────────
{
  // 每轮 snap 返回 2 张图，跑 3 轮（6 张）→ 最终 msgs 里只该剩最近 ≤3 张 image_url
  const script = [
    { content: "r1", toolCalls: [tc("snap")], finishReason: "tool_calls" },
    { content: "r2", toolCalls: [tc("snap")], finishReason: "tool_calls" },
    { content: "r3", toolCalls: [tc("snap")], finishReason: "tool_calls" },
    { content: "结论", toolCalls: [], finishReason: "stop" },
  ];
  const client = fakeClient(script);
  const res = await runAgentTurn({ client, router: shotRouter(2), messages: [{ role: "user", content: "t" }], systemPrompt: "s", dynamicContext: "", maxRounds: 5, assist: true, vision: true, onEvent: () => {} });
  const finalMsgs = client.calls.at(-1).msgs; // 最后一轮真实发出的消息
  const imgCount = finalMsgs.reduce((n, m) => n + (Array.isArray(m.content) ? m.content.filter(b => b.type === "image_url").length : 0), 0);
  ok(imgCount <= 3 && imgCount > 0, `回喂图片滚动预算 ≤3（末轮实发 ${imgCount} 张）`);
  const dropped = finalMsgs.some(m => Array.isArray(m.content) && m.content.some(b => b.type === "text" && /视觉预算被丢弃/.test(b.text || "")));
  ok(dropped, "被丢弃的旧图换成文字占位（模型知道要重截）");
  const urls = finalMsgs.flatMap(m => Array.isArray(m.content) ? m.content.filter(b => b.type === "image_url").map(b => b.image_url.url) : []);
  ok(urls.length === imgCount && urls.every(u => /IMG[01]/.test(u)), "留下的都是最近批次的图");
  void res;
}

// ── ③b vision=false 回归：绝不回喂图片 ─────────────────────────────────
{
  const script = [
    { content: "r1", toolCalls: [tc("snap")], finishReason: "tool_calls" },
    { content: "结论", toolCalls: [], finishReason: "stop" },
  ];
  const client = fakeClient(script);
  await runAgentTurn({ client, router: shotRouter(2), messages: [{ role: "user", content: "t" }], systemPrompt: "s", dynamicContext: "", maxRounds: 3, assist: true, vision: false, onEvent: () => {} });
  const anyImg = client.calls.some(c => c.msgs.some(m => Array.isArray(m.content) && m.content.some(b => b.type === "image_url")));
  ok(!anyImg, "vision=false → 消息里零图片块（无 vision 模型回归保护）");
}

console.log(fail ? `\nvision selftest: ${fail} FAILED` : "\nvision selftest: ALL PASS");
process.exit(fail ? 1 : 0);
