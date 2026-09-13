#!/usr/bin/env node
/* selftest-markdown.mjs — 二开 M1：Markdown 渲染器自测。
 * .jsx 无法被 node 直接 import，故先用 esbuild(JS API) 把渲染器 + 用例打成临时
 * ESM bundle 再动态导入。断言核心：块级/行内元素齐、链接被 href="#" 拦截、
 * HTML/script 注入不出现在输出。 */
import { createRequire } from "module";
import { fileURLToPath, pathToFileURL } from "url";
import { dirname, join } from "path";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, "x"));
const esbuild = require("esbuild");

const tmp = mkdtempSync(join(tmpdir(), "frx-md-selftest-"));
// 入口必须落在项目内：esbuild 从入口所在目录向上找 node_modules（tmp 里找不到 react）
const entry = join(here, ".selftest-md.entry.mjs");
writeFileSync(entry, `
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { renderMarkdown } from ${JSON.stringify(join(here, "..", "content", "Markdown.jsx")).replace(/\\\\/g, "/")};
export { React, renderToStaticMarkup, renderMarkdown };
`);
const out = join(tmp, "entry.bundle.cjs");
await esbuild.build({
  entryPoints: [entry], bundle: true, platform: "node", format: "cjs",
  outfile: out, loader: { ".jsx": "jsx" }, logLevel: "error",
});
try { (await import("fs")).rmSync(entry); } catch { /* Windows 偶发占用则忽略 */ }
const { React, renderToStaticMarkup, renderMarkdown } = await import(pathToFileURL(out).href);

const R = (el) => renderToStaticMarkup(el);
const md = [
  "# 结论报告", "",
  "算法在 `getSign()` 里，核心是 **MD5 + RC4**，~~旧结论~~作废。", "",
  "```js", "function sign(q){ return md5(q + SALT); }", "```", "",
  "| 参数 | 来源 |", "| --- | --- |", "| X-Bogus | a.js:120 |", "| msToken | cookie |", "",
  "- 第一步：定位 dispatcher", "  - 子项：hook ADVANCE_AND_DISPATCH", "- 第二步：补环境", "",
  "1. 有序一", "2. 有序二", "",
  "> 引用：风控返回 403", "",
  "链接 https://example.com/x 与 [文档](https://docs.example.com)", "",
  "<script>alert(1)</script> 与 <img src=x onerror=alert(2)>", "",
  "```python", "# 未闭合围栏流式",
].join("\n");

const html = R(React.createElement("div", null, renderMarkdown(md)));
const unesc = html.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#x27;/g, "'").replace(/&quot;/g, '"');
const checks = {
  "标题(h3 起步)": /<h3[^>]*>结论报告/.test(html),
  "粗体": /<strong>MD5 \+ RC4<\/strong>/.test(html),
  "删除线": /<del>旧结论<\/del>/.test(html),
  "行内码": /<code[^>]*>getSign\(\)<\/code>/.test(html),
  "围栏代码块": /function sign\(q\)/.test(html) && /md-pre-lang/.test(html),
  "复制按钮": /md-pre-copy/.test(html),
  "表格": /<table/.test(html) && /X-Bogus/.test(html) && /msToken/.test(html),
  "嵌套列表": /<ul[\s\S]*<ul[\s\S]*hook ADVANCE_AND_DISPATCH/.test(html),
  "有序列表": /<ol[\s\S]*有序二/.test(html),
  "引用块": /<blockquote/.test(html),
  "裸链接渲染": /class="md-link"/.test(html),
  "链接点击被拦为 href=#": /md-link" href="#"/.test(html),
  "无真实 <script> 标签": !/<script/i.test(html),
  "注入文本仅作为纯文本": unesc.includes("<script>alert(1)</script>") && !/<img /i.test(html),
  "未闭合围栏流式友好": /# 未闭合围栏流式/.test(html),
};
let fail = 0;
for (const [k, v] of Object.entries(checks)) {
  console.log(`${v ? "PASS" : "FAIL"} ${k}`);
  if (!v) fail++;
}
console.log(fail ? `\nmarkdown selftest: ${fail} FAILED` : "\nmarkdown selftest: ALL PASS");
process.exit(fail ? 1 : 0);
