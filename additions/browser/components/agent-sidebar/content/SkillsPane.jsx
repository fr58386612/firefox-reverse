import React, { useEffect, useState } from "react";

/**
 * 二开 M5：技能库管理面板。
 * - 列出所有来源的 Skill（内置 / ~/.firefox-reverse/skills / 工作区目录），内置不可改；
 * - 启用/禁用（禁用后 skill_list/skill_get/自动注入都看不到它）；
 * - 用户/工作区技能可展开编辑整篇 SKILL.md、删除；
 * - 显示自动注入规则说明。
 */
export default function SkillsPane({ skill, store, workspace, onClose }) {
  const [skills, setSkills] = useState([]);
  const [roots, setRoots] = useState([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [openName, setOpenName] = useState("");
  const [editText, setEditText] = useState("");
  const [editFull, setEditFull] = useState(true);
  const [msg, setMsg] = useState("");

  const wsRoot = (workspace && workspace.getRoot && workspace.getRoot({})) || "";

  async function reload() {
    setLoading(true);
    setError("");
    try {
      const r = await skill.list({ includeDisabled: true }, { workspaceRoot: wsRoot || null });
      if (!r || !r.ok) throw new Error((r && r.error) || "读取失败");
      setSkills(r.skills || []);
      setRoots(r.roots || []);
    } catch (e) {
      setError((e && e.message) || String(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void reload();
  }, []);

  function toggle(skillName, disabled) {
    try {
      store.setSkillDisabled(skillName, disabled);
      setSkills(s => s.map(x => (x.name === skillName ? { ...x, disabled } : x)));
    } catch (e) {
      setError((e && e.message) || String(e));
    }
  }

  async function openEditor(s) {
    setMsg("");
    if (openName === s.name) {
      setOpenName("");
      return;
    }
    try {
      const parts = [];
      let offset = 0;
      for (let guard = 0; guard < 40; guard++) {
        const g = await skill.get(
          { name: s.name, offset, limit: 16000, includeDisabled: true },
          { workspaceRoot: wsRoot || null }
        );
        if (!g || !g.ok) throw new Error((g && g.error) || "读取失败");
        parts.push(g.skill || "");
        if (!g.truncated || g.nextOffset == null) break;
        offset = g.nextOffset;
      }
      const full = parts.join("");
      setEditText(full);
      setEditFull(s.source !== "builtin");
      setOpenName(s.name);
    } catch (e) {
      setError((e && e.message) || String(e));
    }
  }

  async function saveEdit() {
    setMsg("");
    try {
      const r = await skill.updateSkill({ name: openName, content: editText }, { workspaceRoot: wsRoot || null });
      setMsg(r && r.ok ? "已保存" : "保存失败：" + ((r && r.error) || "未知错误"));
      if (r && r.ok) void reload();
    } catch (e) {
      setMsg("保存失败：" + ((e && e.message) || e));
    }
  }

  async function remove(s) {
    if (!window.confirm(`删除技能“${s.name}”（移除其目录）？`)) return;
    try {
      const r = await skill.deleteSkill({ name: s.name }, { workspaceRoot: wsRoot || null });
      if (r && r.ok) {
        if (openName === s.name) setOpenName("");
        void reload();
      } else {
        setError("删除失败：" + ((r && r.error) || "未知错误"));
      }
    } catch (e) {
      setError((e && e.message) || String(e));
    }
  }

  // 二开修复：导入技能——用 nsIFilePicker 选 .md 文件或技能目录（chrome 特权文档可直接用）。
  // 注意：本 153 分支已移除同步 show()，只能用异步 open(callback)，与 AgentPanel.pickDirectory 同款。
  async function pickPath(mode, title) {
    try {
      const Cc = typeof Components !== "undefined" ? Components.classes : null;
      const Ci = typeof Components !== "undefined" ? Components.interfaces : null;
      const Sv = typeof Services !== "undefined" ? Services : null;
      if (!Cc || !Ci || !Sv) throw new Error("文件选择器不可用");
      const host =
        (window.browsingContext && window.browsingContext.topChromeWindow) ||
        Sv.wm.getMostRecentWindow("navigator:browser");
      const fp = Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);
      fp.init(
        host.browsingContext,
        title,
        mode === "dir" ? Ci.nsIFilePicker.modeGetFolder : Ci.nsIFilePicker.modeGetFile
      );
      if (mode !== "dir") fp.appendFilter("技能文件 (*.md)", "*.md;*.markdown;*.txt");
      const res = await new Promise(resolve => fp.open(resolve));
      return res === Ci.nsIFilePicker.returnOK ? fp.file.path : null;
    } catch (e) {
      setError("打开文件选择器失败：" + ((e && e.message) || e));
      return null;
    }
  }

  async function addImport(mode) {
    setError("");
    setMsg("");
    const path = await pickPath(mode, mode === "dir" ? "选择技能目录（内含 SKILL.md）" : "选择技能文件（.md）");
    if (!path) return;
    try {
      let r = await skill.importSkill({ path }, { workspaceRoot: wsRoot || null });
      if (r && r.needOverwrite && r.name && window.confirm(`技能“${r.name}”已存在，覆盖它？`)) {
        r = await skill.importSkill({ path, overwrite: true }, { workspaceRoot: wsRoot || null });
      }
      if (r && r.ok) {
        setMsg(r.note + (r.copiedResources ? `（附带 ${r.copiedResources} 个资源目录）` : ""));
        void reload();
      } else {
        setMsg("导入失败：" + ((r && r.error) || "未知错误"));
      }
    } catch (e) {
      setMsg("导入失败：" + ((e && e.message) || e));
    }
  }

  const SOURCE_LABEL = { builtin: "内置", user: "用户", workspace: "工作区" };

  return (
    <div className="settings-pane skills-pane">
      <header className="settings-pane__bar">
        <span>技能库</span>
        <span className="skills-pane__actions">
          <button type="button" className="settings-pane__btn-ghost" onClick={() => void addImport("dir")} title="导入技能文件夹（含 SKILL.md；references/assets 等资源目录一并复制）">导入技能文件夹</button>
          <button type="button" className="settings-pane__btn-ghost" onClick={() => void addImport("file")} title="便捷导入：单个 .md 文件（frontmatter 缺 name 时按文件名取名）">导入单文件</button>
        </span>
        {onClose && <button type="button" onClick={onClose} title="关闭">×</button>}
      </header>

      <p className="settings-pane__note">
        Skill 是给 Agent 的可复用方法卡。发消息时会自动按关键词匹配注入（最多 2 条）；
        任务跑通后也可以让 Agent 用 <code>save_skill</code> 把经验沉淀成新技能。
      </p>

      {loading && <div className="skills-pane__hint">读取中…</div>}
      {error && <div className="settings-pane__error">{error}</div>}
      {msg && <div className="skills-pane__hint">{msg}</div>}

      {skills.map(s => (
        <div key={s.source + "/" + s.name} className={"skills-pane__item" + (s.disabled ? " is-disabled" : "")}>
          <div className="skills-pane__row">
            {s.source !== "builtin" && (
              <label className="skills-pane__toggle" title="禁用后 Agent 看不到、也不会自动注入这条技能">
                <input
                  type="checkbox"
                  checked={!s.disabled}
                  onChange={e => toggle(s.name, !e.target.checked)}
                />
              </label>
            )}
            <button
              type="button"
              className="skills-pane__name"
              onClick={() => void openEditor(s)}
              title="查看/编辑"
            >
              {s.name}
              <span className="skills-pane__src">{SOURCE_LABEL[s.source] || s.source}</span>
            </button>
            {s.source !== "builtin" && (
              <button type="button" className="settings-pane__btn-ghost" onClick={() => void remove(s)} title="删除技能目录">
                删除
              </button>
            )}
          </div>
          {openName !== s.name && <div className="skills-pane__desc">{s.description || "（无描述）"}</div>}
          {openName === s.name && (
            <div className="skills-pane__editor">
              <textarea
                className="skills-pane__textarea"
                value={editText}
                readOnly={!editFull}
                spellCheck={false}
                onChange={e => setEditText(e.target.value)}
              />
              <div className="skills-pane__editorbar">
                {editFull ? (
                  <button type="button" onClick={() => void saveEdit()}>保存</button>
                ) : (
                  <span className="skills-pane__hint">内置技能只读</span>
                )}
                <button type="button" className="settings-pane__btn-ghost" onClick={() => setOpenName("")}>收起</button>
                {msg && <span className="skills-pane__hint">{msg}</span>}
              </div>
            </div>
          )}
        </div>
      ))}

      {!loading && !!roots.length && (
        <details className="skills-pane__roots">
          <summary>技能目录（手工放 SKILL.md 也会被发现）</summary>
          {roots.map(r => (
            <div key={r.path} className="skills-pane__rootpath">{r.path}</div>
          ))}
        </details>
      )}
    </div>
  );
}
