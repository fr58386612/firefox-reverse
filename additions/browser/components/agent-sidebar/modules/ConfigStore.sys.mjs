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

const PREF_PREFIX = "extensions.firefox-reverse.agent.";
const MODEL_PROFILES_KEY = PREF_PREFIX + "modelProfiles.v1";
const ACTIVE_MODEL_PROFILE_KEY = PREF_PREFIX + "activeModelProfileId";
const MAX_MODEL_PROFILES = 50;
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
        list = [data];
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
