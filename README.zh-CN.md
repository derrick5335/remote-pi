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

- **聊天平台**：**当前仅支持 Telegram**。网关针对 Telegram Bot API 进行了深度优化（充分利用 `sendMessageDraft` 流式草稿实时预览、内联按钮、消息 Reaction 表情状态机、多模态附件解析与可折叠引用块）。
- **运行环境**：
  - **macOS**：提供开箱即用的 `./install.sh` 脚本，将网关注册为 launchd 用户守护进程，配合 `caffeinate` 保持接电状态下常驻防睡眠。
  - **Linux**：支持直接前台运行或由用户编写 systemd 服务常驻。

---

## 核心特性

- ⚡ **轻量极简核心**：单文件核心实现（`gateway.mjs`），除 `markdown-it` 用于 Telegram HTML 格式渲染外，全部使用 Node.js 标准库，无重型框架包袱。
- 🔒 **配置与状态严格解耦（12-Factor 原则）**：`config.json` 保持只读；运行期工作区切换（`/cwd`）与最近项目持久化于 `state.json`；Session 目录采用稳定摘要防碰撞。
- 🎯 **100% 基于 Pi 原生状态与能力**：会话状态、模型列表、上下文统计、参数配置等全部通过 JSON-RPC 严格依赖 Pi 原生提供的数据接口，无私有黑盒或非标准文件桥接。
- 🌊 **原生流式输出**：优先利用 Telegram 官方流式草稿（`sendMessageDraft`）实时输出思考过程与回复（在聊天界面中自带暂停/停止按钮）；不支持时平滑降级为静音消息编辑。
- 🛠️ **原生可折叠工具卡片**：Agent 连续调用工具（Bash、读写文件、Grep 等）时，自动生成原生可折叠引用块（`<blockquote expandable>`），保持手机端信息整洁不刷屏。
- 🎮 **Telegram Companion 扩展**：
  - 自带 `remote-extension.mjs`，向模型提供 `remote_attach`（主动将本地生成的文件/产物发回聊天窗口）与 `remote_ask`（交互按钮问答）两个工具（保持对 `telegram_attach`/`telegram_ask` 的兼容）。
  - 支持配置加载用户自定义的 Pi 扩展（`-e` 注入），并在 Telegram 中无缝代理扩展的 UI 交互（`ctx.ui.select` / `ctx.ui.confirm` / `ctx.ui.input`）。
- 🎙️ **多模态与语音转写（STT）**：
  - **语音输入**：支持在配置中指定 `sttCommand`（如 Groq Whisper API 或本地 mlx-whisper），发送语音消息即自动转写为 Prompt 执行。
  - **视觉与附件**：直接向 Bot 发送图片（模型原生视觉上下文）或代码/文档/音视频文件（自动下载至本地供 Pi 处理分析）。
- 💬 **实时干预（Steer）与表情反馈（Reaction ACK）**：
  - Agent 执行过程中，直接在聊天窗口发送文字即可作为 steer 动态修正任务方向。
  - 收到消息时 Bot 立即在原消息标记“接收”表情（默认 `👀`），执行完成自动替换为“完成”表情（默认 `🫡`），彻底消除移动端等待焦虑。
- 🔒 **单实例互斥与严格白名单**：
  - 本地 Unix Domain Socket 互斥锁，杜绝后台多实例竞争导致会话混乱；
  - 严格限制仅响应配置的单一 `allowedUserId` 私聊请求，忽略非授权用户与所有群聊消息。

---

## 常用命令

| 命令 | 说明 |
| :--- | :--- |
| 直接发送文字 | 与 Pi 对话；任务执行中发送的文字会作为实时干预（Steer） |
| `/cwd [路径]` | 切换工作目录（支持 `~/` 与相对路径，目录无效会报错）；不带参数则弹出最近 20 个历史项目的选择键盘 |
| `/model [关键词]` | 弹出内联键盘选择模型，或直接按关键词/完整 ID 快速切换 |
| `/thinking [level]` | 查看或设置思考强度级别（如 `off`, `low`, `high`） |
| `/new` | 开启新会话，重置上下文并以卡片汇报当前模型、环境与工作目录 |
| `/resume` | 弹出最近历史会话列表供选择恢复 |
| `/sh <命令>` | 直接在项目工作目录下执行系统 Shell 命令，0 Token 毫秒级响应 |
| `/get <相对路径>` | 将当前项目中的文件作为附件下载到 Telegram |
| `/followup <指令>` | 排队追加后续任务，不打断当前轮次执行 |
| `/session` 或 `/status`| 查看当前会话 ID、模型、上下文消耗统计及费用 |
| `/compact [要求]` | 主动触发上下文压缩与精简 |
| `/fork` | 从历史用户消息创建分支会话 |
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
| `telegram.ackEmoji` | `TELEGRAM_ACK_EMOJI` | `"👀"` | 收到消息时贴上的 Reaction 表情 |
| `telegram.doneEmoji` | `TELEGRAM_DONE_EMOJI` | `"🫡"` | 任务完成时替换的 Reaction 表情 |

> **环境变量覆盖说明**：环境变量优先级高于配置文件。例如 `REMOTE_PI_EXTENSIONS` 可以传入 JSON 数组字符串（如 `'["~/ext.ts"]'`）或逗号分隔的路径列表。

---

## 进阶玩法

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
