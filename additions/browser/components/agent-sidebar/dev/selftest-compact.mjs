#!/usr/bin/env node
/* selftest-compact.mjs — 二开 M6：/compact 手动压缩 + 上下文预算视图自测。
 * ① contextBudgetFor：显式 winK 优先、模型名启发式回落（与引擎 modelBudget 同源）；
 * ② compactConversation：太短/缺 chat/空摘要的拒绝路径；happy path 的 cutoff/投影结构；
 * ③ 与旧投影合并：previous.createdAt 保留、旧摘要进入投影输入；
 * ④ 压缩后 projectMessages 真正变短（ getModelMessages 语义）。
 */
import {
  compactConversation,
  CONTEXT_PROJECTION_PROMPT,
  CONTEXT_PROJECTION_VERSION,
  messagesSize,
  projectMessages,
} from "../modules/ContextProjection.sys.mjs";
import { contextBudgetFor } from "../modules/AgentLoop.sys.mjs";

let pass = 0;
let fail = 0;
const ok = (condition, message) => {
  if (condition) {
    pass++;
    console.log("  ✓", message);
  } else {
    fail++;
    console.error("  ✗ FAIL:", message);
  }
};

// ── ① contextBudgetFor ──
{
  const b = contextBudgetFor("anything", 128);
  ok(b.compactAt === 102400 && b.maxChars === 128000 && b.explicit === true,
    "显式 winK=128 → 80% 阈值 / 100% 上限 / explicit 标记");
  const b2 = contextBudgetFor("claude-opus-4", 0);
  ok(b2.compactAt === 800000 && b2.explicit === false, "未配置 winK → 按模型名回落 XL 档");
  const b3 = contextBudgetFor("", 0);
  ok(b3.compactAt === 250000 && b3.explicit === false, "未知模型 → 默认档");
}

// 12 条 ~4k 字的对话：user/assistant 交替，索引 6 是 user（投影边界应落在 6）。
const mkList = () => {
  const list = [];
  for (let i = 0; i < 12; i++) {
    list.push({ role: i % 2 ? "assistant" : "user", content: `m${i}:` + "x".repeat(4000) });
  }
  return list;
};

// ── ② 拒绝路径 ──
{
  const r1 = await compactConversation({ messages: mkList(), chat: null });
  ok(!r1.ok && /模型客户端/.test(r1.error), "缺 chat → 拒绝");

  const tiny = [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }];
  const r2 = await compactConversation({ messages: tiny, chat: async () => ({ content: "s" }) });
  ok(!r2.ok && /太短|不需要/.test(r2.error), "对话太短 → 拒绝且给原因");

  const r3 = await compactConversation({
    messages: mkList(),
    chat: async () => ({ content: "   " }),
  });
  ok(!r3.ok && /空摘要/.test(r3.error), "模型返回空 → 拒绝、不动原投影");
}

// ── ③ happy path ──
{
  const list = mkList();
  const seen = [];
  const r = await compactConversation({
    messages: list,
    chat: async (msgs, opts) => {
      seen.push({ msgs, opts });
      return { content: "## Goal\n折叠后的续写摘要" };
    },
  });
  ok(r.ok === true, "足够长 → 压缩成功");
  ok(r.cutoff === 6 && r.total === 12, `cutoff=6/total=12（实际 ${r.cutoff}/${r.total}）`);
  ok(r.foldedChars >= 1000, `foldedChars=${r.foldedChars} 计入收益`);
  const p = r.projection;
  ok(
    p.version === CONTEXT_PROJECTION_VERSION &&
      p.summary === "## Goal\n折叠后的续写摘要" &&
      p.cutoff === 6 && p.sourceCount === 6 && p.strategy === "projected",
    "projection 结构可直接交给 setContextProjection"
  );
  ok(seen.length === 1 && seen[0].msgs[0].content === CONTEXT_PROJECTION_PROMPT,
    "只调一次模型、system 用投影提示词");
  ok(seen[0].opts.maxTokens === 2048, "摘要 maxTokens=2048");
  const source = seen[0].msgs[1].content;
  ok(source.includes("m5:") && !source.includes("m6:"), "投影输入含 cutoff 前内容、不含其后");
  ok(!source.includes("[Previous continuation record]"), "无旧投影时不带旧记录段");

  // ④ 压缩真的变短：projectMessages(list, projection) 显著小于原历史。
  const projected = projectMessages(list, p);
  const before = messagesSize(list);
  const after = messagesSize(projected);
  ok(projected.length === 8 && projected[1].content.includes("折叠后的续写摘要"),
    "projected=[锚定user,摘要,最近6条]");
  ok(after < before * 0.7, `体积 ${before} → ${after}（降幅 >30%）`);
}

// ── ⑤ 与旧投影合并 ──
{
  const list = mkList();
  const previous = {
    version: CONTEXT_PROJECTION_VERSION,
    summary: "旧续写记录",
    cutoff: 2,
    sourceCount: 2,
    createdAt: 111,
    updatedAt: 222,
    strategy: "projected",
  };
  const seen = [];
  const r = await compactConversation({
    messages: list,
    previous,
    chat: async (msgs) => { seen.push(msgs); return { content: "更新后的摘要" }; },
  });
  ok(r.ok && r.projection.cutoff === 6, "旧投影存在时继续推进 cutoff");
  ok(r.projection.createdAt === 111, "createdAt 沿用旧投影（更新时间线连续）");
  ok(seen[0][1].content.includes("[Previous continuation record]\n旧续写记录"), "旧摘要并入投影输入");
  ok(seen[0][1].content.includes("m2:") && !seen[0][1].content.includes("m1:"), "增量转录从旧 cutoff 起");
}

console.log(`\nselftest-compact: ${pass} PASS / ${fail} FAIL`);
process.exitCode = fail ? 1 : 0;
