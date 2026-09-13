/* SkillBackend.sys.mjs — 通用 SkillRegistry。
 *
 * 来源（后者同名覆盖前者）：
 * 1. 浏览器内置 reverse-engineering Skill；
 * 2. ~/.firefox-reverse/skills/<name>/SKILL.md；
 * 3. <工作目录>/.agents/skills/<name>/SKILL.md；
 * 4. <工作目录>/.firefox-reverse/skills/<name>/SKILL.md。
 *
 * 兼容：skill_get 不传 name 时仍返回原来的内置逆向方法论，并释放模板。
 */

const BUILTIN_NAME = "reverse-engineering";
const BUILTIN_URL = "chrome://browser/content/agent-sidebar/skill-reverse.md";
const MAX_SKILL_CHARS = 1024 * 1024;
const MAX_RESOURCE_CHARS = 2 * 1024 * 1024;
const TEMPLATES = [
  "node-env-loader.js",
  "wasm-signer-loader.js",
  "request-template.js",
  "webpack-chunk-loader.js",
  "jsvmp-const-harvest.js",
  "wasm-call-logger.js",
];

function stripQuotes(value) {
  const s = String(value || "").trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

/** 只解析 Agent Skills 发现所需的 name/description，正文保持原样交给模型。 */
export function parseSkillFrontmatter(text) {
  const src = String(text || "").replace(/^\uFEFF/, "");
  if (!src.startsWith("---\n") && !src.startsWith("---\r\n")) {
    return { name: "", description: "", body: src };
  }
  const match = src.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) {
    return { name: "", description: "", body: src };
  }
  const lines = match[1].split(/\r?\n/);
  const meta = {};
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let value = m[2];
    if (value === "|" || value === ">") {
      const folded = value === ">";
      const parts = [];
      while (i + 1 < lines.length && /^\s+/.test(lines[i + 1])) {
        parts.push(lines[++i].trim());
      }
      value = parts.join(folded ? " " : "\n");
    }
    meta[key] = stripQuotes(value);
  }
  return {
    name: String(meta.name || "").trim(),
    description: String(meta.description || "").trim().slice(0, 500),
    body: src.slice(match[0].length),
  };
}

function validSkillName(name) {
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(String(name || ""));
}

function safeRelativePath(value) {
  const raw = String(value || "").replace(/\\/g, "/").trim();
  const parts = raw.split("/").filter(Boolean);
  if (!raw || raw.startsWith("/") || /^[A-Za-z]:\//.test(raw) || parts.some(p => p === "." || p === "..")) {
    throw new Error("resource path 必须是 Skill 目录内的安全相对路径");
  }
  return parts;
}

function chunkText(text, params = {}) {
  const hasRange = params.offset != null || params.limit != null;
  if (!hasRange) return { text, totalChars: text.length, offset: 0, nextOffset: null, truncated: false };
  const offset = Math.max(0, Math.floor(Number(params.offset) || 0));
  const limit = Math.min(16000, Math.max(1, Math.floor(Number(params.limit) || 12000)));
  const value = text.slice(offset, offset + limit);
  const nextOffset = offset + value.length < text.length ? offset + value.length : null;
  return { text: value, totalChars: text.length, offset, nextOffset, truncated: nextOffset != null };
}

function pathInside(root, candidate) {
  const normalize = value => {
    let p = String(value || "").replace(/[\\/]+/g, "/").replace(/\/$/, "");
    if (/^[A-Za-z]:\//.test(p)) p = p.toLowerCase();
    return p;
  };
  const r = normalize(root);
  const c = normalize(candidate);
  return c === r || c.startsWith(r + "/");
}

export class SkillRegistry {
  constructor({ workspace, isDisabled } = {}) {
    this._builtinCache = null;
    this._workspace = workspace || null;
    // 二开 M5：禁用集由外部（ConfigStore）注入、每次现取——SkillsPane 改开关即时生效。
    this._isDisabled = typeof isDisabled === "function" ? isDisabled : () => new Set();
  }

  _disabledSet() {
    try {
      return this._isDisabled() instanceof Set ? this._isDisabled() : new Set(this._isDisabled() || []);
    } catch {
      return new Set();
    }
  }

  async _readChrome(url) {
    const { NetUtil } = ChromeUtils.importESModule("resource://gre/modules/NetUtil.sys.mjs");
    return new Promise((resolve, reject) => {
      try {
        NetUtil.asyncFetch({ uri: url, loadUsingSystemPrincipal: true }, (inputStream, status) => {
          if (!Components.isSuccessCode(status)) {
            reject(new Error("读资源失败 status=" + status + " " + url));
            return;
          }
          try {
            resolve(NetUtil.readInputStreamToString(inputStream, inputStream.available(), { charset: "UTF-8" }));
          } catch (e) {
            reject(e);
          }
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  _homeDir() {
    try {
      return Services.env.get("HOME") || Services.env.get("USERPROFILE") || PathUtils.homeDir || "";
    } catch {
      try {
        return PathUtils.homeDir || "";
      } catch {
        return "";
      }
    }
  }

  _workspaceRoot(ctx) {
    return (
      (ctx && ctx.workspaceRoot) ||
      (this._workspace && this._workspace.getRoot && this._workspace.getRoot(ctx)) ||
      ""
    );
  }

  _roots(ctx) {
    const roots = [];
    const home = this._homeDir();
    if (home) roots.push({ source: "user", root: PathUtils.join(home, ".firefox-reverse", "skills") });
    const workspace = this._workspaceRoot(ctx);
    if (workspace) {
      roots.push({ source: "workspace", root: PathUtils.join(workspace, ".agents", "skills") });
      roots.push({ source: "workspace", root: PathUtils.join(workspace, ".firefox-reverse", "skills") });
    }
    return roots;
  }

  async _readLocal(path, maxChars) {
    const st = await IOUtils.stat(path);
    if (st.type !== "regular") throw new Error("不是普通文件: " + path);
    if (st.size > maxChars) throw new Error(`文件超过限制（${Math.floor(maxChars / 1024)}KB）`);
    return IOUtils.readUTF8(path);
  }

  // FF153：IOUtils/PathUtils 已改为 WebIDL C++ 实现——没有 readDirectory/copyTree/baseName/realPath，
  // 且对 Windows junction（装入点）直接 stat 可能抛「不存在」。目录探测统一走双通道：
  // stat 不成就试 getChildren（junction 不可 stat 但可枚举）；SKILL.md 等路径下的文件可正常 stat。
  async _listDir(dir) {
    const kids = await IOUtils.getChildren(dir);
    const out = [];
    for (const p of kids) {
      let type = "other";
      try {
        type = (await IOUtils.stat(p)).type;
      } catch {
        /* stat 不动（如子 junction）按 other 处理 */
      }
      out.push({ name: PathUtils.filename(p), path: p, type });
    }
    return out;
  }

  // 返回 {kind:"file"} | {kind:"dir",entries} | {kind:null,statErr}
  async _probePath(p) {
    let statErr = null;
    try {
      const st = await IOUtils.stat(p);
      if (st.type === "regular") return { kind: "file" };
    } catch (e) {
      statErr = e;
    }
    try {
      return { kind: "dir", entries: await this._listDir(p) };
    } catch {
      return { kind: null, statErr };
    }
  }

  async _scanRoot(entry) {
    let children;
    try {
      children = await IOUtils.getChildren(entry.root);
    } catch {
      return [];
    }
    const found = [];
    let realRoot = null;
    if (typeof IOUtils.realPath === "function") {
      try { realRoot = await IOUtils.realPath(entry.root); } catch { return []; }
    }
    for (const dir of children.slice(0, 200)) {
      try {
        let statType = "unknown";
        try {
          statType = (await IOUtils.stat(dir)).type;
        } catch { /* junction 装入点 stat 可能抛错：继续按目录试（读 SKILL.md 会裁决） */ }
        // 只有明确是普通文件才排除；junction 的 type 可能是 "other"/抛错，不能据此拒绝
        if (statType === "regular") continue;
        if (realRoot) {
          const realDir = await IOUtils.realPath(dir);
          if (!pathInside(realRoot, realDir)) continue;
        }
        const skillPath = PathUtils.join(dir, "SKILL.md");
        if (typeof IOUtils.realPath === "function") {
          const [realDir, realSkill] = await Promise.all([IOUtils.realPath(dir), IOUtils.realPath(skillPath)]);
          if (!pathInside(realDir, realSkill)) continue;
        }
        const text = await this._readLocal(skillPath, MAX_SKILL_CHARS);
        const meta = parseSkillFrontmatter(text);
        const folderName = PathUtils.filename(dir);
        const name = meta.name || folderName;
        if (!validSkillName(name)) continue;
        found.push({
          name,
          description: meta.description || `本地 Skill：${name}`,
          source: entry.source,
          root: dir,
          path: skillPath,
        });
      } catch {
        /* 单个 Skill 损坏不影响其它条目 */
      }
    }
    return found;
  }

  async _catalog(ctx, { includeDisabled = false } = {}) {
    const map = new Map();
    map.set(BUILTIN_NAME, {
      name: BUILTIN_NAME,
      description: "Firefox Reverse 内置的 JS 逆向、签名定位、补环境与实打验证方法论",
      source: "builtin",
      url: BUILTIN_URL,
    });
    if (typeof IOUtils !== "undefined" && typeof PathUtils !== "undefined") {
      for (const root of this._roots(ctx)) {
        for (const skill of await this._scanRoot(root)) {
          map.set(skill.name, skill);
        }
      }
    }
    const disabled = this._disabledSet();
    return [...map.values()].filter(s => {
      const off = s.source !== "builtin" && disabled.has(s.name);
      s.disabled = off;
      return includeDisabled || !off;
    });
  }

  async list(_params = {}, ctx = {}) {
    try {
      const skills = await this._catalog(ctx, { includeDisabled: !!_params.includeDisabled });
      return {
        ok: true,
        count: skills.length,
        skills: skills.map(({ root, path, url, ...s }) => s),
        roots:
          typeof PathUtils !== "undefined"
            ? this._roots(ctx).map(x => ({ source: x.source, path: x.root }))
            : [],
      };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  async _readBuiltin() {
    if (!this._builtinCache) this._builtinCache = await this._readChrome(BUILTIN_URL);
    return this._builtinCache;
  }

  async _releaseTemplates(ctx) {
    const root = this._workspaceRoot(ctx);
    if (!root) return [];
    const dir = PathUtils.join(root, ".agent-tools", "templates");
    await IOUtils.makeDirectory(dir, { ignoreExisting: true, createAncestors: true });
    const rels = [];
    for (const name of TEMPLATES) {
      const dest = PathUtils.join(dir, name);
      const rel = ".agent-tools/templates/" + name;
      rels.push(rel);
      try {
        if ((await IOUtils.stat(dest)).size > 0) continue;
      } catch {}
      try {
        const text = await this._readChrome("chrome://browser/content/agent-sidebar/templates/" + name);
        await IOUtils.writeUTF8(dest, text);
      } catch {
        /* 单个模板失败不影响 Skill 正文 */
      }
    }
    return rels;
  }

  async _listResources(root, dir = root, prefix = "", depth = 0, out = []) {
    if (depth > 3 || out.length >= 100) return out;
    let children = [];
    try {
      children = await IOUtils.getChildren(dir);
    } catch {
      return out;
    }
    for (const child of children) {
      if (out.length >= 100) break;
      const name = PathUtils.filename(child);
      if (!prefix && name === "SKILL.md") continue;
      try {
        if (typeof IOUtils.realPath === "function") {
          const [realRoot, realChild] = await Promise.all([IOUtils.realPath(root), IOUtils.realPath(child)]);
          if (!pathInside(realRoot, realChild)) continue;
        }
        const st = await IOUtils.stat(child);
        const rel = prefix ? prefix + "/" + name : name;
        if (st.type === "directory") await this._listResources(root, child, rel, depth + 1, out);
        else if (st.type === "regular") out.push(rel);
      } catch {}
    }
    return out;
  }

  /** 无 name 时兼容旧 skill_get；传 name 时读取任意已发现的 Skill。 */
  async get(params = {}, ctx = {}) {
    try {
      const legacyDefault = !params.name;
      let name = String(params.name || BUILTIN_NAME).trim();
      const builtinAlias = ["reverse", "skill-reverse", "builtin"].includes(name);
      if (builtinAlias) name = BUILTIN_NAME;
      const catalog = await this._catalog(ctx, { includeDisabled: true });
      // 无参数是公开兼容契约：即使本地存在同名 Skill，也必须返回原内置方法论。
      const descriptor = legacyDefault || builtinAlias
        ? {
            name: BUILTIN_NAME,
            description: "Firefox Reverse 内置的 JS 逆向、签名定位、补环境与实打验证方法论",
            source: "builtin",
            url: BUILTIN_URL,
          }
        : catalog.find(s => s.name === name);
      if (!descriptor) {
        return { ok: false, error: `未找到 Skill "${name}"；先调用 skill_list 查看可用名称` };
      }
      if (descriptor.disabled && !params.includeDisabled) {
        return { ok: false, error: `Skill "${name}" 已被用户在技能面板禁用；需要时先到侧边栏「技能」里启用` };
      }
      if (descriptor.source === "builtin") {
        const fullSkill = await this._readBuiltin();
        const chunk = chunkText(fullSkill, params);
        let templates = [];
        try { templates = await this._releaseTemplates(ctx); } catch {}
        return {
          ok: true,
          name: descriptor.name,
          description: descriptor.description,
          source: descriptor.source,
          skill: chunk.text,
          totalChars: chunk.totalChars,
          offset: chunk.offset,
          nextOffset: chunk.nextOffset,
          truncated: chunk.truncated,
          templates,
          resources: [],
          note: templates.length
            ? `已释放脚手架：${templates.join("、")}`
            : "设置工作目录后再次读取，可自动释放逆向脚手架。",
        };
      }
      const fullSkill = await this._readLocal(descriptor.path, MAX_SKILL_CHARS);
      const chunk = chunkText(fullSkill, params);
      return {
        ok: true,
        name: descriptor.name,
        description: descriptor.description,
        source: descriptor.source,
        skill: chunk.text,
        totalChars: chunk.totalChars,
        offset: chunk.offset,
        nextOffset: chunk.nextOffset,
        truncated: chunk.truncated,
        resources: await this._listResources(descriptor.root),
      };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  async readResource(params = {}, ctx = {}) {
    try {
      const name = String(params.name || "").trim();
      const parts = safeRelativePath(params.path);
      const descriptor = (await this._catalog(ctx)).find(s => s.name === name);
      if (!descriptor) throw new Error(`未找到 Skill "${name}"`);
      if (descriptor.source === "builtin") throw new Error("内置 Skill 没有可直接读取的附加资源");
      const path = PathUtils.join(descriptor.root, ...parts);

      // 支持时用真实路径再校验一次，阻止目录内符号链接逃逸到 Skill 根之外。
      if (typeof IOUtils.realPath === "function") {
        const [realRoot, realPath] = await Promise.all([IOUtils.realPath(descriptor.root), IOUtils.realPath(path)]);
        if (!pathInside(realRoot, realPath)) throw new Error("资源路径越过 Skill 目录");
      }
      const fullContent = await this._readLocal(path, MAX_RESOURCE_CHARS);
      const chunk = chunkText(fullContent, params);
      return {
        ok: true,
        name,
        path: parts.join("/"),
        content: chunk.text,
        totalChars: chunk.totalChars,
        offset: chunk.offset,
        nextOffset: chunk.nextOffset,
        truncated: chunk.truncated,
      };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  /* ───────────── 二开 M5：技能沉淀 / 管理 / 按任务匹配 ───────────── */

  /** 把一轮经验写成 ~/.firefox-reverse/skills/<name>/SKILL.md（save_skill 工具的后端）。 */
  async saveSkill(params = {}, ctx = {}) {
    try {
      if (typeof IOUtils === "undefined" || typeof PathUtils === "undefined") {
        return { ok: false, error: "保存 Skill 需要浏览器环境（IOUtils 不可用）" };
      }
      const name = String(params.name || "").trim().toLowerCase();
      if (!validSkillName(name)) {
        return { ok: false, error: "名称需为 1-64 位小写字母/数字/连字符（如 sign-audit-flow）" };
      }
      const description = String(params.description || "").replace(/\s+/g, " ").trim().slice(0, 500);
      let content = String(params.content || "").replace(/^\uFEFF/, "");
      if (!content.trim()) return { ok: false, error: "content 正文不能为空" };
      if (content.length > MAX_SKILL_CHARS) return { ok: false, error: `正文超过 ${Math.floor(MAX_SKILL_CHARS / 1024)}KB` };
      const home = this._homeDir();
      if (!home) return { ok: false, error: "无法定位用户主目录" };
      const dir = PathUtils.join(home, ".firefox-reverse", "skills", name);
      const skillPath = PathUtils.join(dir, "SKILL.md");
      let exists = false;
      try { exists = (await IOUtils.stat(skillPath)).type === "regular"; } catch { /* fresh */ }
      if (exists && !params.overwrite) {
        return { ok: false, error: `Skill "${name}" 已存在；确认覆盖请传 overwrite:true` };
      }
      // 正文自带 frontmatter 就不重复包；否则按 name/description 自动补一份。
      const hasFront = /^---\r?\n/.test(content);
      const text = hasFront
        ? content
        : `---\nname: ${name}\ndescription: ${description || `沉淀技能：${name}`}\n---\n\n${content.trim()}\n`;
      await IOUtils.makeDirectory(dir, { ignoreExisting: true, createAncestors: true });
      await IOUtils.writeUTF8(skillPath, text);
      return {
        ok: true,
        name,
        description: description || `沉淀技能：${name}`,
        path: skillPath,
        chars: text.length,
        note: exists ? "已覆盖旧版" : `已保存；skill_list 可见，任务匹配时还会自动注入（SkillsPane 可管理）`,
      };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  /**
   * 二开修复：从本地导入技能——SkillsPane「导入」按钮的后端。
   * @param {string} params.path  .md 文件绝对路径，或包含 SKILL.md 的目录（技能包）
   * @param {boolean} params.overwrite 同名已存在时是否覆盖
   * 名称优先级：frontmatter.name → 文件名/目录名（小写、空格转连字符、去非法字符）。
   * 目录导入会把 SKILL.md 以外的同级文件/子目录（references/assets 等）一并复制，
   * skill_read_resource 对导入技能继续可用。
   */
  async importSkill(params = {}, ctx = {}) {
    try {
      if (typeof IOUtils === "undefined" || typeof PathUtils === "undefined") {
        return { ok: false, error: "导入 Skill 需要浏览器环境（IOUtils 不可用）" };
      }
      const raw = String(params.path || "")
        .trim()
        .replace(/^file:\/\/([a-zA-Z]:)?/i, "$1")
        .replace(/[\\/]+$/, "");
      if (!raw) return { ok: false, error: "path 不能为空" };
      const probed = await this._probePath(raw);
      if (!probed.kind) {
        const why = probed.statErr ? `（${(probed.statErr && probed.statErr.message) || probed.statErr}）` : "";
        return { ok: false, error: `路径不可读：不存在或无权限：${raw}${why}` };
      }
      let srcPath = raw;
      let fallbackName;
      let srcDir = null;
      if (probed.kind === "dir") {
        srcDir = raw;
        const skillMd = PathUtils.join(srcDir, "SKILL.md");
        let direct = false;
        try {
          await IOUtils.stat(skillMd);
          direct = true;
        } catch { /* 顶层没有 SKILL.md，往下看子目录 */ }
        if (direct) {
          srcPath = skillMd;
        } else {
          // 选到技能包的父目录：恰好只有一个子目录含 SKILL.md → 下钻进那个子目录
          const withSkill = [];
          for (const e of probed.entries) {
            if (e.type === "regular" || e.name.startsWith(".")) continue;
            try { await IOUtils.stat(PathUtils.join(e.path, "SKILL.md")); withSkill.push(e.name); } catch { /* 不是技能目录 */ }
          }
          if (withSkill.length === 1) {
            srcDir = PathUtils.join(srcDir, withSkill[0]);
            srcPath = PathUtils.join(srcDir, "SKILL.md");
          } else {
            const mds = probed.entries.filter(e => e.type === "regular" && /\.md$/i.test(e.name));
            if (!mds.length) return { ok: false, error: "目录里没有 SKILL.md（也没找到唯一的含 SKILL.md 子目录或其它 .md 文件）" };
            srcPath = mds[0].path;
            fallbackName = mds[0].name.replace(/\.md$/i, "");
          }
        }
        if (!fallbackName) fallbackName = PathUtils.filename(srcDir);
      } else {
        fallbackName = PathUtils.filename(raw).replace(/\.(md|markdown|txt)$/i, "");
      }
      let text;
      try {
        text = (await IOUtils.readUTF8(srcPath)).replace(/^\uFEFF/, "");
      } catch (e) {
        return { ok: false, error: `读取失败：${(e && e.message) || e}` };
      }
      if (!text.trim()) return { ok: false, error: "文件内容为空" };
      if (text.length > MAX_SKILL_CHARS) {
        return { ok: false, error: `正文超过 ${Math.floor(MAX_SKILL_CHARS / 1024)}KB` };
      }
      const fm = parseSkillFrontmatter(text);
      let name = String(fm.name || "").trim().toLowerCase().replace(/\s+/g, "-");
      if (!validSkillName(name)) {
        name = String(fallbackName || "")
          .trim()
          .toLowerCase()
          .replace(/[\s_]+/g, "-")
          .replace(/[^a-z0-9-]/g, "")
          .replace(/^-+|-+$/g, "")
          .slice(0, 64);
      }
      if (!validSkillName(name)) {
        return { ok: false, error: "无法得出合法技能名（需小写字母/数字/连字符）；请在 SKILL.md frontmatter 里写 name: 后重试" };
      }
      const description = fm.description || `导入技能：${name}`;
      const home = this._homeDir();
      if (!home) return { ok: false, error: "无法定位用户主目录" };
      const dir = PathUtils.join(home, ".firefox-reverse", "skills", name);
      const skillPath = PathUtils.join(dir, "SKILL.md");
      let exists = false;
      try { exists = (await IOUtils.stat(skillPath)).type === "regular"; } catch { /* fresh */ }
      if (exists && !params.overwrite) {
        return { ok: false, error: `Skill "${name}" 已存在；确认覆盖请再点一次导入`, needOverwrite: true, name };
      }
      await IOUtils.makeDirectory(dir, { ignoreExisting: true, createAncestors: true });
      // 目录导入：先整包复制同级资源（references/assets/scripts…），SKILL.md 随后写覆盖版正文。
      let copiedResources = 0;
      if (srcDir && srcDir !== dir) {
        try {
          for (const e of await this._listDir(srcDir)) {
            if (e.name === "SKILL.md" || e.name.startsWith(".")) continue;
            const dest = PathUtils.join(dir, e.name);
            try { await IOUtils.remove(dest, { recursive: true }); } catch { /* fresh */ }
            try {
              // 目录（含 junction，stat 可能给 other/抛错）递归整树；普通文件直接复制
              await IOUtils.copy(e.path, dest, e.type === "regular" ? {} : { recursive: true });
              copiedResources++;
            } catch { /* 单个资源复制不动就跳过，不阻断 */ }
          }
        } catch { /* 资源复制是增强项，失败不阻断导入 */ }
      }
      // 无 frontmatter 的裸 md 自动补一份；frontmatter 的 name 若非法（大写/中文等，
      // 目录扫描会整条跳过该技能）只改写 name 行，其余字段（license 等）原样保留。
      let outText = text;
      if (!/^---\r?\n/.test(text)) {
        outText = `---\nname: ${name}\ndescription: ${description}\n---\n\n${text.trim()}\n`;
      } else if (!validSkillName(String(fm.name || "").trim())) {
        const m = outText.match(/^(---\r?\n)([\s\S]*?)(\r?\n---\r?\n?)/);
        if (m) {
          const hasName = /^name:[ \t]*.*$/m.test(m[2]);
          const block = hasName ? m[2].replace(/^name:[ \t]*.*$/m, `name: ${name}`) : `name: ${name}\n${m[2]}`;
          outText = m[1] + block + m[3];
        }
      }
      await IOUtils.writeUTF8(skillPath, outText);
      return {
        ok: true,
        name,
        description,
        path: skillPath,
        chars: outText.length,
        copiedResources,
        note: exists ? `已覆盖旧版 "${name}"` : `已导入 "${name}"；skill_list 可见，任务匹配时自动注入`,
      };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  /** SkillsPane 编辑保存：整文覆盖写回原 SKILL.md（内置不可编辑；工作区 skill 允许改）。 */
  async updateSkill(params = {}, ctx = {}) {
    try {
      if (typeof IOUtils === "undefined") return { ok: false, error: "需要浏览器环境" };
      const name = String(params.name || "").trim();
      const text = String(params.content || "");
      if (!text.trim()) return { ok: false, error: "content 不能为空" };
      if (text.length > MAX_SKILL_CHARS) return { ok: false, error: "正文过大" };
      const d = (await this._catalog(ctx, { includeDisabled: true })).find(s => s.name === name);
      if (!d) return { ok: false, error: `未找到 Skill "${name}"` };
      if (d.source === "builtin") return { ok: false, error: "内置 Skill 不可编辑" };
      await IOUtils.writeUTF8(d.path, text);
      return { ok: true, name, path: d.path, chars: text.length };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  /** SkillsPane 删除：移除整个 skill 目录（仅限本地目录发现的可写 skill）。 */
  async deleteSkill(params = {}, ctx = {}) {
    try {
      if (typeof IOUtils === "undefined" || typeof PathUtils === "undefined") return { ok: false, error: "需要浏览器环境" };
      const name = String(params.name || "").trim();
      const d = (await this._catalog(ctx, { includeDisabled: true })).find(s => s.name === name);
      if (!d) return { ok: false, error: `未找到 Skill "${name}"` };
      if (d.source === "builtin") return { ok: false, error: "内置 Skill 不可删除" };
      await IOUtils.remove(d.root, { recursive: true });
      return { ok: true, name, removed: d.root };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  /**
   * 按任务文本挑最相关的用户技能（内置方法论除外——它由 skill_get 手动取，避免每轮轰炸上下文）。
   * 打分：名字（含按 - 拆的词）出现 +3/+1；description 里的短语（≥2 字）逐条命中 +2。
   * 阈值 2 分、最多返回 3 个。宁可漏注入不误注入：漏了模型还能自己 skill_list。
   */
  async matchTask(params = {}, ctx = {}) {
    try {
      const task = String(params.text || "").toLowerCase();
      if (task.length < 4) return { ok: true, matches: [] };
      const skills = (await this._catalog(ctx)).filter(s => s.source !== "builtin");
      const scored = [];
      for (const s of skills) {
        let score = 0;
        const name = s.name.toLowerCase();
        if (name.length >= 3 && task.includes(name)) score += 3;
        for (const w of name.split("-").filter(x => x.length >= 3)) {
          if (task.includes(w)) score += 1;
        }
        const phrases = String(s.description || "")
          .toLowerCase()
          .split(/[\s,，。.;；、/()（）\[\]|-]+/)
          .filter(p => p.length >= 2);
        for (const p of phrases) {
          if (task.includes(p)) score += 2;
        }
        if (score >= 2) scored.push({ name: s.name, description: s.description, source: s.source, score });
      }
      scored.sort((a, b) => b.score - a.score);
      return { ok: true, matches: scored.slice(0, 3) };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e), matches: [] };
    }
  }
}

/** 旧类名保留，避免 Backends/外部补丁导入路径失效。 */
export class SkillBackend extends SkillRegistry {}
