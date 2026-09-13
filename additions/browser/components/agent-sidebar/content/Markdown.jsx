import React from "react";

/**
 * Markdown.jsx — 轻量 Markdown 渲染器（二开 M1）。
 *
 * 只产出 React 元素、全程不碰 innerHTML：侧栏运行在 chrome 特权上下文，
 * 任何 innerHTML 注入都是攻击面，所以不用 marked/DOMPurify 这类字符串管线。
 * 支持：围栏代码块(带复制)、#~#### 标题、粗体/斜体/行内码/链接、
 * 有序/无序列表(按缩进嵌套)、表格、引用块、分隔线。
 * 流式输出友好：未闭合的 ``` 围栏把剩余内容按代码块渲染，边流边看。
 */

const INLINE_RE =
  /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(~~[^~\n]+~~)|(\[[^\]\n]+\]\([^)\s]+\))|(https?:\/\/[^\s<>"'`，。；！？)\]]+)/g;

let linkSeq = 0;

// 链接点击：面板内 <a> 会导航整个侧栏文档（特权页！），必须拦下来开新标签。
function openInTab(href, onLink) {
  try {
    if (onLink) { onLink(href); return; }
    if (typeof Services !== "undefined" && Services.appShell) {
      const w = Services.appShell.getMostRecentBrowserWindow
        ? Services.appShell.getMostRecentBrowserWindow()
        : Services.appShell.hiddenDOMWindow;
      if (w && w.gBrowser) w.gBrowser.loadOneTab(href, { relatedToCurrent: true });
      else if (w && w.openTrustedLinkIn) w.openTrustedLinkIn(href, "tab");
    } else if (typeof window !== "undefined") {
      window.open(href, "_blank");
    }
  } catch { /* 点击失败不应影响渲染 */ }
}

function renderInline(text, keyBase, onLink) {
  const out = [];
  if (!text) return out;
  // 每次调用独立 regex：共享全局 regex 的 lastIndex 会被递归调用重置，导致外层重复匹配同一 token。
  const re = new RegExp(INLINE_RE.source, "g");
  let last = 0, m, i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `${keyBase}-i${i++}`;
    const tok = m[0];
    if (m[1]) out.push(<code key={k} className="md-code">{tok.slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={k}>{renderInline(tok.slice(2, -2), k, onLink)}</strong>);
    else if (m[3]) out.push(<em key={k}>{renderInline(tok.slice(1, -1), k, onLink)}</em>);
    else if (m[4]) out.push(<del key={k}>{renderInline(tok.slice(2, -2), k, onLink)}</del>);
    else if (m[5]) {
      const lm = /^\[([^\]]*)\]\(([^)\s]+)\)$/.exec(tok);
      out.push(
        <a
          key={k}
          className="md-link"
          href="#"
          onClick={(e) => { e.preventDefault(); openInTab(lm[2], onLink); }}
          title={lm[2]}
        >{lm[1]}</a>
      );
    } else out.push(
      <a
        key={k}
        className="md-link"
        href="#"
        onClick={(e) => { e.preventDefault(); openInTab(tok, onLink); }}
        title={tok}
      >{tok}</a>
    );
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function CodeBlock({ lang, lines }) {
  const text = lines.join("\n");
  const [copied, setCopied] = React.useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch { /* 无剪贴板权限时静默 */ }
  };
  return (
    <div className="md-pre">
      <div className="md-pre-bar">
        <span className="md-pre-lang">{lang || "code"}</span>
        <button type="button" className="md-pre-copy" onClick={copy}>
          {copied ? "已复制 ✓" : "复制"}
        </button>
      </div>
      <pre className="md-pre-body"><code>{text}</code></pre>
    </div>
  );
}

// 表格：表头行 + |---| 分隔行 + 数据行
function tryTable(lines, start) {
  const splitRow = (line) =>
    line.trim().replace(/^\||\|$/g, "").split("|").map(c => c.trim());
  if (!lines[start] || !lines[start + 1]) return null;
  const sep = lines[start + 1];
  if (!/^\s*\|?[\s:|-]+\|?\s*$/.test(sep) || !sep.includes("-")) return null;
  if (!lines[start].includes("|")) return null;
  const header = splitRow(lines[start]);
  if (header.length < 2) return null;
  let i = start + 2;
  const rows = [];
  while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
    rows.push(splitRow(lines[i]));
    i++;
  }
  return { header, rows, next: i };
}

const LIST_RE = /^(\s*)([-*+]|\d+[.、)])\s+(.*)$/;
const HEAD_RE = /^(#{1,4})\s+(.*)$/;

function flushList(stack, out, keyBase) {
  // stack: [{ordered, indent, items[]}] 逐层闭合
  while (stack.length) {
    const f = stack.pop();
    const El = f.ordered ? "ol" : "ul";
    const node = (
      <El key={`${keyBase}-l${stack.length}`} className="md-list">
        {f.items.map((it, k) => <li key={k}>{it}</li>)}
      </El>
    );
    if (stack.length) stack[stack.length - 1].items.push(node);
    else out.push(node);
  }
}

export function renderMarkdown(text, onLink) {
  const out = [];
  if (!text) return out;
  const lines = String(text).split("\n");
  let i = 0, para = [], pKey = 0;
  const listStack = [];

  const flushPara = () => {
    if (!para.length) return;
    const segs = [];
    para.forEach((ln, k) => {
      if (k) segs.push(<br key={`${pKey}-br${k}`} />);
      segs.push(...renderInline(ln, `${pKey}-l${k}`, onLink));
    });
    out.push(<p key={`p${pKey++}`} className="md-p">{segs}</p>);
    para = [];
  };

  while (i < lines.length) {
    const line = lines[i];

    // 围栏代码块（含未闭合：流式时直接吃到末尾）
    const fence = /^\s*```+\s*([^\s`]*)/.exec(line);
    if (fence) {
      flushPara(); flushList(listStack, out, `f${i}`);
      const lang = fence[1];
      const body = [];
      i++;
      while (i < lines.length && !/^\s*```+\s*$/.test(lines[i])) { body.push(lines[i]); i++; }
      i++; // 跳过闭合围栏（若有）
      out.push(<CodeBlock key={`c${i}`} lang={lang} lines={body} />);
      continue;
    }

    if (!line.trim()) { flushPara(); flushList(listStack, out, `e${i}`); i++; continue; }

    const head = HEAD_RE.exec(line);
    if (head && head[1].length) {
      flushPara(); flushList(listStack, out, `h${i}`);
      const lvl = Math.min(head[1].length + 2, 6); // #→h3 起步，面板里别喧宾夺主
      const H = `h${lvl}`;
      out.push(<H key={`h${i}`} className={`md-h md-h${head[1].length}`}>{renderInline(head[2], `h${i}`, onLink)}</H>);
      i++; continue;
    }

    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      flushPara(); flushList(listStack, out, `r${i}`);
      out.push(<hr key={`hr${i}`} className="md-hr" />);
      i++; continue;
    }

    if (/^\s*>/.test(line)) {
      flushPara(); flushList(listStack, out, `q${i}`);
      const body = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) { body.push(lines[i].replace(/^\s*>\s?/, "")); i++; }
      out.push(<blockquote key={`q${i}`} className="md-quote">{body.map((ln, k) => <span key={k}>{renderInline(ln, `q${i}-${k}`, onLink)}{k < body.length - 1 && <br />}</span>)}</blockquote>);
      continue;
    }

    const tbl = tryTable(lines, i);
    if (tbl) {
      flushPara(); flushList(listStack, out, `t${i}`);
      out.push(
        <div key={`tbl${i}`} className="md-tablewrap">
          <table className="md-table">
            <thead><tr>{tbl.header.map((h, k) => <th key={k}>{renderInline(h, `t${i}h${k}`, onLink)}</th>)}</tr></thead>
            <tbody>
              {tbl.rows.map((r, ri) => (
                <tr key={ri}>{tbl.header.map((_, ci) => <td key={ci}>{renderInline(r[ci] || "", `t${i}r${ri}${ci}`, onLink)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      i = tbl.next; continue;
    }

    const li = LIST_RE.exec(line);
    if (li) {
      flushPara();
      const indent = li[1].replace(/\t/g, "  ").length;
      const ordered = /\d/.test(li[2][0]);
      while (listStack.length && indent < listStack[listStack.length - 1].indent) {
        const f = listStack.pop();
        const El = f.ordered ? "ol" : "ul";
        const node = <El key={`l-${out.length}-${listStack.length}`} className="md-list">{f.items.map((it, k) => <li key={k}>{it}</li>)}</El>;
        if (listStack.length) listStack[listStack.length - 1].items.push(node);
        else out.push(node);
      }
      if (!listStack.length || listStack[listStack.length - 1].indent !== indent
          || listStack[listStack.length - 1].ordered !== ordered) {
        listStack.push({ indent, ordered, items: [] });
      }
      // 列表项内容里允许续行（缩进更深的普通行并入当前项）
      let itemText = li[3];
      i++;
      while (i < lines.length && lines[i].trim() && !LIST_RE.test(lines[i])
             && /^\s{2,}\S/.test(lines[i]) && !HEAD_RE.test(lines[i])) {
        itemText += " " + lines[i].trim(); i++;
      }
      listStack[listStack.length - 1].items.push(renderInline(itemText, `li${i}`, onLink));
      continue;
    }

    para.push(line);
    i++;
  }
  flushPara();
  flushList(listStack, out, "end");
  return out;
}

export function Markdown({ text, onLink }) {
  return <div className="md">{renderMarkdown(text, onLink)}</div>;
}

export default Markdown;
