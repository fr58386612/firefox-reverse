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

  const SOURCE_LABEL = { builtin: "内置", user: "用户", workspace: "工作区" };

  return (
    <div className="settings-pane skills-pane">
      <header className="settings-pane__bar">
        <span>技能库</span>
        {onClose && <button type="button" onClick={onClose} title="关闭">×</button>}
      </header>

      <p className="settings-pane__note">
        Skill 是给 Agent 的可复用方法卡。发消息时会自动按关键词匹配注入（最多 2 条）；
        任务跑通后也可以让 Agent 用 <code>save_skill</code> 把经验沉淀成新技能。
      </p>

      {loading && <div className="skills-pane__hint">读取中…</div>}
      {error && <div className="settings-pane__error">{error}</div>}

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
