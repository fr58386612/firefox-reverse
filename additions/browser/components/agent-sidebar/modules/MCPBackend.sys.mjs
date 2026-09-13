/* MCPBackend.sys.mjs — MCP 客户端（二开 M5）：连接外部 MCP server，把它们的工具挂进 Agent 工具池。
 *
 * 设计：
 * - JSON-RPC 2.0，换行分隔 JSON（MCP stdio 传输规范）；协议层（MCPJsonRpc/MCPClient）与传输解耦，
 *   Node 自测注入内存假传输即可驱动完整握手/调用，无需真子进程。
 * - 传输：① stdio（Gecko Subprocess 拉起本地 server，npx/uvx/自建 exe）；② Streamable HTTP（fetch，
 *   支持 Mcp-Session-Id 回显与 SSE data: 帧解析）。
 * - 工具进 ToolRouter 用 `mcp__<server>__<tool>` 命名空间前缀，防与内置 70 工具撞名；名字按 OpenAI
 *   function-name 规则（[A-Za-z0-9_-]）净化，原名保留在闭包里发回 server。
 * - tools/call 结果里 content[] 的 text 拼进 data；image 转 `_media`（M4 视觉链路直接可看图）；
 *   isError → 抛错走 ToolRouter 错误信封。
 * - 连接生命周期：ensureConnected 幂等（已连直接复用）；stdout EOF/进程退出即标记断开，下一回合自动重连。
 */

export const MCP_PROTOCOL_VERSION = "2024-11-05"; // 最广泛兼容的协商版本；server 不支持时按其返回版本走。

/* ───────────────────────── JSON-RPC 层 ───────────────────────── */

export class MCPJsonRpc {
  /**
   * @param {{send:(obj:object)=>void|Promise<void>, onError?:(e:Error)=>void, name?:string}} t
   */
  constructor(t) {
    this._send = t.send;
    this._onError = t.onError || (() => {});
    this._name = t.name || "mcp";
    this._nextId = 1;
    this._pending = new Map(); // id → {resolve, reject, timer}
    this._buf = "";
    this.closed = false;
    this.onNotification = null; // (method, params) => void
  }

  /** 喂 stdout 原始 chunk：按行拆 JSON。非 JSON 行（server 往 stdout 打的日志）静默跳过——
   *  这是 MCP stdio 生态的常见脏 server，宽容处理比报错有用。 */
  feed(chunk) {
    this._buf += chunk;
    let idx;
    while ((idx = this._buf.indexOf("\n")) >= 0) {
      const line = this._buf.slice(0, idx).trim();
      this._buf = this._buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      this._route(msg);
    }
  }

  _route(msg) {
    if (!msg || typeof msg !== "object") return;
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this._pending.get(msg.id);
      if (!p) return;
      this._pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(`${this._name}: ${msg.error.message || JSON.stringify(msg.error)}`));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method && msg.id !== undefined) {
      // server→client 请求（ping / sampling / elicitation）：除 ping 外一律回 method-not-found，
      // 保持连接可用（个人自用不接 sampling）。
      Promise.resolve()
        .then(() => this._send({
          jsonrpc: "2.0",
          id: msg.id,
          ...(msg.method === "ping" ? { result: {} } : { error: { code: -32601, message: "method not found" } }),
        }))
        .catch(() => {});
      return;
    }
    if (msg.method && this.onNotification) {
      try {
        this.onNotification(msg.method, msg.params);
      } catch { /* 通知处理失败不影响协议 */ }
    }
  }

  request(method, params, timeoutMs = 60000) {
    if (this.closed) return Promise.reject(new Error(`${this._name}: transport closed`));
    const id = this._nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`${this._name}: ${method} 超时(${timeoutMs}ms)`));
      }, Math.max(1000, timeoutMs));
      this._pending.set(id, { resolve, reject, timer });
      Promise.resolve(this._send({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) }))
        .catch(e => {
          this._pending.delete(id);
          clearTimeout(timer);
          reject(e);
        });
    });
  }

  notify(method, params) {
    if (this.closed) return;
    Promise.resolve(this._send({ jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) }))
      .catch(() => {});
  }

  /** 流结束（进程退出）：把所有在途请求以错误结算，避免调用方挂死。 */
  close(reason) {
    this.closed = true;
    const e = new Error(`${this._name}: ${reason || "连接已关闭"}`);
    for (const p of this._pending.values()) {
      clearTimeout(p.timer);
      p.reject(e);
    }
    this._pending.clear();
  }
}

/* ───────────────────────── 客户端层 ───────────────────────── */

export class MCPClient {
  /**
   * @param {{name:string, rpc:MCPJsonRpc, kill?:()=>void, serverCfg?:object}} p
   */
  constructor(p) {
    this.name = p.name;
    this.rpc = p.rpc;
    this._kill = p.kill || (() => {});
    this.serverCfg = p.serverCfg || {};
    this.serverInfo = null;
    this.protocolVersion = MCP_PROTOCOL_VERSION;
    this.tools = []; // [{name, description, inputSchema}]
  }

  static async connect(p) {
    const c = new MCPClient(p);
    const init = await c.rpc.request("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "firefox-reverse-agent", version: "1.0" },
    }, 30000);
    c.serverInfo = init && init.serverInfo ? init.serverInfo : null;
    if (init && init.protocolVersion) c.protocolVersion = init.protocolVersion;
    c.rpc.notify("notifications/initialized");
    const list = await c.rpc.request("tools/list", {}, 30000);
    c.tools = (list && Array.isArray(list.tools) ? list.tools : []).filter(t => t && typeof t.name === "string");
    return c;
  }

  get alive() {
    return !this.rpc.closed;
  }

  /** 调工具并把 MCP 多模态结果压平：text/resource→文本、image→_media。抛错=失败信封。 */
  async callTool(toolName, args, timeoutMs = 120000) {
    const res = await this.rpc.request("tools/call", { name: toolName, arguments: args || {} }, timeoutMs);
    const parts = res && Array.isArray(res.content) ? res.content : [];
    let text = "";
    const media = [];
    for (const b of parts) {
      if (!b || typeof b !== "object") continue;
      if (b.type === "text" && typeof b.text === "string") text += (text ? "\n" : "") + b.text;
      else if (b.type === "image" && b.data)
        media.push({ type: "image", mime: b.mimeType || "image/png", dataUrl: `data:${b.mimeType || "image/png"};base64,${b.data}` });
      else if (b.type === "resource" && b.resource && typeof b.resource.text === "string")
        text += (text ? "\n" : "") + b.resource.text;
    }
    if (!text && res && res.structuredContent !== undefined) {
      try { text = JSON.stringify(res.structuredContent); } catch { text = String(res.structuredContent); }
    }
    if (res && res.isError) {
      throw new Error(text || "MCP 工具返回 isError");
    }
    const out = { ok: true, server: this.name, tool: toolName, result: text || "(空结果)" };
    if (media.length) out._media = media;
    return out;
  }

  stop() {
    this.rpc.close("已手动停止");
    try { this._kill(); } catch { /* 已退出 */ }
  }
}

/* ───────────────────────── stdio 传输（Gecko 子进程） ───────────────────────── */

function lazyESM(url) {
  try {
    return ChromeUtils.importESModule(url);
  } catch {
    return null;
  }
}

// AppConstants 在 system ESM 里不是全局（不 import 就是 ReferenceError）——懒加载一次，
// Node 自测等无浏览器环境退回 navigator.platform。
let _isWin;
function isWindowsPlatform() {
  if (_isWin === undefined) {
    const AC = lazyESM("resource://gre/modules/AppConstants.sys.mjs");
    if (AC && AC.AppConstants) _isWin = AC.AppConstants.platform === "win";
    else {
      try { _isWin = /win/i.test(navigator.platform || ""); } catch { _isWin = false; }
    }
  }
  return _isWin;
}

async function connectStdio(server) {
  const SP = lazyESM("resource://gre/modules/Subprocess.sys.mjs");
  const Subprocess = SP && SP.Subprocess;
  if (!Subprocess) throw new Error("Subprocess 不可用：MCP stdio 需在本浏览器内运行");
  const enc = new TextEncoder();
  const envObj = server.env && typeof server.env === "object" ? server.env : {};
  const base = {
    command: server.command,
    arguments: server.args || [],
    ...(server.cwd ? { workdir: server.cwd } : {}),
    environment: envObj,
    environmentAppend: true, // 继承浏览器进程环境（PATH 等），env 只作覆盖/追加
    stderr: "pipe", // 单独管道静默吞掉：污染 stdout 的协议流才是大忌，stderr 留给调试
  };
  let proc;
  try {
    proc = await Subprocess.call(base);
  } catch (e) {
    // Windows：npx/npm/uvx 等是 .cmd shim，CreateProcess 直接起不来 → cmd.exe /c 兜底。
    if (!isWindowsPlatform()) throw e;
    try {
      proc = await Subprocess.call({
        ...base,
        command: "cmd.exe",
        arguments: ["/d", "/s", "/c", server.command, ...(server.args || [])],
      });
    } catch (e2) {
      const detail = String((e2 && e2.message) || e2);
      throw new Error(`${(e && e.message) || e}（cmd.exe 兜底也失败：${detail}）`);
    }
  }
  const rpc = new MCPJsonRpc({
    name: server.name,
    send: obj => proc.stdin.write(enc.encode(JSON.stringify(obj) + "\n")),
  });
  (async () => {
    try {
      let chunk;
      while ((chunk = await proc.stdout.readString())) rpc.feed(chunk);
    } catch { /* 管道关闭 */ }
    rpc.close("server 进程已退出");
    try { proc.stderr && proc.stderr.close && proc.stderr.close(); } catch { /* ignore */ }
  })();
  return MCPClient.connect({ name: server.name, rpc, kill: () => { try { proc.kill(); } catch { /* ignore */ } }, serverCfg: server });
}

/* ───────────────────────── Streamable HTTP 传输 ───────────────────────── */

async function httpSend(server, session, obj) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    ...(server.headers && typeof server.headers === "object" ? server.headers : {}),
    ...(session.id ? { "Mcp-Session-Id": session.id } : {}),
  };
  const res = await fetch(server.url, { method: "POST", headers, body: JSON.stringify(obj) });
  if (!res.ok) throw new Error(`MCP HTTP ${res.status} ${res.statusText || ""}`);
  if (!session.id) {
    const sid = res.headers.get("mcp-session-id");
    if (sid) session.id = sid;
  }
  return res;
}

async function drainBody(res, rpc) {
  const ct = (res.headers.get("content-type") || "").toLowerCase();
  if (!res.body) return;
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  if (ct.includes("text/event-stream")) {
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line.startsWith("data:")) {
          const payload = line.slice(5).trim();
          if (payload) {
            try { rpc.feed(JSON.stringify(JSON.parse(payload))); } catch { /* 非 JSON data 帧忽略 */ }
          }
        }
      }
    }
  } else {
    const text = await res.text();
    if (text.trim()) rpc.feed(text.endsWith("\n") ? text : text + "\n");
  }
}

async function connectHttp(server) {
  if (!server.url) throw new Error("MCP http server 需要 url");
  const session = { id: "" };
  const rpc = new MCPJsonRpc({
    name: server.name,
    send: async obj => {
      const res = await httpSend(server, session, obj);
      await drainBody(res, rpc);
    },
  });
  return MCPClient.connect({ name: server.name, rpc, kill: () => rpc.close("已手动停止"), serverCfg: server });
}

/* ───────────────────────── 管理器（进浏览器/进 ToolRouter 的胶水） ───────────────────────── */

const NAME_SAFE = s => String(s || "").replace(/[^A-Za-z0-9_-]/g, "_");

export function mcpToolKey(serverName, toolName) {
  return (`mcp__${NAME_SAFE(serverName)}__${NAME_SAFE(toolName)}`).slice(0, 64);
}

export class MCPBackend {
  constructor({ config } = {}) {
    this._config = config || null;
    this._clients = new Map(); // serverKey → { server, client|Promise, lastError }
    this._lastSync = 0;
  }

  _servers() {
    return this._config && this._config.listMcpServers ? this._config.listMcpServers() : [];
  }

  _connect(server) {
    return server.transport === "http" ? connectHttp(server) : connectStdio(server);
  }

  /** 幂等连接所有 enabled server；返回 {connected, errors}。单 server 失败不影响其它。 */
  async ensureConnected(force) {
    const servers = this._servers().filter(s => s.enabled);
    const wanted = new Map(servers.map(s => [serverKey(s), s]));
    // 配置已删/关掉的 server：断开回收。
    for (const [k, rec] of this._clients) {
      if (!wanted.has(k)) {
        try { (await rec.client)?.stop(); } catch { /* ignore */ }
        this._clients.delete(k);
      }
    }
    const errors = [];
    for (const [k, server] of wanted) {
      let rec = this._clients.get(k);
      if (!rec) rec = { client: null, lastError: "" };
      if (force && rec.client) {
        try { rec.client.stop(); } catch { /* ignore */ }
        rec = { client: null, lastError: "" };
      }
      if (!rec.client || !rec.client.alive) {
        rec.client = null;
        // 失败冷却 60s：坏配置的 server 不该让每个回合都付一次 30s 超时税。
        if (rec.lastError && Date.now() - (rec.failedAt || 0) < 60000) {
          errors.push(`${server.name}: ${rec.lastError}`);
          this._clients.set(k, rec);
          continue;
        }
        try {
          rec.client = await this._connect(server);
          rec.lastError = "";
        } catch (e) {
          rec.lastError = String((e && e.message) || e);
          rec.failedAt = Date.now();
          errors.push(`${server.name}: ${rec.lastError}`);
        }
      }
      this._clients.set(k, rec);
    }
    this._lastSync = Date.now();
    return { connected: [...this._clients.values()].filter(r => r.client && r.client.alive).length, errors };
  }

  status() {
    return this._servers().map(s => {
      const rec = this._clients.get(serverKey(s));
      const alive = !!(rec && rec.client && rec.client.alive);
      return {
        name: s.name,
        transport: s.transport,
        enabled: !!s.enabled,
        connected: alive,
        toolCount: alive ? rec.client.tools.length : 0,
        error: rec ? rec.lastError : "",
      };
    });
  }

  /** 全部工具描述：[{key, description, inputSchema, server, tool}]。未连接的没有。 */
  toolDescriptors() {
    const out = [];
    for (const rec of this._clients.values()) {
      if (!rec.client || !rec.client.alive) continue;
      for (const t of rec.client.tools) {
        out.push({
          key: mcpToolKey(rec.client.name, t.name),
          server: rec.client.name,
          tool: t.name,
          description: `[MCP:${rec.client.name}] ${String(t.description || t.name)}`.slice(0, 800),
          inputSchema: t.inputSchema && typeof t.inputSchema === "object" ? t.inputSchema : { type: "object", properties: {} },
        });
      }
    }
    return out;
  }

  async callTool(key, args) {
    for (const rec of this._clients.values()) {
      const c = rec.client;
      if (!c || !c.alive) continue;
      for (const t of c.tools) {
        if (mcpToolKey(c.name, t.name) === key) return c.callTool(t.name, args);
      }
    }
    throw new Error(`MCP 工具未连接：${key}`);
  }

  /** 把 MCP 工具注册进 ToolRouter（已存在则跳过——router 是全局单例，回合间复用）。返回新增数。 */
  async syncRouter(router) {
    const r = await this.ensureConnected();
    let added = 0;
    for (const d of this.toolDescriptors()) {
      if (router.has(d.key)) continue;
      const key = d.key;
      router.register({
        name: key,
        description: d.description,
        parameters: d.inputSchema,
        handler: async (args, ctx) => this.callTool(key, args || {}, ctx),
      });
      added++;
    }
    return { ...r, added };
  }

  disposeAll() {
    for (const rec of this._clients.values()) {
      try { rec.client && rec.client.stop(); } catch { /* ignore */ }
    }
    this._clients.clear();
  }
}

function serverKey(s) {
  return `${s.name}|${s.transport}|${s.transport === "http" ? s.url : s.command}`;
}
