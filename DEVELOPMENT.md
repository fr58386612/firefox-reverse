# 二次开发（二开）指南 —— Windows 本地开发环境

> 本仓库是 Firefox 的「补丁集」，不含上游源码。二开 = 改 `additions/`、`patches/`、
> `scripts/`、`settings/`，再用 `upstream/`（浅克隆 + 打过补丁的 Firefox 153.0a1）验证/编译。
> 上游锁定的 commit 在 `scripts/bootstrap.sh` 的 `UPSTREAM_REF`（当前 `cebc55aab4…`）。

## 1. 目录与模块地图

```
firefox-reverse/
├─ upstream/          # 浅克隆的 Firefox 153.0a1 + 已应用补丁（gitignored，构建时生成）
├─ patches/           # 对上游已有文件的修改（git format-patch 格式，按模块分目录）
│   ├─ agent-ui/      # 侧栏注册 / 启动器置顶 / locale 打包（3 个 .patch，核心入口）
│   ├─ branding/      # unofficial 品牌替换
│   └─ <module>/      # 其余模块当前无 .patch，接入点走 additions + apply-fingerprint-config.py
├─ additions/         # 纯新增文件（rsync 覆盖进 upstream/）
│   ├─ browser/components/agent-sidebar/   # ★ Agent 侧栏：React UI + .sys.mjs 引擎模块 + 68 工具
│   │   ├─ content/       # React 源文件（*.jsx）+ esbuild 产物 agent-sidebar.bundle.js
│   │   ├─ modules/       # 父进程后端：AgentLoop/ToolRouter/AddonsBackend/EnvironmentBackend…
│   │   ├─ dev/           # Node 自测脚本（selftest-*.mjs，不打包进 omni.ja）
│   │   └─ package.json   # npm run build（esbuild）生成 bundle
│   ├─ dom/base/          # FrxFingerprintConfig.*（指纹配置 C++ 读取层）
│   ├─ js/src/vm/         # JSVMP 逐指令 trace（SpiderMonkey 解释器钩子）
│   ├─ dom/bindings/      # WebAPI trace（binding 边界观测）
│   └─ security/…         # 其余接入模块
├─ scripts/           # bootstrap / apply-patches / build / package / 校验脚本
│   └─ apply-fingerprint-config.py  # ★ 幂等写入 Gecko/Necko 指纹接入点（Navigator/WebGL/UA/Intl…）
├─ settings/          # 运行时配置样例（*.example.json，复制为 *.json 不入库）
├─ tools/             # JSVMP Babel-AST 拆解 / 反汇编器（Node 工具）
├─ configs/           # mozconfig 模板（本文件同目录新增 mozconfig.windows-x64）
└─ docs/              # architecture.md / features.md / agent-sidebar.md / upstream-sync.md
```

要点：
- **补丁模式**：改上游已有文件 → `patches/`；纯新增文件 → `additions/`；运行时配置 → `settings/`。
- 指纹接入点不是 .patch，而是 `scripts/apply-fingerprint-config.py` 按标记幂等写入（跑两次不会重复）。
- 环境/trace 数据在 `~/.firefox-reverse/`，不进仓库也不进构建目录。

## 2. 一键构建流程（本仓库 Makefile）

```bash
make bootstrap   # 浅克隆锁定的 Firefox 到 upstream/
make patch       # 应用 patches/ + rsync additions/ + 指纹接入脚本 + branding 校验
cd upstream
cp ../configs/mozconfig.windows-x64 mozconfig
./mach --no-interactive bootstrap --application-choice browser   # 首次：装 rust/clang/VS 检查
./mach build && ./mach package       # 产物 upstream/obj-*/dist/
```

日常开发循环：改 `additions/` → 重跑 `make patch`（幂等）→ `cd upstream && ./mach build`。
增量编译通常几分钟级；改 `*.jsx` 先 `npm run build`。

本机已验证：首次全量编译 71 分钟、0 错误；产物
`upstream/obj-win-x64/dist/firefox-153.0a1.en-US.win64.zip` 与 `.installer.exe`。
打包 `browser/omni.ja` 内含全部 47 个 agent-sidebar 文件；冒烟启动（临时 profile）
浏览器进程稳定运行、profile 数据库正常初始化。

## 3. 前端（Agent 侧栏 React UI）

```bash
cd additions/browser/components/agent-sidebar
npm install          # 一次性：esbuild + react（devDeps）
npm run build        # 产物 content/agent-sidebar.bundle.js（217KB，随 additions 拷入 upstream）
npm run watch        # 开发模式：--watch + sourcemap
node dev/selftest-*.mjs   # Node 自测（llm/config/e2e/…，不依赖编译产物）
```

- bundle 是生成物，**发布前必须重新 build**；`additions/README.md` 与 `patches/agent-ui/HANDOFF.md` 有完整模块说明。
- `.sys.mjs` 后端模块（modules/）无需打包，直接进 omni.ja（resource:///modules/agentsidebar/）。

## 4. 新增一个自己的补丁模块

```bash
cd upstream
# 编辑上游文件……
git add -A && git commit -m "[my-feature] brief description"
git format-patch -1 --output-directory ../patches/my-feature/
# 然后把 my-feature 加进 scripts/apply-patches.sh 的 MODULES 数组（注意依赖顺序）
```

## 5. Windows 构建环境与已验证的坑（本机实测）

环境清单（本机已就绪）：
- VS 2022 BuildTools：MSVC 14.44 + Windows SDK 10.0.26100（`cl.exe` ✅）
- MozillaBuild：`C:\mozilla-build`（mach 在 Windows 必需，装完才能跑 mach build）
- Python：mach 自动挑 ≤3.12 的解释器（本机 3.12 可用，`py -3.12`）
- Node ≥ 18（前端 bundle）、git、rsync

已踩过的坑与解法：

1. **`git apply` 补丁失败（patch does not apply），blob 哈希明明一致**
   → Windows 全局 `core.autocrlf=true` 把仓库里的 `.patch` 文件检出成了 CRLF。
   本仓库没有 `.gitattributes`。**修复**：`git config core.autocrlf false && git reset --hard`
   （或给仓库加 `.gitattributes`：`*.patch text eol=lf`）。upstream/ 因上游自带
   `.gitattributes` 不受影响。

2. **`apply-patches.sh` 的 rsync 报 `Unexpected remote arg: D:/…`**
   → Windows 原生 rsync 把 `D:` 当作远程主机。**修复**：用相对路径执行
   `rsync -a additions/ upstream/`（已在脚本外用相对路径补齐；建议后续给脚本本身加兼容）。

3. **mach 报 `MozillaBuild was not found at "C:\mozilla-build"`**
   → 先装 MozillaBuild 再跑 mach。官方安装器 `MozillaBuildSetup-Latest.exe /S` 即可；
   若 Git Bash 直接执行报 Permission denied，用 PowerShell `Start-Process -Wait`。

4. **Python 3.14 警告**：mach 会提示「建议 ≤3.12」，实际运行会自动降级；无需处理。

5. **本机 Git Bash 的 curl SSL 失败但网络其实通**：用 Python/PowerShell 下载代替 curl，
   不代表目标站被墙（git clone GitHub 正常）。

6. **`mach bootstrap` 在 `Checking for Dev Drive...` 处崩溃（UnicodeDecodeError 0xb0）**
   → 中文版 Windows 的 `cmd /c ver` 输出 GBK，mach 按 UTF-8 解码炸了。
   **跳过**：`MACH_HIDE_DEV_DRIVE_SUGGESTION=1 ./mach bootstrap ...`

7. **`mach bootstrap` 弹 UAC（加 Defender 排除项）**
   → 预置 flag 文件即可跳过：新建 `%USERPROFILE%\.mozbuild\.ANTIVIRUS_EXCLUSIONS_DONE`。
   排除项对构建提速有益，之后想加用管理员 PowerShell：
   `Add-MpPreference -ExclusionPath '<upstream>','C:\mozilla-build','<.mozbuild>'`。

8. **mozconfig 写 `--target=x86_64-pc-mingw32` 导致 configure 无限重试**
   → 原生 MSVC 构建不要写 `--target`，主机探测自动用 `x86_64-pc-windows-msvc`。

9. **rustup 下载报 `os error 10013`（socket 被本机安全软件拦截，镜像域也拦）**
   → `rustup target add i686-pc-windows-msvc` 对任何源都连不上，但 Python/浏览器同 URL 正常。
   **绕过**：用 Python 下载 `rust-std-<ver>-i686-pc-windows-msvc.tar.xz`，解包后把内层
   `rust-std-i686-pc-windows-msvc/lib/` 合并进
   `%USERPROFILE%\.rustup\toolchains\stable-x86_64-pc-windows-msvc\lib\`，
   并向 `lib\rustlib\components` 追加一行 `rust-std-i686-pc-windows-msvc`；
   用 `rustc --target i686-pc-windows-msvc -e "" test.rs` 验证可编。
   win64 主构建实际只依赖 x86_64 target，i686 只是 bootstrap 的检查项。

## 6. 日常迭代与验证

- **C++ 层改动**（指纹/trace/UA）：改 `additions/**` → `make patch` → `mach build`。
  指纹行为验证：启动时设 `MOZ_FRX_FINGERPRINT_CONFIG=<path>/fingerprint.json`
  （参考 `settings/fingerprint.example.json`），对比页面 `navigator.*` / `screen.*` / WebGL。
- **trace 验证**：设 `MOZ_JSVMP_TRACE_FILE` / `MOZ_WEBAPI_TRACE_FILE` / `MOZ_FRX_TRACE_DIR`，
  输出为 NDJSON（`traces/*.jsonl`）。
- **侧栏/Agent 改动**：改完跑 `node dev/selftest-*.mjs`（能在 Node 里跑的逻辑先自测），
  再编译装入验证里程碑：**侧栏出现 Agent 图标 → 填模型 Key → 对话拿到回复**。
- **打包校验**：`scripts/verify-windows-package.py`（CI 用它验证 ZIP 内二进制可启动）。
- **还原干净基线**：`make reset`（撤销补丁）+ 重跑 `make patch`；upstream 浅克隆无需重拉。

## 7. 上游同步

按 `docs/upstream-sync.md`：改 `scripts/bootstrap.sh` 的 `UPSTREAM_REF` → 重新 bootstrap
→ 重跑 `make patch` 处理冲突 → 冲突补丁归档 `patches/<module>/legacy/`。
