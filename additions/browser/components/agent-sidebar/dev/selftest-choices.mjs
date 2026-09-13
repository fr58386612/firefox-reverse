#!/usr/bin/env node
/* selftest-choices.mjs — 二开 M2：offer_choices 决策选项回路自测。
 * 假 LLM client 驱动**真实** runAgentTurn/ToolRouter/createBuiltinTools：
 *   ① offer_choices 无 backend 也注册、参数被规范化；
 *   ② 调用后 runAgentTurn 以 await_choice 结束、发出 choices_offer 事件、工具结果已进 msgs；
 *   ③ 与同批其它工具共存（先执行完再停）；
 *   ④ 未调用 offer_choices 的 assist 纯文字轮仍按 final 停（回归保护）。
 */
import { ToolRouter } from "../modules/ToolRouter.sys.mjs";
import { createBuiltinTools, declaredToolNames } from "../modules/Tools.sys.mjs";
import { runAgentTurn } from "../modules/AgentLoop.sys.mjs";

let fail = 0;
const ok = (cond, name) => { console.log(`${cond ? "PASS" : "FAIL"} ${name}`); if (!cond) fail++; };

// ① 注册面：无任何 backend 也要有 offer_choices（纯协议工具）
ok(declaredToolNames().includes("offer_choices"), "offer_choices 在工具表中");
const router = new ToolRouter();
router.registerAll(createBuiltinTools({}));
ok(router.has("offer_choices"), "空 backend 下 offer_choices 已注册");

const spec = router.listSpecs().find(t => t.function.name === "offer_choices");
ok(spec && spec.function.parameters.required.includes("question") && spec.function.parameters.required.includes("options"),
  "schema 必填 question+options");

// ② 参数规整：>6 个截断、无 label 过滤、allow_custom 默认 true
const env0 = await router.dispatch("offer_choices", {
  question: "选哪条路线？",
  options: [...Array(8)].map((_, i) => ({ label: `L${i}`, detail: `细节${i}` })).concat([{ detail: "无label应丢弃" }]),
});
ok(env0.ok && env0.data.options.length === 6 && env0.data.allow_custom === true,
  "options 截断到 6 且过滤无 label 项");

// 假 client：脚本化返回队列
function fakeClient(script) {
  const calls = [];
  return {
    model: "fake-model",
    calls,
    async chat(msgs, opts) {
      calls.push(JSON.parse(JSON.stringify(msgs)));
      const next = script.shift();
      if (!next) throw new Error("fake client script exhausted");
      return typeof next === "function" ? next(msgs) : next;
    },
  };
}
const tc = (name, args) => ({ id: `call_${Math.random().toString(36).slice(2, 8)}`, type: "function", function: { name, arguments: JSON.stringify(args) } });

// 注册一个哑工具验证"同批先执行再停"
router.register({
  name: "dummy_note",
  description: "test",
  parameters: { type: "object", properties: { msg: { type: "string" } } },
  handler: async ({ msg }) => ({ noted: msg }),
});

// ② 核心：offer_choices → await_choice 停 + 事件 + 历史含 tool 结果
{
  const client = fakeClient([
    { content: "有个真分叉", toolCalls: [tc("offer_choices", { question: "走 hook 还是扣字节码？", options: [{ label: "A hook 日志", detail: "包 fetch 记 I/O" }, { label: "B jsvmp_trace" }] })], finishReason: "tool_calls" },
  ]);
  const events = [];
  const res = await runAgentTurn({
    client, router,
    messages: [{ role: "user", content: "逆向 sign 参数" }],
    systemPrompt: "test", dynamicContext: "",
    maxRounds: 5, assist: true,
    onEvent: ev => events.push(ev),
  });
  ok(res.stopReason === "await_choice", `stopReason=await_choice（实际 ${res.stopReason}）`);
  ok(res.choices && res.choices.question === "走 hook 还是扣字节码？" && res.choices.options.length === 2, "返回值携带 choices");
  const offer = events.find(e => e.type === "choices_offer");
  ok(!!offer && Array.isArray(offer.options), "发出 choices_offer 事件");
  ok(client.calls.length === 1, "停时不再发起下一轮 LLM 调用");
  const toolMsg = res.messages.filter(m => m.role === "tool").at(-1);
  ok(!!toolMsg && /hook 日志/.test(toolMsg.content || ""), "工具结果（选项 JSON）已进入 msgs → 下一轮模型可见");
}

// ③ 同批混合：dummy 先执行、offer 后生效停轮
{
  const client = fakeClient([
    { content: "顺手记一笔再问", toolCalls: [tc("dummy_note", { msg: "先干个活" }), tc("offer_choices", { question: "Q?", options: [{ label: "X" }] })], finishReason: "tool_calls" },
  ]);
  const res = await runAgentTurn({
    client, router, messages: [{ role: "user", content: "t" }], systemPrompt: "s", dynamicContext: "", maxRounds: 5, onEvent: () => {},
  });
  ok(res.stopReason === "await_choice", "混合批次也停在 await_choice");
  const noted = res.messages.some(m => m.role === "tool" && /先干个活/.test(m.content || ""));
  ok(noted, "同批 dummy 工具已真实执行");
}

// ④ 回归：不调 offer_choices 的 assist 纯文字轮 → final（原行为）
{
  const client = fakeClient([{ content: "## 结论\n做完了", toolCalls: [], finishReason: "stop" }]);
  const res = await runAgentTurn({
    client, router, messages: [{ role: "user", content: "t" }], systemPrompt: "s", dynamicContext: "", maxRounds: 5, assist: true, onEvent: () => {},
  });
  ok(res.stopReason === "final", `无选项时 assist 仍 final（实际 ${res.stopReason}）`);
}

console.log(fail ? `\nchoices selftest: ${fail} FAILED` : "\nchoices selftest: ALL PASS");
process.exit(fail ? 1 : 0);
