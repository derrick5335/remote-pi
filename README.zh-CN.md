<p align="right">
  <a href="README.md">English</a> | <b>简体中文</b>
</p>

# remote-pi

<p align="center">
  <b>通过 Telegram 远程操作 <a href="https://github.com/mariozechner/pi-coding-agent">Pi</a> coding agent 的轻量网关</b><br>
  无需公网 IP、无须 SSH 端口映射、无需中继服务，在手机上随时随地驱动本地或远程机器上的 Pi。
</p>

<p align="center">
  <img src="https://img.shields.io/badge/node-%3E%3D22.18.0-brightgreen.svg" alt="Node.js">
  <img src="https://img.shields.io/badge/platform-Telegram%20Only-blue.svg" alt="Platform">
  <img src="https://img.shields.io/badge/daemon-macOS%20Launchd-orange.svg" alt="macOS Launchd">
  <img src="https://img.shields.io/badge/license-MIT-green.svg" alt="License">
</p>

---

## 平台与定位说明

- **聊天平台**：**当前仅支持 Telegram**。网关针对 Telegram Bot API 进行了深度优化（充分利用 `sendMessage` + `editMessageText` 原地消息流式实时呈现、内联按钮、消息接收 Reaction 表情、多模态附件解析与可折叠引用块）。
- **运行环境**：
  - **macOS**：提供开箱即用的 `./install.sh` 脚本，将网关注册为 launchd 用户守护进程，配合 `caffeinate` 保持接电状态下常驻防睡眠。
  - **Linux**：支持直接前台运行或由用户编写 systemd 服务常驻。

---

## 核心特性

- ⚡ **轻量极简核心**：单文件核心实现（`gateway.mjs`），除 `markdown-it` 用于 Telegram HTML 格式渲染外，全部使用 Node.js 标准库，无重型框架包袱。
-  **休眠唤醒秒级自愈**：内置笔记本休眠与唤醒时间漂移检测。在合盖唤醒（开盖）时，毫秒级主动切断挂起的旧长轮询死连接，并在 Wi-Fi 连通的瞬间（1~2 秒内）快速探测并恢复 Telegram 连接，告别 60 秒死等超时。
- 🔒 **配置与状态严格解耦（12-Factor 原则）**：`config.json` 保持只读；运行期工作区切换（`/cwd`）与最近项目持久化于 `state.json`；Session 目录采用稳定摘要防碰撞。
- 🎯 **100% 基于 Pi 原生状态与能力**：会话状态、模型列表、上下文统计、参数配置等全部通过 JSON-RPC 严格依赖 Pi 原生提供的数据接口，无私有黑盒或非标准文件桥接。
- 🌊 **原生流式输出**：通过静音消息创建与原地实时编辑（`sendMessage` + `editMessageText`）呈现思考过程与回复，从根源上杜绝跨接口草稿转换导致的幽灵气泡、残留与重复闪烁。
- 🛠️ **原生可折叠工具卡片**：Agent 连续调用工具（Bash、读写文件、Grep 等）时，自动生成原生可折叠引用块（`<blockquote expandable>`），保持手机端信息整洁不刷屏。
- 📄 **超长回复转文件阅读**：超过 `longReplyChars`（默认 8000）的最终回复不再刷屏，改为发送一份自适应暗色模式的独立 HTML 文档（完整 CommonMark + GFM 表格渲染），聊天中仅保留首段预览与提示；可用 `longReplyChars` 调整或设 `0` 关闭；`/export` 通过 Pi 原生 `export_html` 导出整个会话。
- 🚑 **错误一键恢复按钮**：模型报错、空回复、Pi 异常退出、扩展失败等场景自动附带内联按钮（1 小时有效）：重发上一次 Prompt、切换备用模型重试（`fallbackModels`）、浏览模型列表、重启 Pi、查看脱敏网关日志，无需手动输命令。
- 🎮 **Telegram Companion 扩展**：
  - 自带 `remote-extension.mjs`，向模型提供 `remote_attach`（主动将本地生成的文件/产物发回聊天窗口）与 `remote_ask`（交互按钮问答）两个工具（保持对 `telegram_attach`/`telegram_ask` 的兼容）。
  - 支持配置加载用户自定义的 Pi 扩展（`-e` 注入），并在 Telegram 中无缝代理扩展的 UI 交互（`ctx.ui.select` / `ctx.ui.confirm` / `ctx.ui.input`）。
- 🎙️ **多模态与语音转写（STT）**：
  - **语音输入**：支持在配置中指定 `sttCommand`（如 Groq Whisper API 或本地 mlx-whisper），发送语音消息即自动转写为 Prompt 执行。
  - **视觉与附件**：直接向 Bot 发送图片（模型原生视觉上下文）或代码/文档/音视频文件（自动下载至本地供 Pi 处理分析）。
- 💬 **实时干预（Steer）与表情反馈（Reaction ACK）**：
  - Agent 执行过程中，直接在聊天窗口发送文字即可作为 steer 动态修正任务方向。
  - 收到消息时 Bot 仅在原消息标记一次“接收”表情（默认 `👀`），之后保持不变。完成状态由运行摘要卡片通知，不再更换表情。
- 📊 **运行摘要卡片与快捷操作**：任务结束时自动发送包含提示音的完成卡片（`✅ Done · 2m13s · +$0.04 · 12.3k tok · ctx 31%`）并列出变更文件清单（`+a −d`）。提供内联快捷操作按钮：`📄 Diff`（内联查看或下载完整 unified diff）、`✅ Commit`（流式常规提交 Prompt）、`↩️ Undo run`（交互式回滚与清理新文件）。
- 📌 **置顶状态看板**：每个会话首次运行自动创建并置顶一条状态看板（`⏳ Working / 💤 Idle / ⚠️ Pi stopped / 🖥 On desktop`），采用 3 秒节流原地更新，流式期间每 15 秒心跳跳动耗时。清晰展示当前工具、生效模型、Thinking 等级、上下文窗口百分比、排队追问数与上次运行摘要。
- 🔒 **单实例互斥与严格白名单**：
  - 本地 Unix Domain Socket 互斥锁，杜绝后台多实例竞争导致会话混乱；
  - 严格限制仅响应配置的单一 `allowedUserId` 私聊请求，忽略非授权用户与所有群聊消息。

---

## 常用命令

| 命令 | 说明 |
| :--- | :--- |
| 直接发送文字 | 与 Pi 对话；任务执行中发送的文字会作为实时干预（Steer） |
| `/cwd [路径]` | 切换工作目录（支持 `~/` 与相对路径，目录无效会报错）；不带参数则弹出最近 20 个历史项目的选择键盘 |
| `/topic [路径]` | 创建新的 Topic 会话用于并行任务；不带参数则使用当前工作目录 |
| `/close` | 关闭当前 Topic 会话（弹出确认按钮，确认后停止其 Pi 进程并删除该 Topic） |
| `/model [关键词]` | 弹出内联键盘选择模型，或直接按关键词/完整 ID 快速切换 |
| `/thinking [level]` | 查看或设置思考强度级别（如 `off`, `low`, `high`） |
| `/new` | 开启新会话，重置上下文并以卡片汇报当前模型、环境与工作目录 |
| `/resume` | 弹出最近历史会话列表供选择恢复，支持浏览并恢复当前目录的桌面端会话 |
| `/sh <命令>` | 直接在项目工作目录下执行系统 Shell 命令，0 Token 毫秒级响应。注意：此处对服务重启/停止命令的拦截仅为误操作防护，并非安全边界 —— 持有 Bot 者本就拥有完整 Shell 权限 |
| `/get <相对路径>` | 将当前项目中的文件作为附件下载到 Telegram |
| `/followup <指令>` | 排队追加后续任务，不打断当前轮次执行 |
| `/session` 或 `/status`| 查看当前会话 ID、模型、上下文消耗统计及费用 |
| `/agents` | 按工作区列出 Herdr 中所有 agent 的状态（📱 = Telegram 会话，📡 = 已推送到 Telegram），点按钮查看其屏幕 |
| `/compact [要求]` | 主动触发上下文压缩与精简 |
| `/export` | 通过 Pi 原生 `export_html` 将整个会话导出为 HTML 文件并发送 |
| `/fork` | 从历史用户消息创建分支会话 |
| `/handoff` | 将当前会话移交至桌面端 Pi（安全停止手机端 Pi，提供一键复制命令与收回按钮） |
| `/abort` | 立即中断当前正在运行的任务 |
| `/upgrade` | 自升级：fast-forward git pull → npm install → 离线自检（失败自动回滚）→ 重启 |
| `/help` | 显示完整的操作帮助 |

> **提示**：安装到 Pi 的 Skills 会在 Telegram 中自动映射为可执行指令（如 `/skill_name`）。

---

## 环境准备

1. **Node.js**：需要 **>= 22.18.0**（推荐 Node 24 LTS，依赖 ES 模块原生 `import.meta.main`）。
2. **Pi CLI**：在终端中已全局安装并完成模型登录的 Pi 命令行工具（如 `@mariozechner/pi-coding-agent`）。
3. **Telegram Bot Token 与 User ID**：
   - 在 Telegram 联系 [@BotFather](https://t.me/BotFather) 输入 `/newbot`，创建 Bot 并保存获得的 Token。
   - 获取自己的纯数字 Telegram User ID（向刚创建的 Bot 发送任意消息，运行下述命令即可获取）：
     ```bash
     read -s TOKEN   # 粘贴你的 Bot Token
     curl -s "https://api.telegram.org/bot${TOKEN}/getUpdates" | \
       node -e 'fs=require("fs");d=JSON.parse(fs.readFileSync(0,"utf-8"));console.log(d.result?.slice(-1)[0]?.message?.from?.id)'
     unset TOKEN
     ```

---

## 快速上手

### 1. 克隆项目与安装依赖

```bash
git clone https://github.com/derrick5335/remote-pi.git
cd remote-pi
npm install --omit=dev
```

### 2. 离线自检

在不连接 Telegram 的情况下运行离线单元测试：

```bash
npm test
# 输出 "self-test: ok" 即表示全部核心逻辑正常
```

Lint（ESLint，仅安全规则）：

```bash
npm run lint
```

### 3. 创建配置文件

复制示例配置并保护权限：

```bash
mkdir -p ~/.config/remote-pi
cp config.example.json ~/.config/remote-pi/config.json
chmod 600 ~/.config/remote-pi/config.json
```

编辑 `~/.config/remote-pi/config.json`，填入 Bot Token、用户 ID 以及工作目录：

```json
{
  "telegram": {
    "botToken": "123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ",
    "allowedUserId": "123456789"
  },
  "cwd": "~/dev/my-project"
}
```

### 4. 启动网关

#### 方式 A：前台运行（开发调试 / Linux）

```bash
npm start
# 或者: node gateway.mjs
```

#### 方式 B：macOS launchd 常驻后台（推荐）

本项目提供自动化安装脚本，可将网关注册为开机启动并在崩溃时自动拉起的 launchd 服务：

```bash
./install.sh install
```

安装后可通过全局管理命令进行运维：

```bash
pi-remote-gateway status   # 查看运行状态与近期日志
pi-remote-gateway upgrade  # 自升级：git pull（仅 ff）+ npm install + 自检 + 自动重启
pi-remote-gateway restart  # 代码更新后重启服务生效
pi-remote-gateway logs     # 持续跟踪日志输出 (tail -f)
pi-remote-gateway stop     # 停止后台服务
```

---

## 配置项参考

配置文件默认路径为 `~/.config/remote-pi/config.json`，也可以通过环境变量 `REMOTE_PI_CONFIG` 自定义。

### 核心配置

首启时 `telegram.botToken`、`telegram.allowedUserId` 和 `cwd` 为必填项（cwd 缺失或目录无效会在启动时快速报错）。运行时通过 `/cwd` 切换的工作目录及最近项目均保存在 `state.json`（`~/.local/var/remote-pi/state.json`）中，保持 `config.json` 纯净只读。

| 配置键 | 对应环境变量 | 默认值 | 详细说明 |
| :--- | :--- | :--- | :--- |
| `telegram.botToken` | `TELEGRAM_BOT_TOKEN` | *必填* | BotFather 生成的 Telegram Bot Token |
| `telegram.allowedUserId` | `TELEGRAM_ALLOWED_USER_ID` | *必填* | 允许访问的 Telegram 纯数字用户 ID |
| `cwd` | `PI_CWD` | *首次启动必填* | Pi 启动时的初始工作目录；除非 `state.json` 中已记录，否则必填（支持 `~/` 展开；运行期切换由 `state.json` 记录） |

### 进阶选项（开箱即用默认值）

| 配置键 | 对应环境变量 | 默认值 | 详细说明 |
| :--- | :--- | :--- | :--- |
| `piBin` | `PI_BIN` | 自动探测 | Pi CLI 可执行文件路径（自动探测 Homebrew / 全局 npm 路径） |
| `approve` | - | `true` | 是否向 Pi 传递 `--approve`（信任当前项目本地配置与扩展；详见 Pi 官方信任机制） |
| `herdr` | `REMOTE_PI_HERDR` | `true` | 是否自动接入 Herdr（有 server 则直接加入，无则拉起 headless server，并为 Pi 注入工作区与窗格环境变量） |
| `enableCompanionExtension` | `REMOTE_PI_COMPANION_EXTENSION` | `true` | 是否加载自带的伴侣扩展（提供 `remote_attach` 与 `remote_ask` 工具） |
| `extensions` | `REMOTE_PI_EXTENSIONS` | `[]` | 额外注入 Pi 的自定义扩展文件路径数组（支持 `~/` 及相对于配置文件的路径） |
| `sttCommand` | - | `""` | 语音转写命令（详见下方语音转写示例） |
| `stateDir` | - | `~/.local/var/remote-pi` | 运行时状态、会话文件、下载附件与套接字锁的存放目录 |
| `logFile` | `REMOTE_PI_LOG_FILE` | `~/.local/var/log/remote-pi.log` | 网关运行日志输出路径 |
| `idleStopMinutes` | `REMOTE_PI_IDLE_STOP_MINUTES` | `30` | 非流式 Topic 会话无活动的空闲分钟数，达到后自动停止其 Pi 进程（下次消息自动恢复；主会话永不休眠）；设为 `0` 完全关闭空闲停止 |
| `maxSessions` | `REMOTE_PI_MAX_SESSIONS` | `4` | 所有会话中允许同时运行的最大 Pi 进程数（超限时自动挂起最近最少使用的非流式 Topic） |
| `telegram.ackEmoji` | `TELEGRAM_ACK_EMOJI` | `"👀"` | 收到消息时贴上的 Reaction 表情 |
| `longReplyChars` | `REMOTE_PI_LONG_REPLY_CHARS` | `8000` | 超过该长度的回复改为发送 HTML 文档（聊天中保留首段预览与提示）；设 `0` 关闭 |
| `downloadRetentionDays` | `REMOTE_PI_DOWNLOAD_RETENTION_DAYS` | `30` | 下载目录内文件与 `failed-reply-*.txt` 副本的保留天数（启动时及每 24 小时按 mtime 清理）；设 `0` 关闭清理 |
| `fallbackModels` | `REMOTE_PI_FALLBACK_MODELS` | `[]` | 逗号分隔的 `provider/modelId` 备用模型列表，报错时提供「切换模型重试」按钮（取当前模型在列表中的下一个，循环回绕） |
| `doneCard` | `REMOTE_PI_DONE_CARD` | `true` | 是否在每次运行结束时发送带通知的运行摘要与变更卡片（含 Diff/Commit/Undo 按钮） |
| `statusBoard` | `REMOTE_PI_STATUS_BOARD` | `true` | 是否为每个会话维护并置顶状态看板（节流更新状态、工具、模型、上下文与追问） |

> **环境变量覆盖说明**：环境变量优先级高于配置文件。例如 `REMOTE_PI_EXTENSIONS` 可以传入 JSON 数组字符串（如 `'["~/ext.ts"]'`）或逗号分隔的路径列表。

---

## 进阶玩法

### Topics / 并行多会话

网关支持通过 Telegram 私聊 Topics（Telegram Bot API 9.3+）同时运行多个相互独立的 Pi 会话，实现手机端多项目并行开发。

1. **在 @BotFather 中开启 Topic 模式**：
   - 在 Telegram 打开 [@BotFather](https://t.me/BotFather)。
   - 点击 **Open** 打开 BotFather Mini App → 选择你的 Bot → **Bot Settings** → **Threads Settings** → 开启 **Threaded Mode**（经典 `/mybots` 文字菜单里没有这个选项）。
2. **创建 Topic 会话**：
   - 发送 `/topic [路径]` 为指定项目目录创建独立 Topic；不带参数则复用当前会话的工作目录。
   - 每个 Topic 拥有完全独立的 Pi 进程、工作区和会话历史（存储在 `sessionDir + "-t<threadId>"`，多 Topic 访问同一项目也不冲突）。
3. **会话管理**：
   - 在 Topic 内执行 `/cwd <路径>` 仅切换当前 Topic 的工作目录，并自动重命名 Topic 标签。
   - 在 Topic 内执行 `/close` 弹出确认按钮，确认后停止该 Topic 的 Pi 进程并删除该 Topic。
   - 在主会话中执行 `/status` 可一览所有 Topic 会话的状态（running / idle / stopped）与路径。
   - 超出 `idleStopMinutes`（默认 30 分钟）无活动的 Topic 会被自动停止释放内存，下次发送消息时自动通过 `--continue` 恢复。

### 语音转写（STT）配置

在 `config.json` 中配置 `"sttCommand"`。网关调用此命令时，会通过 `$1` 传入下载到本地的音频文件绝对路径，命令的标准输出（stdout）即作为转写文字。

**示例 1：使用 Groq Whisper API（毫秒级极速响应）**
```json
{
  "sttCommand": "curl -s https://api.groq.com/openai/v1/audio/transcriptions -H \"Authorization: Bearer $GROQ_API_KEY\" -F file=@$1 -F model=whisper-large-v3-turbo -F response_format=text"
}
```

**示例 2：使用本地 Apple Silicon 硬件加速（mlx-whisper）**
```json
{
  "sttCommand": "mlx_whisper --model mlx-community/whisper-large-v3-turbo $1"
}
```

### Herdr 桌面联动与状态推送

当你在电脑端运行 [Herdr](https://herdr.dev) 时，网关与其 socket API 深度联动：

1. **Telegram 会话在 Herdr 中全局可见**：
   - 每个 Telegram 会话（主会话及各 Topic）都会在 Herdr 中拥有独立工作区，标签统一为 `📱 <basename>`（或 `📱 <basename>#<threadId>`）。
   - 网关直接通过 socket（source `remote-pi`）向 Herdr 实时汇报状态（`working`、`idle`，或包含提问标题的 `blocked` 待确认状态），在 `herdr agent list` 中与本地 agent 一同展示。
   - 对应窗格内启动紧凑 ANSI 观察器（`gateway.mjs --watch-session`），实时滚动展示只读会话日志（用户指令、模型回答、工具调用及报错、上下文压缩等）。
2. **桌面 Pi 远程控制 Topic 联动（按 agent 手动开启）**：
   - 在桌面端跑其他 Pi agent 时，开启远程控制可将该 agent 桥接到**专属 Telegram Topic**。在桌面 Pi 中输入 `/remote-control`（或 `/remote-control on|off|status`；兼容老命令别名 `/remote-pi`）开启。
   - **前置要求**：Telegram 需为该 Bot 开启 Threaded Mode / 话题模式（在 @BotFather Mini App 中设置：Bot Settings → Threads Settings → Threaded Mode）。若未开启话题模式，通知将自动降级回退至主会话。
   - `install.sh`（以及 `pi-remote-gateway upgrade`）会把 `herdr-extension.ts` 软链到 `~/.pi/agent/extensions/remote-pi.ts`。
   - 开关作为 Herdr 原生 pane metadata token（`remote_pi=on`）存在 pane 上，Pi 退出时自动清除。
   - **实时会话流式同步**：桌面 Pi 的会话内容按消息粒度实时流式推送到该 Topic（包含用户消息、模型回复文本及超长文档导出、工具调用原地更新折叠面板；忽略模型思考过程与原始工具执行结果）。
   - **双向交互与控制**：在 Topic 内直接发送普通文本即可给桌面 agent 发送新指令（具备回声抑制，避免重复输出）；`/status` 查看当前 agent 状态与终端屏幕，`/abort` 发送 `Esc` 中断当前任务。
   - **需要确认**（`blocked`）：推送屏幕末尾内容，附带识别出的编号选项按钮（`1. Yes`、`2. …`）以及 `⏎ Enter` / `⎋ Esc`。`blocked` 状态带有通知提示，`done` 完成通知则静音推送。
   - `/agents` 列出 Herdr 中所有 agent：`📱` 标出 Telegram 会话，`📡` 标出已桥接远程控制的桌面 agent。

### 手机 ↔ 桌面端会话无缝流转 (Handoff)

两个 Pi 进程严禁同时写入同一个 session 文件。网关自带会话存储在 `~/.local/var/remote-pi/sessions`，与桌面端 Pi 默认目录（`~/.pi/agent/sessions/`）天然隔离。

- **手机 → 桌面 (`/handoff`)**：
  - 发送 `/handoff` 会优雅停止网关端的 Pi 进程并释放 Herdr agent 权限。
  - 若 Herdr 处于运行中，网关停止窗格观察器，并通过 `herdr agent start` 直接在该 Herdr 窗格内启动交互式桌面 Pi，由 Herdr 官方集成自动接管状态汇报。
  - 生成备用可复制终端接续命令：
    ```bash
    cd '<cwd>' && pi --session '<sessionFile>'
    ```
  - 移交状态下，置顶状态看板首行显示为 `🖥 On desktop since HH:MM`，向 Telegram 发送的消息不会转发给 Pi。
  - 点击 `⬅️ 收回` 将会话切回 Telegram：
    - 网关先检查该 Herdr 窗格中的 agent 状态：若仍处于 `working` 或 `blocked`，为防止并发文件写入会拒绝收回并提示稍后重试。
    - 若处于 `idle` 或 `done`，网关向该窗格发送 `/quit` 并回车，轮询等待桌面 Pi 进程退出至 Shell 后，自动在 Telegram 重启 Pi、无缝重载会话历史并重启观察器。
    - 若桌面 Pi 在 10 秒内未退出，会告警提示并保持移交标记。
  - 或点击 `✨ 在此开启新会话`。
- **桌面 → 手机 (`/resume` 中的桌面会话)**：
  - 发送 `/resume`，若检测到当前工作目录下存在桌面端 Pi 历史会话，内联键盘中会出现 `🖥 Desktop sessions` 按钮。
  - 列出最近 10 条桌面会话（含相对修改时间与首条用户指令预览）。
  - 选择目标会话并确认桌面端 Pi 已退出后，网关通过 `switch_session` 无缝载入并接续。

---

## 架构简述

```text
[ Telegram 客户端 ]
       ↕ (HTTPS Long Polling / SendMessageDraft / Reactions / Callbacks)
[ gateway.mjs ] (单进程常驻, Node stdlib + markdown-it, Unix Socket 互斥锁)
       ↕ (JSON-RPC over stdio)
[ pi --mode rpc --continue ]
       ↕ (-e remote-extension.mjs & custom extensions)
[ 本地工作区与系统工具 ]
```

- **常驻与电源管理**：macOS 下 launchd 启动命令包装了 `/usr/bin/caffeinate -s -i -- node gateway.mjs`，确保在接通电源时处于暗唤醒状态随时接收指令，而不阻止合盖睡眠。
- **会话持久化隔离**：网关启动的 Pi 进程会将 Telegram 会话单独持久化在 `~/.local/var/remote-pi/sessions` 下，与桌面终端使用的 Pi 会话目录隔离，避免两端同时读写同一个会话文件导致冲突。

---

## 安全须知

1. **权限等同本机用户**：控制了该 Telegram Bot 即等同于获得了该电脑上的完整 Shell 运行与文件读写权限。
2. **严禁将 Bot 拉入任何群聊**：本项目针对 1 对 1 私聊设计，即便有白名单过滤，将具有命令执行能力的 Bot 置于公开群聊环境仍存在极大的误触与安全攻击面。
3. **保护配置文件权限**：`~/.config/remote-pi/config.json` 包含 Bot Token，应严格维持 `600` 文件权限（仅当前系统用户可读写）。

---

## License

[MIT](LICENSE) © 2026 Yunpeng Pan
