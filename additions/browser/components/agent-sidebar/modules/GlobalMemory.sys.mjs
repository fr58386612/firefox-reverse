/* GlobalMemory.sys.mjs — 二开 M7：profile 级全局记忆（跨任务/跨站点/跨会话）。
 *
 * 与另外三层「记忆」的分工（各有归属，别混存）：
 *   notes   按站点的逆向经验（<工作目录>/.frx-notes.ndjson）
 *   ledger  按任务(工作目录)的账本：已确认事实/已否决死路（remember/recall）
 *   skill   方法论文档（按需读取）
 *   memory  **本模块**：用户偏好 / 协作规则 / 项目长期约定 / 跨任务可复用教训。
 *           引擎每轮把 summarizeForPrompt() 的紧凑块并进货栈注入位
 *           （AgentSession.getLedger → AgentLoop._runtimeContext，压缩后同样刷新），
 *           整块有字符预算，防记忆增多挤爆上下文。
 * 存储：<profile>/firefox-reverse-agent/global-memory.json（与 conversations.json 同目录同套路；
 *      Node 自测注入 filePath 或全局 IOUtils/PathUtils 即可跑）。
 */

const KINDS = ["user", "feedback", "project", "reference", "note"];
const MAX_ENTRIES = 120;

export class GlobalMemoryBackend {
  /** @param {{filePath?:string}} [opts] 自测/高级用法：指定 JSON 路径；默认落 profile 目录 */
  constructor({ filePath } = {}) {
    this._filePath = filePath || null;
  }

  get available() {
    return typeof IOUtils !== "undefined" && typeof PathUtils !== "undefined";
  }

  _path() {
    if (this._filePath) return this._filePath;
    const dir = PathUtils.join(PathUtils.profileDir, "firefox-reverse-agent");
    return PathUtils.join(dir, "global-memory.json");
  }

  _missing(e) {
    const s = String((e && (e.name || "")) + " " + ((e && e.message) || e || ""));
    return /not exist|NoSuchFile|ENOENT|not found/i.test(s);
  }

  async _load() {
    if (!this.available) throw new Error("GlobalMemory 需要 IOUtils/PathUtils（浏览器环境或自测 shim）");
    try {
      const parsed = JSON.parse(await IOUtils.readUTF8(this._path()));
      return Array.isArray(parsed.entries) ? parsed.entries : [];
    } catch (e) {
      if (this._missing(e)) return [];
      throw e;
    }
  }

  async _save(entries) {
    const p = this._path();
    try {
      await IOUtils.makeDirectory(PathUtils.parent(p), { ignoreExisting: true });
    } catch { /* 目录已存在/已建好 */ }
    await IOUtils.writeUTF8(p, JSON.stringify({ version: 1, entries }, null, 1));
  }

  /** 新增/更新（同名=更新，name 是短标题唯一键）。kind=user偏好|feedback协作规则|project约定|reference参考|note其他。 */
  async save({ name, body, kind = "note", description = "" } = {}) {
    const n = String(name || "").replace(/\s+/g, " ").trim().slice(0, 80);
    const t = String(body || "").trim();
    if (!n) throw new Error("memory_save: name 必填（短标题，如「回复语言偏好」）");
    if (!t) throw new Error("memory_save: body 必填（要记住的内容）");
    const k = KINDS.includes(kind) ? kind : "note";
    const entries = await this._load();
    const now = Date.now();
    const i = entries.findIndex(e => String(e.name).toLowerCase() === n.toLowerCase());
    let entry;
    let updated = false;
    if (i >= 0) {
      entry = {
        ...entries[i],
        kind: k,
        body: t.slice(0, 4000),
        description: String(description || entries[i].description || "").slice(0, 200),
        updatedAt: now,
      };
      entries[i] = entry;
      updated = true;
    } else {
      if (entries.length >= MAX_ENTRIES) {
        throw new Error(`memory_save: 全局记忆已达 ${MAX_ENTRIES} 条上限，先用 memory_delete 清理过时的`);
      }
      entry = {
        id: `m_${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        name: n,
        kind: k,
        body: t.slice(0, 4000),
        description: String(description || "").slice(0, 200),
        createdAt: now,
        updatedAt: now,
      };
      entries.push(entry);
    }
    await this._save(entries);
    return { ok: true, saved: entry, updated, total: entries.length };
  }

  /** 列全局记忆（默认最近 100 条，按更新时间倒序）。query=名称/描述/正文子串过滤。 */
  async list({ query = "", kind = "", limit = 100 } = {}) {
    const q = String(query || "").toLowerCase();
    const kd = String(kind || "");
    let entries = await this._load();
    entries = entries
      .filter(e => (!kd || e.kind === kd) && (!q || `${e.name} ${e.description} ${e.body}`.toLowerCase().includes(q)))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .slice(0, Math.max(1, Math.min(200, Number(limit) || 100)));
    return { ok: true, count: entries.length, memories: entries };
  }

  /** 按短标题删除（大小写不敏感）。 */
  async remove({ name } = {}) {
    const n = String(name || "").trim().toLowerCase();
    if (!n) throw new Error("memory_delete: name 必填");
    const entries = await this._load();
    const kept = entries.filter(e => String(e.name).toLowerCase() !== n);
    const removed = entries.length - kept.length;
    if (removed) await this._save(kept);
    return { ok: true, removed, total: kept.length };
  }

  /** 生成每轮注入的紧凑全局记忆块；无记忆/取失败 → ""（注入侧对空串直接跳过）。 */
  async summarizeForPrompt({ maxChars = 1800, maxBody = 160 } = {}) {
    let entries;
    try {
      entries = await this._load();
    } catch {
      return "";
    }
    if (!entries.length) return "";
    entries.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    const lines = [];
    let used = 0;
    let skipped = 0;
    for (const e of entries) {
      const body = String(e.body || "").replace(/\s+/g, " ");
      const line = `· [${e.kind || "note"}] ${e.name}: ${body.length > maxBody ? body.slice(0, maxBody) + "…" : body}`;
      if (used + line.length + 1 > maxChars) {
        skipped++;
        continue;
      }
      used += line.length + 1;
      lines.push(line);
    }
    const head =
      "【全局记忆】跨会话沉淀的长期信息（用户偏好与协作规则**必须遵守**；其余可能随时间过时，用前先验证）：\n";
    const tail = skipped
      ? `\n（另有 ${skipped} 条更旧记忆未展示，完整见 memory_list）`
      : "\n（完整列表 memory_list；过时条目 memory_delete 清理。）";
    return head + lines.join("\n") + tail;
  }
}
