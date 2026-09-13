/* ContextProjection.sys.mjs - bounded model context while preserving full UI history. */

export const CONTEXT_PROJECTION_VERSION = 1;
export const DEFAULT_PROJECTION_TRIGGER_CHARS = 120000;
export const DEFAULT_PROJECTION_TAIL_CHARS = 40000;

export const CONTEXT_PROJECTION_PROMPT = `You maintain a compact continuation record for a long-running browser Agent conversation.
Summarize only durable information required to continue without repeating completed work. Preserve exact paths, URLs, identifiers, samples, decisions, failed approaches, user constraints, and the single next action. Never invent facts.
Use this structure when applicable:
## Goal
## Confirmed facts
## Rejected approaches
## Files and artifacts
## User constraints
## Current state and next action
Output only the continuation record.`;

export function messageSize(message) {
  if (!message || typeof message !== "object") {
    return 0;
  }
  let size = 16;
  try {
    size +=
      typeof message.content === "string"
        ? message.content.length
        : JSON.stringify(message.content ?? "").length;
  } catch {
    size += String(message.content || "").length;
  }
  return size;
}

export function messagesSize(messages) {
  return (Array.isArray(messages) ? messages : []).reduce(
    (sum, message) => sum + messageSize(message),
    0
  );
}

export function normalizeContextProjection(raw, messageCount = Infinity) {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const cutoff = Math.floor(Number(raw.cutoff));
  const summary = typeof raw.summary === "string" ? raw.summary.trim() : "";
  if (
    raw.version !== CONTEXT_PROJECTION_VERSION ||
    !summary ||
    !Number.isFinite(cutoff) ||
    cutoff < 1 ||
    cutoff >= messageCount
  ) {
    return null;
  }
  return {
    version: CONTEXT_PROJECTION_VERSION,
    summary,
    cutoff,
    sourceCount: Number.isFinite(raw.sourceCount)
      ? Math.max(cutoff, Math.floor(raw.sourceCount))
      : cutoff,
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now(),
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : Date.now(),
    strategy: "projected",
  };
}

/** Pick a user-message boundary that retains a bounded recent tail. */
export function chooseProjectionCutoff(
  messages,
  { keepRecentChars = DEFAULT_PROJECTION_TAIL_CHARS, minRecentMessages = 6 } = {}
) {
  const list = Array.isArray(messages) ? messages : [];
  if (list.length <= minRecentMessages + 2) {
    return null;
  }
  const firstUser = list.findIndex(message => message && message.role === "user");
  if (firstUser < 0) {
    return null;
  }

  let size = 0;
  let candidate = Math.max(firstUser + 1, list.length - minRecentMessages);
  for (let i = list.length - 1; i > firstUser; i--) {
    size += messageSize(list[i]);
    candidate = i;
    if (size >= keepRecentChars && list.length - i >= minRecentMessages) {
      break;
    }
  }
  while (candidate < list.length && list[candidate]?.role !== "user") {
    candidate++;
  }
  return candidate > firstUser && candidate < list.length ? candidate : null;
}

export function projectMessages(messages, rawProjection) {
  const list = Array.isArray(messages) ? messages : [];
  const projection = normalizeContextProjection(rawProjection, list.length);
  if (!projection || list[projection.cutoff]?.role !== "user") {
    return list.slice();
  }
  const anchorIndex = list.findIndex(
    (message, index) => index < projection.cutoff && message?.role === "user"
  );
  const out = [];
  if (anchorIndex >= 0) {
    out.push(list[anchorIndex]);
  }
  out.push({
    role: "assistant",
    content: `【历史上下文投影】\n${projection.summary}`,
  });
  out.push(...list.slice(projection.cutoff));
  return out;
}

/** Return a new cutoff only when the current model-facing history exceeds the trigger. */
export function planContextProjection(
  messages,
  rawProjection,
  {
    triggerChars = DEFAULT_PROJECTION_TRIGGER_CHARS,
    keepRecentChars = DEFAULT_PROJECTION_TAIL_CHARS,
  } = {}
) {
  const list = Array.isArray(messages) ? messages : [];
  const current = normalizeContextProjection(rawProjection, list.length);
  if (messagesSize(projectMessages(list, current)) <= triggerChars) {
    return null;
  }
  const cutoff = chooseProjectionCutoff(list, { keepRecentChars });
  if (cutoff == null || (current && cutoff <= current.cutoff)) {
    return null;
  }
  return { cutoff, previous: current };
}

function transcriptLine(message) {
  if (!message) {
    return "";
  }
  const role = message.role === "user" ? "User" : "Assistant";
  const content =
    typeof message.content === "string"
      ? message.content
      : JSON.stringify(message.content ?? "");
  return `[${role}] ${content}`;
}

/** Build bounded source material for a projection update. */
export function buildProjectionInput(
  messages,
  { cutoff, previous = null },
  { maxChars = 80000 } = {}
) {
  const list = Array.isArray(messages) ? messages : [];
  const parts = [];
  const start = previous ? previous.cutoff : 0;
  if (previous) {
    parts.push("[Previous continuation record]\n" + previous.summary);
  }
  const transcript = list
    .slice(start, cutoff)
    .map(transcriptLine)
    .filter(Boolean)
    .join("\n\n");
  parts.push("[New history to incorporate]\n" + transcript);
  const joined = parts.join("\n\n");
  if (joined.length <= maxChars) {
    return joined;
  }
  const head = Math.floor(maxChars * 0.35);
  const tail = maxChars - head;
  return (
    joined.slice(0, head) +
    "\n\n[...middle omitted for projection input size...]\n\n" +
    joined.slice(-tail)
  );
}

/**
 * 手动压缩（M6 /compact）：与自动投影同一管线，只是不等触发阈值、强制找折叠边界。
 * 纯函数——chat(messages, opts)→{content} 由调用方注入，Node 可测。
 * 不直接写库：返回可直接交给 conversationStore.setContextProjection 的 projection。
 */
export async function compactConversation({
  messages,
  previous = null,
  chat,
  triggerChars = 0,
  keepRecentChars = 20000,
  minFoldChars = 1000,
  maxTokens = 2048,
} = {}) {
  const list = Array.isArray(messages) ? messages : [];
  if (typeof chat !== "function") {
    return { ok: false, error: "缺少可用的模型客户端" };
  }
  const plan = planContextProjection(list, previous, { triggerChars, keepRecentChars });
  if (!plan) {
    return { ok: false, error: "对话还太短（或近期消息已全是最新内容），暂时不需要压缩" };
  }
  const foldedChars = messagesSize(list.slice(0, plan.cutoff));
  if (foldedChars < minFoldChars) {
    return { ok: false, error: "可折叠的早期历史太少，压缩收益不明显" };
  }
  const source = buildProjectionInput(list, plan);
  const res = await chat(
    [
      { role: "system", content: CONTEXT_PROJECTION_PROMPT },
      {
        role: "user",
        content: "Update the continuation record from this bounded source:\n\n" + source,
      },
    ],
    { maxTokens }
  );
  const summary = String((res && res.content) || "").trim();
  if (!summary) {
    return { ok: false, error: "模型返回了空摘要，未改动原投影" };
  }
  const now = Date.now();
  return {
    ok: true,
    cutoff: plan.cutoff,
    total: list.length,
    foldedChars,
    projection: {
      version: CONTEXT_PROJECTION_VERSION,
      summary,
      cutoff: plan.cutoff,
      sourceCount: plan.cutoff,
      createdAt: (plan.previous && plan.previous.createdAt) || now,
      updatedAt: now,
      strategy: "projected",
    },
  };
}
