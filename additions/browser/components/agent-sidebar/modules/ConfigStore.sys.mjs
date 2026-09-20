/* ConfigStore.sys.mjs — Agent 侧边栏配置持久化（active provider / API Key / 模型）。
 *
 * 设计：
 * - Firefox 内用 Services.prefs；无 Services 时（Node 自测）退化为内存 backend，
 *   因此本模块也能在 Node 下 import 验证（不静态依赖 Services）。
 * - 与 LlmClient 解耦：LlmClient 不读配置，只接收 apiKey 入参；本类只管存取。
 *
 * 安全提示：A1 用 prefs 明文存 API Key（已在 patches/agent-ui/README.md 标风险）。
 * LoginManager 加密存储留后续增强。
 */

import { normalizeReasoningEffort } from "./ReasoningEffort.sys.mjs";

// 二开 M8：内置「JS 逆向与自动化」能力档案的完整系统提示（原 AgentPanel.SYSTEM 迁入，单一来源）。
// 能力档案体系：内置档案文本永远从这里取（升级即生效、不入库），自定义档案存 prefs。
export const BUILTIN_REVERSE_PROFILE_TEXT = `你是 firefox-reverse 浏览器内置的 JS 逆向与自动化助手，可调用工具直接操作浏览器：分析页面、自动点击/滑动/填表、抓包、搜代码、追踪加密/签名参数的生成算法。

工具清单与参数你已在 function 列表里看到，这里不重复；只给必须时刻记住的核心，**完整方法论调 \`skill_get\` 读全文**。

【做逆向：先 skill_get】做签名/加密参数逆向前，**先调一次 \`skill_get\`** 把方法论（一页流：决策树→常规执行链 6 步→工具速查）拉进上下文，并自动释放 node 补环境/请求脚手架到工作目录（fs_copy 拿现成改）。开工也先 \`notes_get\` 看本站历史。

【通用 Skill】当用户说“使用/按照某个 Skill”时，先用 \`skill_list\` 查可用技能，再用 \`skill_get({name})\` 读取完整说明；需要其 references/assets 时按需调用 \`skill_read_resource\`。不要把 Skill 当成可绕过工具确认的自动执行代码。

【先判难度·简单站先走快车道】抓到接口**先看目标参数"长什么样"**(长度/字符集/是否 base64/有没有同发毫秒时间戳)——多数是**标准算法**(MD5/SHA/HMAC/AES/DES)，**别急着扣代码**：\`signer_trace\`/\`webapi_trace\` 抓 signer **真实入参** → 本地 \`crypto\` 对同一入参跑「候选算法×拼接模板」与真实值**逐字节比**，对上即收工(一行混淆都不用读)。**hook 不到入参 或 确认非官方算法**才降档到"扣最小片段进 vm→WASM→JSVMP"。trace **先 arm 再触发**(首屏就发的接口先开 trace 再 \`page_navigate\` 重载，否则只抓到 init 噪声)。详见 skill_get 决策树 ①→⑤。

【两阶段（详见 skill_get）】① **Node 可用版**：定位+\`scripts_save(toWorkspace)\` 落 signer → \`webapi_trace\`/\`webapi_query\` 抓指纹 → 用 \`net_get\` 抓**完整请求当模版**、逐步剥参数定位"真正的门" → \`npm_install\` 补环境只生成加密参数、其余稳定值(cookie/token)可从浏览器拿 → **以本地实打目标接口、返回有效数据为准**(不是"签名看着对")。② **白盒纯算**：\`jsvmp_trace\` 看 VM + 监控 node 链路 → 纯 .js/.py 逐字节对比。

【阶段门（skill_get §3.5 全文）】严格按 P0侦察→P1定位生成点→**P2 先验证再逆向**→P3判型→P4选策略(黑盒优先)→P5补环境→P6实打验证。**铁律：没用已知输入在浏览器复现出真实 wire 值(P2)前，禁止进字节码反汇编**——逆错对象是最大时间黑洞。**wire 参数 ≠ 最显眼 signer 的输出**(常见 wire=wrapper(signer,其它))，**永远 diff 真实样本**验证；格式/长度/前缀不符=没找对，回上一层。红旗(格式不符/长度对不上/偶尔为空)**必停**别忽略。

【账本而非流水（skill_get §6.5）】维护结构化 \`ledger.md\`：目标定义 / 已确认事实(带证据) / **已否决假设(永不重试)** / 待解问题 / 当前阶段+下一步。**想查/跑某事前先看账本——已确认或已否决里有的，直接用，绝不重新发现/重走死路**（"我来确认下 X"而 X 已在账本=违规）。压缩重启后第一件事按账本"当前阶段+下一步"续，**别从 P0 重侦察**。

【红线】① 最终产物运行时**不靠浏览器跑加密**(node 补环境/纯算都行；开浏览器调 signer 当 runtime=违规。但从浏览器抓的静态 cookie/token 当输入用**不算违规**，那是输入数据)；② \`page_eval\` **全权、别自我设限**——页面里读值/调 signer/**装 hook 记入参出参(「hook 日志大法」:包 \`window.fetch\`/XHR/crypto→交互触发→读 \`window.__log\`)/改全局/注入**都行,是你最趁手的分析工具,别因"应该只读"退回笨重 signer_trace;唯一边界是①(产物不靠浏览器);强检测/JSVMP 站注入**可能被测到**→**自己权衡**换不换引擎层 trace,**不是禁令**；③ 别全量 trace 整页(收窄到 signer 一次调用)；④ 站点无关、标准密码学用库不手搓。

【反绕圈】**⚠ 工具的硬限制 ≠「此路不通」（本 Agent 最大的坑，记牢）**：page_eval 输出被截 / run_node 超时 / 结果被上下文上限截 / fs_read 整读被拦——是**工具用法要换**（**取大源码·\`fn.toString()\` 一律加 \`saveTo:'work/x.js'\` 落盘再 code_search/fs_read**、超时调大、分段读），**不是分析路线死了**；**严禁**因撞工具上限就编个"环境/指纹绕不过"的体面根因、甩"白盒/oracle 二选一"来结案。看到 truncated/被截/只回一截 = 上限、换用法别换策略。 其次：同类报错 / 同一工具撞同一个错 **≥3 次 = 在绕圈** → 别再用同样方式重试，按 skill_get §6 换路线。系统也会在工具结果里给你换路线提示。

【上下文】大结果(trace/大文件/字节码)别整块灌进对话——先落盘、对话留摘要；要细节用 \`fs_read\` 的 offset/limit 分段、\`code_search\` 精搜、或 \`run_node\` 算好只回结论。（长会话堆大会拖慢甚至卡死。）
【沉淀】每验证通过一个关键结论 → \`notes_add\`（**只记验证过的**），下次同站点复用。结论用「## 结论」小标题：参数在哪生成 · 算法/依赖/指纹输入 · 可独立复现(附可运行 .js/.py + 实打接口返回有效数据)。

【自主执行（重要）】
- 拿到目标先拆成有序子任务清单（一两句列出来）；然后**不间断地逐个完成到全部结束**，每完成一步简述"做了什么/得到什么/下一步"，并**立即继续下一步**，无需等我点头。
- **不要每步都停下来问"要不要继续 / 是否继续 / 需要我做吗"**——默认一直推进到底。只有这两种情况才结束本轮：① 真正需要我提供你拿不到的东西（登录态/验证码/账号/纯业务决策）；② 目标已全部完成。
- 用工作目录形成闭环：抓取/分析 → fs_write 落盘中间产物（脚本、trace、还原代码、笔记）→ run_node/run_python **实跑验证** → 与页面真实产出对照 → 修正，直到还原结果经得起独立实跑比对。
- 工具失败/超时/结果为空别立刻收手：分析原因、换参数或换工具继续推进；同一工具别用相同入参反复重试。
- **要用户在几条路里拍板时（缺账号/登录态之外的纯业务决策、或几条实质不同的技术路线）→ 调 \`offer_choices\`** 把方向做成可点击选项，别只用文字罗列让用户手打。

【纪律】
- 主动调工具，别空想；用中文，结论要可落地。
- 不确定就明说"不确定"并给下一步建议，然后继续尝试，而不是停下来等我。
- 给结论用「## 结论」作小标题，简洁直接；别用"实事求是的结论"之类套话/口头禅。`;

const PREF_PREFIX = "extensions.firefox-reverse.agent.";
const MODEL_PROFILES_KEY = PREF_PREFIX + "modelProfiles.v1";
const ACTIVE_MODEL_PROFILE_KEY = PREF_PREFIX + "activeModelProfileId";
const MAX_MODEL_PROFILES = 50;
// 二开 M8：Agent 能力档案（人设+方法论的系统提示）。prefs 只存自定义档案；
// 内置「JS 逆向与自动化」永远由代码合成（升级即生效），激活项单独记一个 key。
const AGENT_PROFILES_KEY = PREF_PREFIX + "agentProfiles.v1";
const ACTIVE_AGENT_PROFILE_KEY = PREF_PREFIX + "activeAgentProfileId";
const BUILTIN_REVERSE_PROFILE_ID = "ap_reverse";
const MAX_AGENT_PROFILES = 20;
const MAX_AGENT_SYSTEM_CHARS = 20000;
const LEGACY_PROVIDER_IDS = ["deepseek", "zhipu", "kimi", "minimax", "qwen", "custom"];

const PROVIDER_NAMES = {
  deepseek: "DeepSeek",
  zhipu: "智谱 GLM",
  kimi: "Kimi",
  minimax: "MiniMax",
  qwen: "通义千问",
  custom: "自定义模型",
};

function profileId() {
  return "mp_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}

// 二开 M8：能力档案净化（自定义档案存 prefs；内置档案由代码合成，不经过这里）。
function agentProfileId() {
  return "ap_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}
function cleanAgentName(value, fallback = "能力档案") {
  return String(value || fallback).replace(/\s+/g, " ").trim().slice(0, 60) || fallback;
}
function normalizeAgentProfile(raw = {}) {
  return {
    id: String(raw.id || agentProfileId()).slice(0, 60),
    name: cleanAgentName(raw.name),
    description: String(raw.description || "").replace(/\s+/g, " ").trim().slice(0, 200),
    system: String(raw.system || "").trim().slice(0, MAX_AGENT_SYSTEM_CHARS),
    builtin: false,
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now(),
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : Date.now(),
  };
}

function cleanProfileName(value, fallback = "模型配置") {
  return String(value || fallback).replace(/\s+/g, " ").trim().slice(0, 60) || fallback;
}

function normalizeProfile(raw = {}) {
  const provider = String(raw.provider || "deepseek").trim() || "deepseek";
  // 二开 M3/M4：上下文窗口(kTokens，0/缺省=按模型名自动探测) + 模型能力开关(视觉/视频)。
  // 读取时容错：旧配置缺这些字段 → 落到自动档/关，向后兼容不 bump 存储版本。
  const winK = Number(raw.contextWindowK);
  return {
    id: String(raw.id || profileId()).slice(0, 100),
    name: cleanProfileName(raw.name, PROVIDER_NAMES[provider] || "模型配置"),
    provider,
    apiKey: String(raw.apiKey || ""),
    model: String(raw.model || "").trim(),
    baseUrl: String(raw.baseUrl || "").trim(),
    protocol: raw.protocol === "anthropic" ? "anthropic" : "openai",
    reasoningEffort: normalizeReasoningEffort(raw.reasoningEffort || "auto"),
    contextWindowK: Number.isFinite(winK) && winK > 0 ? Math.min(Math.round(winK), 2000) : 0,
    vision: !!raw.vision,
    video: !!raw.video,
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now(),
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : Date.now(),
  };
}

/** 二开 M5：MCP server 配置规范化。stdio={command,args,env,cwd}；http={url,headers}；name 净化成可拼工具名的形态。 */
function normalizeMcpServer(raw = {}) {
  const transport = raw.transport === "http" ? "http" : "stdio";
  const name = String(raw.name || "")
    .trim()
    .replace(/[^A-Za-z0-9_.-]+/g, "-")
    .replace(/^[-_.]+|[-_.]+$/g, "")
    .slice(0, 40) || "mcp";
  const strMap = v =>
    v && typeof v === "object"
      ? Object.fromEntries(Object.entries(v).slice(0, 32).map(([k, val]) => [String(k).slice(0, 80), String(val)]))
      : {};
  return {
    id: String(raw.id || "mcp_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)).slice(0, 60),
    name,
    transport,
    command: String(raw.command || "").trim().slice(0, 500),
    args: Array.isArray(raw.args) ? raw.args.map(x => String(x)).slice(0, 32) : [],
    env: strMap(raw.env),
    cwd: String(raw.cwd || "").trim().slice(0, 500),
    url: String(raw.url || "").trim().slice(0, 500),
    headers: strMap(raw.headers),
    enabled: raw.enabled !== false,
  };
}

/** 选择 storage backend：有 Services.prefs 用之，否则内存（仅供 Node 自测）。 */
function makeBackend() {
  const S = globalThis.Services;
  if (S?.prefs) {
    return {
      persistent: true,
      getString(key, def = "") {
        try {
          return S.prefs.getStringPref(key, def);
        } catch {
          return def;
        }
      },
      setString(key, val) {
        S.prefs.setStringPref(key, val);
        // 立刻落盘，保证 API Key 等配置在非正常退出（崩溃/强杀）后仍在缓存里。
        try {
          S.prefs.savePrefFile(null);
        } catch {}
      },
      clear(key) {
        try {
          S.prefs.clearUserPref(key);
          S.prefs.savePrefFile(null);
        } catch {}
      },
    };
  }
  const mem = new Map();
  return {
    persistent: false,
    getString: (k, def = "") => (mem.has(k) ? mem.get(k) : def),
    setString: (k, v) => void mem.set(k, v),
    clear: (k) => void mem.delete(k),
  };
}

export class ConfigStore {
  constructor(backend = makeBackend()) {
    this.b = backend;
  }

  /** 真持久化（Firefox prefs）还是内存（Node 自测）。 */
  get isPersistent() {
    return !!this.b.persistent;
  }

  _readProfiles() {
    try {
      const parsed = JSON.parse(this.b.getString(MODEL_PROFILES_KEY, ""));
      if (Array.isArray(parsed) && parsed.length) {
        return parsed.slice(0, MAX_MODEL_PROFILES).map(normalizeProfile);
      }
    } catch {
      /* 旧版本没有此配置，下面自动迁移 */
    }
    return null;
  }

  _writeProfiles(profiles) {
    this.b.setString(MODEL_PROFILES_KEY, JSON.stringify(profiles.slice(0, MAX_MODEL_PROFILES)));
  }

  _legacyProfiles() {
    const active = this.b.getString(PREF_PREFIX + "activeProvider", "deepseek") || "deepseek";
    const ids = [active, ...LEGACY_PROVIDER_IDS.filter(id => id !== active)];
    const now = Date.now();
    const profiles = [];
    for (const provider of ids) {
      const apiKey = this.b.getString(PREF_PREFIX + "key." + provider, "");
      const model = this.b.getString(PREF_PREFIX + "model." + provider, "");
      const baseUrl = provider === "custom" ? this.b.getString(PREF_PREFIX + "custom.baseUrl", "") : "";
      // 当前 provider 即使尚未填 Key 也必须迁移；其它 provider 只有确实保存过数据才转成配置项。
      if (provider !== active && !apiKey && !model && !baseUrl) continue;
      profiles.push(normalizeProfile({
        id: profileId(),
        name: (PROVIDER_NAMES[provider] || provider) + " 原有配置",
        provider,
        apiKey,
        model,
        baseUrl,
        protocol: provider === "custom" ? this.b.getString(PREF_PREFIX + "custom.protocol", "openai") : "openai",
        reasoningEffort:
          provider === "custom" ? this.b.getString(PREF_PREFIX + "custom.reasoningEffort", "auto") : "auto",
        createdAt: now,
        updatedAt: now,
      }));
    }
    return profiles;
  }

  _ensureProfiles() {
    let profiles = this._readProfiles();
    if (!profiles) {
      profiles = this._legacyProfiles();
      this._writeProfiles(profiles);
      this.b.setString(ACTIVE_MODEL_PROFILE_KEY, profiles[0].id);
    }
    let activeId = this.b.getString(ACTIVE_MODEL_PROFILE_KEY, "");
    if (!profiles.some(p => p.id === activeId)) {
      activeId = profiles[0].id;
      this.b.setString(ACTIVE_MODEL_PROFILE_KEY, activeId);
    }
    return { profiles, activeId };
  }

  _syncLegacy(profile) {
    if (!profile) return;
    this.b.setString(PREF_PREFIX + "activeProvider", profile.provider);
    this.b.setString(PREF_PREFIX + "key." + profile.provider, profile.apiKey || "");
    this.b.setString(PREF_PREFIX + "model." + profile.provider, profile.model || "");
    if (profile.provider === "custom") {
      this.b.setString(PREF_PREFIX + "custom.baseUrl", profile.baseUrl || "");
      this.b.setString(PREF_PREFIX + "custom.protocol", profile.protocol || "openai");
      this.b.setString(
        PREF_PREFIX + "custom.reasoningEffort",
        normalizeReasoningEffort(profile.reasoningEffort || "auto")
      );
    }
  }

  /** 可命名的模型/账号配置。同一 provider 可保存多组 Key、URL 和模型。 */
  listModelProfiles() {
    return this._ensureProfiles().profiles.map(p => ({ ...p }));
  }

  getActiveModelProfileId() {
    return this._ensureProfiles().activeId;
  }

  getActiveModelProfile() {
    const { profiles, activeId } = this._ensureProfiles();
    const p = profiles.find(x => x.id === activeId) || profiles[0];
    return p ? { ...p } : null;
  }

  setActiveModelProfileId(id) {
    const { profiles } = this._ensureProfiles();
    const p = profiles.find(x => x.id === id);
    if (!p) {
      throw new Error("模型配置不存在: " + id);
    }
    this.b.setString(ACTIVE_MODEL_PROFILE_KEY, p.id);
    this._syncLegacy(p);
    return { ...p };
  }

  createModelProfile(input = {}) {
    const { profiles } = this._ensureProfiles();
    if (profiles.length >= MAX_MODEL_PROFILES) {
      throw new Error(`模型配置最多 ${MAX_MODEL_PROFILES} 条`);
    }
    const now = Date.now();
    const wanted = cleanProfileName(input.name, "新模型配置");
    let name = wanted;
    let n = 2;
    while (profiles.some(p => p.name === name)) {
      name = cleanProfileName(`${wanted} ${n++}`);
    }
    const p = normalizeProfile({ ...input, id: profileId(), name, createdAt: now, updatedAt: now });
    profiles.push(p);
    this._writeProfiles(profiles);
    this.b.setString(ACTIVE_MODEL_PROFILE_KEY, p.id);
    this._syncLegacy(p);
    return { ...p };
  }

  duplicateModelProfile(id) {
    const source = this.listModelProfiles().find(p => p.id === id);
    if (!source) {
      throw new Error("模型配置不存在: " + id);
    }
    const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...copy } = source;
    return this.createModelProfile({ ...copy, name: source.name + " 副本" });
  }

  updateModelProfile(id, patch = {}) {
    const { profiles, activeId } = this._ensureProfiles();
    const index = profiles.findIndex(p => p.id === id);
    if (index < 0) {
      throw new Error("模型配置不存在: " + id);
    }
    const current = profiles[index];
    const next = normalizeProfile({
      ...current,
      ...patch,
      id: current.id,
      name: cleanProfileName(patch.name, current.name),
      createdAt: current.createdAt,
      updatedAt: Date.now(),
    });
    profiles[index] = next;
    this._writeProfiles(profiles);
    if (activeId === id) {
      this._syncLegacy(next);
    }
    return { ...next };
  }

  deleteModelProfile(id) {
    const { profiles, activeId } = this._ensureProfiles();
    if (profiles.length <= 1) {
      throw new Error("至少保留一条模型配置");
    }
    const next = profiles.filter(p => p.id !== id);
    if (next.length === profiles.length) {
      return false;
    }
    this._writeProfiles(next);
    if (activeId === id) {
      this.b.setString(ACTIVE_MODEL_PROFILE_KEY, next[0].id);
      this._syncLegacy(next[0]);
    }
    return true;
  }

  // ── 二开 M8：Agent 能力档案（人设 + 方法论 = 系统提示基底）──────────────────
  // 内置「JS 逆向与自动化」永远由代码合成（BUILTIN_REVERSE_PROFILE_TEXT，升级即生效、
  // 不入库）；自定义档案存 prefs。激活项决定下一条消息起的系统提示。
  _builtinAgentProfile() {
    return {
      id: BUILTIN_REVERSE_PROFILE_ID,
      name: "JS 逆向与自动化",
      description: "内置默认：签名/加密参数还原、页面自动化、抓包、Node 补环境与实打验证",
      system: BUILTIN_REVERSE_PROFILE_TEXT,
      builtin: true,
      createdAt: 0,
      updatedAt: 0,
    };
  }

  _readAgentProfiles() {
    try {
      const parsed = JSON.parse(this.b.getString(AGENT_PROFILES_KEY, ""));
      if (Array.isArray(parsed)) {
        return parsed
          .filter(p => p && typeof p === "object" && !p.builtin)
          .slice(0, MAX_AGENT_PROFILES)
          .map(p => normalizeAgentProfile(p));
      }
    } catch {
      /* 首次使用没有该 pref，返回空表 */
    }
    return [];
  }

  _writeAgentProfiles(customs) {
    this.b.setString(AGENT_PROFILES_KEY, JSON.stringify(customs.slice(0, MAX_AGENT_PROFILES)));
  }

  listAgentProfiles() {
    return [this._builtinAgentProfile(), ...this._readAgentProfiles()];
  }

  getActiveAgentProfile() {
    const id = this.b.getString(ACTIVE_AGENT_PROFILE_KEY, BUILTIN_REVERSE_PROFILE_ID);
    return this.listAgentProfiles().find(p => p.id === id) || this._builtinAgentProfile();
  }

  setActiveAgentProfileId(id) {
    const p = this.listAgentProfiles().find(x => x.id === id);
    if (!p) {
      throw new Error("能力档案不存在: " + id);
    }
    this.b.setString(ACTIVE_AGENT_PROFILE_KEY, p.id);
    return { ...p };
  }

  createAgentProfile(input = {}) {
    const customs = this._readAgentProfiles();
    if (customs.length >= MAX_AGENT_PROFILES) {
      throw new Error(`自定义能力档案最多 ${MAX_AGENT_PROFILES} 条`);
    }
    const wanted = cleanAgentName(input.name, "");
    if (!wanted) {
      throw new Error("档案名称不能为空");
    }
    const system = String(input.system || "").trim();
    if (system.length < 10) {
      throw new Error("能力定义太短（至少 10 个字）——它就是你自己的系统提示");
    }
    let name = wanted;
    let n = 2;
    const taken = new Set(this.listAgentProfiles().map(p => p.name));
    while (taken.has(name)) {
      name = cleanAgentName(`${wanted} ${n++}`);
    }
    const p = normalizeAgentProfile({ ...input, name, system, id: agentProfileId(), createdAt: Date.now(), updatedAt: Date.now() });
    customs.push(p);
    this._writeAgentProfiles(customs);
    return { ...p };
  }

  updateAgentProfile(id, patch = {}) {
    if (id === BUILTIN_REVERSE_PROFILE_ID) {
      throw new Error("内置档案不可修改，可「复制为自定义档案」后编辑");
    }
    const customs = this._readAgentProfiles();
    const index = customs.findIndex(p => p.id === id);
    if (index < 0) {
      throw new Error("能力档案不存在: " + id);
    }
    const current = customs[index];
    const next = normalizeAgentProfile({
      ...current,
      ...patch,
      id: current.id,
      name: cleanAgentName(patch.name, current.name),
      system: patch.system != null ? String(patch.system).trim() || current.system : current.system,
      createdAt: current.createdAt,
      updatedAt: Date.now(),
    });
    if (next.system.length < 10) {
      throw new Error("能力定义太短（至少 10 个字）");
    }
    customs[index] = next;
    this._writeAgentProfiles(customs);
    return { ...next };
  }

  duplicateAgentProfile(id) {
    const source = this.listAgentProfiles().find(p => p.id === id);
    if (!source) {
      throw new Error("能力档案不存在: " + id);
    }
    const { id: _id, createdAt: _c, updatedAt: _u, builtin: _b, ...copy } = source;
    return this.createAgentProfile({ ...copy, name: source.name + " 副本" });
  }

  deleteAgentProfile(id) {
    if (id === BUILTIN_REVERSE_PROFILE_ID) {
      throw new Error("内置档案不可删除");
    }
    const customs = this._readAgentProfiles();
    const next = customs.filter(p => p.id !== id);
    if (next.length === customs.length) {
      return false;
    }
    this._writeAgentProfiles(next);
    if (this.b.getString(ACTIVE_AGENT_PROFILE_KEY, "") === id) {
      this.b.setString(ACTIVE_AGENT_PROFILE_KEY, BUILTIN_REVERSE_PROFILE_ID);
    }
    return true;
  }

  getActiveProvider(def = "deepseek") {
    const p = this.getActiveModelProfile();
    return (p && p.provider) || this.b.getString(PREF_PREFIX + "activeProvider", def);
  }
  setActiveProvider(name) {
    this.b.setString(PREF_PREFIX + "activeProvider", name);
    const p = this.getActiveModelProfile();
    if (p && p.provider !== name) {
      this.updateModelProfile(p.id, { provider: name });
    }
  }

  getApiKey(provider) {
    const p = this.getActiveModelProfile();
    if (p && p.provider === provider) return p.apiKey || "";
    return this.b.getString(PREF_PREFIX + "key." + provider, "");
  }
  setApiKey(provider, key) {
    this.b.setString(PREF_PREFIX + "key." + provider, key || "");
    const p = this.getActiveModelProfile();
    if (p && p.provider === provider && p.apiKey !== (key || "")) {
      this.updateModelProfile(p.id, { apiKey: key || "" });
    }
  }
  clearApiKey(provider) {
    this.b.clear(PREF_PREFIX + "key." + provider);
    const p = this.getActiveModelProfile();
    if (p && p.provider === provider && p.apiKey) {
      this.updateModelProfile(p.id, { apiKey: "" });
    }
  }

  getModel(provider, def = "") {
    const p = this.getActiveModelProfile();
    if (p && p.provider === provider) return p.model || def;
    return this.b.getString(PREF_PREFIX + "model." + provider, def);
  }
  setModel(provider, model) {
    this.b.setString(PREF_PREFIX + "model." + provider, model || "");
    const p = this.getActiveModelProfile();
    if (p && p.provider === provider && p.model !== (model || "")) {
      this.updateModelProfile(p.id, { model: model || "" });
    }
  }

  /** 自定义端点（provider="custom"）的 Base URL，如 http://host:port。 */
  getCustomBaseUrl(def = "") {
    const p = this.getActiveModelProfile();
    if (p && p.provider === "custom") return p.baseUrl || def;
    return this.b.getString(PREF_PREFIX + "custom.baseUrl", def);
  }
  setCustomBaseUrl(url) {
    this.b.setString(PREF_PREFIX + "custom.baseUrl", url || "");
    const p = this.getActiveModelProfile();
    if (p && p.provider === "custom" && p.baseUrl !== (url || "")) {
      this.updateModelProfile(p.id, { baseUrl: url || "" });
    }
  }

  /** 自定义端点协议："openai"（/v1/chat/completions）或 "anthropic"（/v1/messages）。 */
  getCustomProtocol(def = "openai") {
    const p = this.getActiveModelProfile();
    if (p && p.provider === "custom") return p.protocol || def;
    return this.b.getString(PREF_PREFIX + "custom.protocol", def);
  }
  setCustomProtocol(p) {
    this.b.setString(PREF_PREFIX + "custom.protocol", p || "openai");
    const active = this.getActiveModelProfile();
    if (active && active.provider === "custom" && active.protocol !== (p || "openai")) {
      this.updateModelProfile(active.id, { protocol: p || "openai" });
    }
  }

  /** 自定义 OpenAI 兼容端点的 reasoning_effort；"auto" 表示不发送该字段。 */
  getCustomReasoningEffort(def = "auto") {
    const p = this.getActiveModelProfile();
    if (p && p.provider === "custom") return normalizeReasoningEffort(p.reasoningEffort, def);
    return normalizeReasoningEffort(
      this.b.getString(PREF_PREFIX + "custom.reasoningEffort", def),
      def
    );
  }
  setCustomReasoningEffort(value) {
    const normalized = normalizeReasoningEffort(value);
    this.b.setString(
      PREF_PREFIX + "custom.reasoningEffort",
      normalized
    );
    const p = this.getActiveModelProfile();
    if (p && p.provider === "custom" && p.reasoningEffort !== normalized) {
      this.updateModelProfile(p.id, { reasoningEffort: normalized });
    }
  }

  /** 改动型工具（page_eval/导航/网络/存JS/jsvmp）执行前是否需用户确认。
   *  默认 false = autoApprove（工作站自用、不打断）。开启则每次改动型调用弹确认。 */
  getConfirmTools() {
    return this.b.getString(PREF_PREFIX + "confirmTools", "0") === "1";
  }
  setConfirmTools(on) {
    this.b.setString(PREF_PREFIX + "confirmTools", on ? "1" : "0");
  }

  /** Provider-native prompt caching. "auto" enables only known-compatible request fields. */
  getPromptCacheMode(def = "auto") {
    const value = this.b.getString(PREF_PREFIX + "promptCache.mode", def);
    return value === "off" ? "off" : "auto";
  }
  setPromptCacheMode(value) {
    this.b.setString(PREF_PREFIX + "promptCache.mode", value === "off" ? "off" : "auto");
  }

  /** Cache lifetime hint. Unsupported providers safely ignore it. */
  getPromptCacheTtl(def = "default") {
    const value = this.b.getString(PREF_PREFIX + "promptCache.ttl", def);
    return value === "5m" || value === "1h" ? value : "default";
  }
  setPromptCacheTtl(value) {
    this.b.setString(
      PREF_PREFIX + "promptCache.ttl",
      value === "5m" || value === "1h" ? value : "default"
    );
  }

  /** "projected" keeps full UI history but sends a bounded continuation record to the model. */
  getContextStrategy(def = "projected") {
    const value = this.b.getString(PREF_PREFIX + "context.strategy", def);
    return value === "legacy" ? "legacy" : "projected";
  }
  setContextStrategy(value) {
    this.b.setString(
      PREF_PREFIX + "context.strategy",
      value === "legacy" ? "legacy" : "projected"
    );
  }

  /** 默认工作目录（新会话继承上次用过的目录；可被每个会话各自覆盖）。 */
  getDefaultWorkspaceDir(def = "") {
    return this.b.getString(PREF_PREFIX + "workspace.default", def);
  }
  setDefaultWorkspaceDir(path) {
    this.b.setString(PREF_PREFIX + "workspace.default", path || "");
  }

  /** node/python 可执行文件路径覆盖（GUI 启动 PATH 精简、homebrew 等搜不到时手动指定）。 */
  getNodePath() {
    return this.b.getString(PREF_PREFIX + "exec.node", "");
  }
  setNodePath(p) {
    this.b.setString(PREF_PREFIX + "exec.node", p || "");
  }
  getPythonPath() {
    return this.b.getString(PREF_PREFIX + "exec.python", "");
  }
  setPythonPath(p) {
    this.b.setString(PREF_PREFIX + "exec.python", p || "");
  }

  /* ── 二开 M5：外部 MCP server（stdio 子进程 / Streamable HTTP） ── */

  listMcpServers() {
    try {
      const arr = JSON.parse(this.b.getString(PREF_PREFIX + "mcp.servers", "[]"));
      if (!Array.isArray(arr)) return [];
      return arr.map(normalizeMcpServer).filter(s => s.name && (s.transport === "http" ? s.url : s.command));
    } catch {
      return [];
    }
  }
  /** 原样返回已存条目（不过滤）——设置页据此显示，坏条目可见可修，不会"保存后凭空消失"。 */
  listMcpServersRaw() {
    try {
      const arr = JSON.parse(this.b.getString(PREF_PREFIX + "mcp.servers", "[]"));
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }
  setMcpServers(list) {
    const clean = (Array.isArray(list) ? list : []).map(normalizeMcpServer);
    this.b.setString(PREF_PREFIX + "mcp.servers", JSON.stringify(clean.slice(0, 16)));
    return clean.slice(0, 16);
  }
  /**
   * 二开修复：把用户粘贴的任意常见 MCP 配置宽容解析成可保存列表。
   * 支持：数组 / {"mcpServers"|"servers":{...}} 映射 / 单个 server 对象；
   * 字段别名：type↔transport、serverUrl|endpoint|uri↔url、cmd|bin↔command、
   * arguments↔args、environment↔env、httpHeaders↔headers；自动拆包一层嵌套
   * config|server|params|data|options。
   * 关键：**逐条校验**（name 必须是 ASCII；stdio 必须有 command、http 必须有 url），
   * 有任何错误就不产出列表——杜绝旧版把格式不对的条目静默存成空壳（name 兜底 "mcp"、command/url 全空）。
   * @returns {{servers: Array, errors: string[]}}
   */
  parseMcpInput(input) {
    const data = typeof input === "string" ? JSON.parse(input) : input;
    let list;
    if (Array.isArray(data)) {
      list = data;
    } else if (data && typeof data === "object") {
      const map = data.mcpServers || data.servers || data.mcp_servers;
      if (map && typeof map === "object" && !Array.isArray(map)) {
        list = Object.entries(map).map(([name, v]) => ({
          name,
          ...(v && typeof v === "object" ? v : {}),
        }));
      } else {
        // Claude Desktop 裸映射：{"dbx": {"type":"stdio","command":…}}——顶层键全是
        // server 名（无任何单 server 字段、且值都是对象）时按 名字→配置 展开。
        const SERVER_KEYS = ["name", "serverName", "command", "cmd", "bin", "executable",
          "url", "serverUrl", "server_url", "endpoint", "uri", "transport", "type",
          "args", "arguments", "env", "environment", "headers", "cwd", "workingDirectory", "enabled"];
        const keys = Object.keys(data);
        const looksLikeMap = keys.length > 0
          && !keys.some(k => SERVER_KEYS.includes(k))
          && keys.every(k => data[k] && typeof data[k] === "object" && !Array.isArray(data[k]));
        if (looksLikeMap) {
          list = Object.entries(data).map(([name, v]) => ({ name, ...v }));
        } else {
          list = [data];
        }
      }
    } else {
      return { servers: [], errors: ["配置需为数组、{\"mcpServers\":{…}} 映射或单个 server 对象"] };
    }
    const errors = [];
    const servers = [];
    list.slice(0, 16).forEach((item, i) => {
      const label = `第 ${i + 1} 条`;
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        errors.push(`${label}：不是 JSON 对象`);
        return;
      }
      let raw = item;
      for (const nestKey of ["config", "server", "params", "data", "options"]) {
        const inner = raw[nestKey];
        if (inner && typeof inner === "object" && !Array.isArray(inner)) {
          raw = { ...raw, ...inner };
          break;
        }
      }
      const name = String(raw.name || raw.serverName || "").trim();
      const url = String(raw.url || raw.serverUrl || raw.server_url || raw.endpoint || raw.uri || "").trim();
      const command = String(raw.command || raw.cmd || raw.bin || raw.executable || "").trim();
      const typeStr = String(raw.transport || raw.type || "").trim().toLowerCase();
      let transport;
      if (/http|sse|streamable/.test(typeStr)) transport = "http";
      else if (/stdio/.test(typeStr)) transport = "stdio";
      else transport = url && !command ? "http" : "stdio";
      if (!name) {
        errors.push(`${label}：缺少 name`);
        return;
      }
      if (!/^[A-Za-z0-9_.-]+$/.test(name)) {
        errors.push(`${label} "${name}"：name 需为 ASCII（字母/数字/-_ .），如 my-server`);
        return;
      }
      if (transport === "http" ? !/^https?:\/\//i.test(url) : !command) {
        errors.push(
          transport === "http"
            ? `${label} "${name}"：http 传输缺少合法 url（需 http(s):// 开头）`
            : `${label} "${name}"：stdio 传输缺少 command（如 npx / node / uvx）`
        );
        return;
      }
      servers.push(
        normalizeMcpServer({
          id: raw.id,
          name,
          transport,
          command,
          args: raw.args || raw.arguments,
          env: raw.env || raw.environment,
          cwd: raw.cwd || raw.workingDirectory,
          url,
          headers: raw.headers || raw.httpHeaders || raw.requestHeaders,
          enabled: raw.enabled !== false,
        })
      );
    });
    if (Array.isArray(data) && data.length > 16) {
      errors.push(`最多支持 16 个 server（当前 ${data.length} 个）`);
    }
    return errors.length ? { servers: [], errors } : { servers, errors: [] };
  }

  /* ── 二开 M5：技能禁用集（SkillsPane 开关；内置技能不受影响） ── */

  getDisabledSkills() {
    try {
      const arr = JSON.parse(this.b.getString(PREF_PREFIX + "skills.disabled", "[]"));
      return Array.isArray(arr) ? arr.map(String) : [];
    } catch {
      return [];
    }
  }
  setSkillDisabled(name, disabled) {
    const cur = new Set(this.getDisabledSkills());
    if (disabled) cur.add(String(name));
    else cur.delete(String(name));
    this.b.setString(PREF_PREFIX + "skills.disabled", JSON.stringify([...cur]));
  }
}

/** 默认单例（Firefox 用；测试可 new ConfigStore(自定义 backend)）。 */
export const configStore = new ConfigStore();
