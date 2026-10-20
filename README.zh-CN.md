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

- **聊天平台**：**当前仅支持 Telegram**。网关针对 Telegram Bot API 进行了深度优化（充分利用 `sendMessageDraft` 临时草稿预览、`sendMessage` 持久回复、内联按钮、状态 Reaction 表情、多模态附件解析与可折叠引用块）。
- **运行环境**：
  - **macOS**：提供开箱即用的 `./install.sh` 脚本，将网关注册为 launchd 用户守护进程，配合 `caffeinate` 保持接电状态下常驻防睡眠。
  - **Linux**：支持直接前台运行或由用户编写 systemd 服务常驻。

---

## 核心特性

- ⚡ **轻量极简核心**：单文件核心实现（`gateway.mjs`），除 `markdown-it` 用于 Telegram HTML 格式渲染外，全部使用 Node.js 标准库，无重型框架包袱。
- 🔒 **配置与状态严格解耦（12-Factor 原则）**：`config.json` 保持只读；运行期工作区与 pane/session 绑定持久化于 `state.json`；会话使用 Pi 原生目录。
- 🎯 **100% 基于 Pi 原生状态与能力**：仅使用 Pi 1.3.0 公开 Extension API、Pi CLI 与 Herdr socket API。每个会话由一个交互式 Pi 进程持有，Telegram 和终端只是该进程的不同视图；无私有补丁或旁路通信文件。
- 🌊 **实时草稿**：`sendMessageDraft` 显示临时文本和当前工具进度，各 Topic 独立更新；更新间隔至少 1.5 秒，每 20 秒保活，最终回复作为持久文本消息发送。草稿失败时仅停用本轮预览，不回退到编辑消息。
- 🔁 **错误重试**：助手错误回复仅附一个 `🔁 Retry` 按钮，重发上一次 Prompt。超长回复直接分段发送文本。
- 🎮 **统一远程控制扩展**：
  - `remote-pi.ts` 提供 `remote_attach`（发送本地文件）与 `remote_ask`（同时在 Telegram 和终端提问，先回答者生效）；工具仅在连接期间启用。
  - **TUI 底部常驻状态**：桥接连接时在 Pi TUI 底部状态栏常驻显示 `📱 remote`，重连中显示 `📱 reconnecting…`，关闭后清除。从 Telegram 关闭时向终端用户发送提示通知。
  - 其他扩展通过 Pi 原生扩展机制安装，其 TUI 对话框不做代理：待确认通知仅展示屏幕末尾内容与 Enter/Esc 控件，不解析屏幕编号选项。
- 🎙️ **多模态与语音转写（STT）**：
  - **语音输入**：支持在配置中指定 `sttCommand`（如 Groq Whisper API 或本地 mlx-whisper），发送语音消息即自动转写为 Prompt 执行。
  - **视觉与附件**：直接向 Bot 发送图片（模型原生视觉上下文）或代码/文档/音视频文件（自动下载至本地供 Pi 处理分析）。
- 💬 **实时干预（Steer）与表情反馈（Reaction ACK）**：
  - Agent 执行过程中，直接在聊天窗口发送文字即可作为 steer 动态修正任务方向。
  - 在触发任务的用户消息上显示：`👀` 已接收 → `👨‍💻` 工作中 → `👌` 已回复、`💔` 出错或 `🤷` 无文本回复；中止会清除表情。终端发起的任务不设置表情。
- 🔒 **单实例互斥与严格白名单**：
  - 本地 Unix Domain Socket 互斥锁，杜绝后台多实例竞争导致会话混乱；
  - 严格限制仅响应配置的单一 `allowedUserId` 私聊请求，忽略非授权用户与所有群聊消息。

---

**通知规则**：仅 Telegram 发起且用户不在桌前的最终助手回复响铃；工具调用阶段的回复及终端发起的回复均静音。`remote_ask` 提问和 blocked 提醒在桌面在线标记不存在时响铃；压缩失败提示始终静音。

## 常用命令

| 命令 | 说明 |
| :--- | :--- |
| 直接发送文字 | 与 Pi 对话；任务执行中发送的文字会作为实时干预（Steer） |
| `/topic [路径]` | 创建新的 Topic 会话用于并行任务；不带参数则使用当前工作目录 |
| `/close` | 确认后关闭当前 Topic：网关创建的 Pi 窗格会退出并关闭；桌面附加窗格仅断开远程控制。随后删除 Topic |
| `/model [关键词]` | 弹出内联键盘选择模型，或直接按关键词/完整 ID 快速切换 |
| `/thinking [level]` | 查看或设置思考强度级别（如 `off`, `low`, `high`） |
| `/new` | 开启新会话，重置上下文并显示当前模型 |
| `/resume` | 列出 Pi 原生目录中当前工作区的会话；若已在其他窗格打开，则提供切换视图到已有窗格的按钮 |
| `/sh <命令>` | 直接在项目工作目录下执行系统 Shell 命令，0 Token 毫秒级响应。注意：此处对服务重启/停止命令的拦截仅为误操作防护，并非安全边界 —— 持有 Bot 者本就拥有完整 Shell 权限 |
| `/followup <指令>` | 排队追加后续任务，不打断当前轮次执行 |
| `/status` | 查看当前会话 ID、模型、上下文消耗统计及费用 |
| `/compact [要求]` | 主动触发上下文压缩与精简 |
| `/abort` | 立即中断当前正在运行的任务，保留排队消息 |
| `/help` | 显示操作帮助，随后列出已加载的扩展命令、提示词模板及技能命令 |

### 管理命令

`/restart` 与 `/name` 均显示在 Telegram 命令菜单中。`/start` 等同于 `/help`。

| 命令 | 说明 |
| :--- | :--- |
| `/name <name>` | 设置会话名称 |
| `/restart` | 重启网关；启动就绪后，将原提示更新为“✅ Gateway restarted” |

> **提示**：已安装的 Pi 技能及自定义命令统一走原生命令路由。内部 `/remote-pi-new` 与 `/remote-pi-switch` 桥接命令不出现在 Telegram 命令发现中；不修改终端自动补全。

### 自定义命令路由

- Telegram 共享菜单从主视图发现 Pi 命令。`/help` 列出当前视图的命令，包括 Topic 独有命令；即使不在共享菜单中，也可手动输入执行。
- 所有网关命令名与 `/start` 别名均为保留名。自定义命令不能覆盖它们，也不能以这些名字在菜单中发布不同的描述。其他名称统一走 Pi 原生命令路由，不设特定命令的快捷逻辑。
- [Telegram 命令名](https://core.telegram.org/bots/api#botcommand)只允许小写英文字母、数字和下划线，最长 32 字符。如果转换或截断后不同 Pi 命令重名，冲突的菜单项会被省略，`/help` 会标注歧义。发送歧义名称只会报错，不会执行 Pi；不自动改名，可使用无歧义的原生写法，或回 Pi 终端执行。
- 自定义命令每次执行都查询当前 Pi 会话的命令列表，不使用主视图或旧项目的缓存别名。已移除的命令会返回“Unknown command”；即使旧菜单项在下次刷新前仍然可见，也不会继续执行。

---

## 环境准备

1. **Node.js**：需要 **>= 22.18.0**（推荐 Node 24 LTS，依赖 ES 模块原生 `import.meta.main`）。
2. **Pi CLI 1.3.0**：安装并完成 `@earendil-works/pi-coding-agent` 的模型认证，确保 `pi` 位于 `PATH` 中；本项目仅针对该版本的公开 Extension API。
3. **[Herdr](https://herdr.dev)**：必需，确保 `herdr` 位于 `PATH` 中。Herdr server 必须已运行且可达；网关不会自动启动它。
4. **Telegram Bot Token 与 User ID**：
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

Lint（ESLint 安全与可读性规则）：

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

### 4. 安装 Pi 扩展

macOS 安装脚本会自动维护此软链。前台/Linux 使用时，在仓库根目录执行：

```bash
mkdir -p ~/.pi/agent/extensions
ln -sfn "$PWD/remote-pi.ts" ~/.pi/agent/extensions/remote-pi.ts
```

这也会替换已有软链的旧目标；不要覆盖该路径下无关的普通文件。更新扩展后，在已有 Pi 实例中使用 Pi 原生 `/reload` 重新加载。

### 5. 启动网关

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
pi-remote-gateway restart  # 代码更新后重启服务生效
pi-remote-gateway logs     # 持续跟踪日志输出 (tail -f)
pi-remote-gateway stop     # 停止后台服务
```

---

## 配置项参考

配置文件默认路径为 `~/.config/remote-pi/config.json`，也可以通过环境变量 `REMOTE_PI_CONFIG` 自定义。

### 核心配置

首启时 `telegram.botToken`、`telegram.allowedUserId` 和 `cwd` 为必填项（cwd 缺失或目录无效会在启动时快速报错）。运行期 pane/session 绑定及 Topic 工作目录保存在 `state.json`（`~/.local/var/remote-pi/state.json`）中，保持 `config.json` 纯净只读。使用 `/topic <路径>` 处理其他项目。

| 配置键 | 对应环境变量 | 默认值 | 详细说明 |
| :--- | :--- | :--- | :--- |
| `telegram.botToken` | - | *必填* | BotFather 生成的 Telegram Bot Token |
| `telegram.allowedUserId` | - | *必填* | 允许访问的 Telegram 纯数字用户 ID |
| `cwd` | - | *首次启动必填* | Pi 启动时的初始工作目录；除非 `state.json` 中已记录，否则必填（支持 `~/` 展开；运行期切换由 `state.json` 记录） |

### 进阶选项（开箱即用默认值）

| 配置键 | 对应环境变量 | 默认值 | 详细说明 |
| :--- | :--- | :--- | :--- |
| `sttCommand` | - | `""` | 语音转写命令（详见下方语音转写示例） |
| `stateDir` | - | `~/.local/var/remote-pi` | 网关状态、下载附件、实例锁与 `bridge.sock` 的存放目录；Pi 会话仍使用原生目录 |
| `logFile` | `REMOTE_PI_LOG_FILE` | `~/.local/var/log/remote-pi.log` | 网关运行日志输出路径 |
| `presenceFile` | - | `""` | 桌面在线标记文件；存在时最终回复、提问及 blocked 提醒均静音。支持 `~/`，可由屏幕锁屏/解锁钩子管理 |

下载文件固定保留 30 天，启动时及每 24 小时清理。Telegram 使用 25 秒长轮询、35 秒请求超时，失败后采用带抖动的指数退避。

> **环境变量**：仅 `REMOTE_PI_CONFIG`（配置路径）与 `REMOTE_PI_LOG_FILE`（日志路径）可覆盖网关配置。模型、凭据、信任与额外扩展由 Pi 自身管理。

---

## 进阶玩法

### Topics / 并行多会话

网关支持通过 Telegram 私聊 Topics（Telegram Bot API 9.3+）同时运行多个相互独立的 Pi 会话，实现手机端多项目并行开发。

1. **在 @BotFather 中开启 Topic 模式**：
   - 在 Telegram 打开 [@BotFather](https://t.me/BotFather)。
   - 点击 **Open** 打开 BotFather Mini App → 选择你的 Bot → **Bot Settings** → **Threads Settings** → 开启 **Threaded Mode**（经典 `/mybots` 文字菜单里没有这个选项）。
2. **创建 Topic 会话**：
   - 发送 `/topic [路径]` 为指定项目目录创建独立 Topic；不带参数则复用当前会话的工作目录。
   - 每个新建 Topic 都会在独立的 Herdr 窗格/工作区内启动交互式 Pi；会话保存在 Pi 原生目录，不另设 Telegram 历史目录。
3. **会话管理**：
   - 使用 `/topic <路径>` 为其他项目创建独立 Topic。手动打开的 Topic 继承主会话的工作目录。
   - `/close` 确认后删除 Topic。关闭网关创建的 Pi 的最后一个视图时，Pi 退出并关闭窗格；桌面附加的 Pi 仅断开远程控制并继续运行。
   - `/status` 显示当前视图的模型、会话、上下文用量及费用。
   - 网关不会因空闲或全局并发上限停止 Pi；若 Pi 已退出至 Shell，下次手机消息会在同一窗格恢复原会话。

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

### 同一会话，任意设备（One session, any device）

- **从手机开始**：在 Telegram 对话，或通过 `/topic [路径]` 创建 Topic。网关在 Herdr 窗格中启动真正的交互式 Pi；回到桌面直接在该窗格输入即可。`/new` 重置的是双方共享的会话，不是另一份手机进程。
- **从桌面开始**：在任意 Pi 窗格运行 `/remote-control`（或 `/remote-control on|off|status`）。未知窗格会获得专属 Telegram Topic，以 Pi 会话名称命名（`📡 <session_name>`，回退至首条用户指令或目录名）；请先在 @BotFather 开启 Threaded Mode。首条静音消息会自动回填最近一轮对话预览（`👤 …` / `🤖 …`），通过 `/name` 或在 Pi 内重命名会话会自动同步至 Topic 标题（`editForumTopic`）。Herdr 原生 metadata token `remote_pi=on` 在扩展/会话重载期间保留开关，Pi 退出时清除。桥接连接期间，Pi TUI 底部状态栏显示 `📱 remote`（断线重连中显示 `📱 reconnecting…`）。从 Telegram 关闭桌面 Topic 仅断开远程控制并提示终端用户，绝不终止 Pi 进程。
- **双向同步**：手机指令原生显示在 Pi TUI；桌面输入在 Telegram 显示为 `🖥 <text>`。指令通过 socket 与 Pi 原生输入 API 传递，不使用终端按键模拟或会话日志抓取。终端发起的回复始终静音；没有文本回复时不额外发送占位消息。
- **恢复会话而不创建第二个写入者**：`/resume` 经连接的 Pi 调用公开 `SessionManager.list`，使用 Pi 当前原生会话目录，列出当前 cwd 最近修改的 12 个会话。如果会话已在其他窗格运行，网关提供将 Topic 指向该窗格的按钮，不再启动另一个 Pi 读写同一文件。
- **提问与审批**：`remote_ask` 同时出现在两个视图，先回答的一端使另一端关闭。其他扩展的 TUI 对话仍留在终端；Herdr 待确认通知仅附屏幕末尾内容及 `⏎ Enter` / `⎋ Esc` 控件。
- **生命周期**：网关（重）启动只重新附加仍在运行的 Pi 窗格，绝不自行启动新 Pi；若没有正在运行的 Pi，第一条消息才会启动它。扩展自动重连并恢复已保存的视图绑定。Pi 退出至 Shell 后，下次手机指令在同一窗格恢复。关闭桌面附加的 Topic 绝不会终止该 Pi。
- **待确认提示**：绑定会话工作期间每 3 秒轮询 Herdr 原生 agent 状态；仅为进入 blocked 状态的绑定窗格发送屏幕末尾预览及 Enter/Esc 按钮，已有 `remote_ask` 对话时不重复提醒。发送按键前会重新检查 blocked 状态。

**Pi 1.3.0 公开 API 限制**：不支持检查或清空原生队列，也不支持自动重试开始/结束通知。压缩及 agent 生命周期事件正常转发。

---

## 架构简述

```text
[ Telegram 客户端 ]
       ↕ HTTPS 长轮询 / 草稿 / 最终消息 / 状态表情 / 回调
[ gateway.mjs ] — 路由与流式渲染
       ↕ JSON lines，经 <stateDir>/bridge.sock（Unix socket，权限 0600）
[ Herdr 窗格：交互式 Pi + remote-pi.ts ] ↔ [ 桌面终端 ]
       ↕ Pi 公开 Extension API / 原生 CLI
[ 本地工作区与系统工具 ]
```

- **一个持有者，多个视图**：每个会话属于一个交互式 Pi 进程。`state.json` 保存 pane/session 绑定；原生 Pi 会话文件仍位于 `~/.pi/agent/sessions`（可由 Pi 原生目录环境变量覆盖）。
- **原生生命周期**：Herdr 负责创建窗格、启动 agent；Pi 负责指令、模型、压缩与会话替换。网关用 `PaneRpc` 保留 RPC 形状的客户端接口，不再通过子进程 RPC 模式另起 Pi。
- **常驻与电源管理**：macOS 下 launchd 使用 `/usr/bin/caffeinate -s -i -- node gateway.mjs`，防止接通电源时的空闲睡眠，同时保留手动睡眠与合盖行为。
- **参考**：[Pi Extension API](https://pi.dev/docs/latest/extensions)（实现以本机 Pi 1.3.0 为准）、[Herdr CLI](https://herdr.dev/docs/cli-reference/) 与 [Herdr 集成](https://herdr.dev/docs/integrations/)。

---

## 安全须知

1. **权限等同本机用户**：控制了该 Telegram Bot 即等同于获得了该电脑上的完整 Shell 运行与文件读写权限。
2. **严禁将 Bot 拉入任何群聊**：本项目针对 1 对 1 私聊设计，即便有白名单过滤，将具有命令执行能力的 Bot 置于公开群聊环境仍存在极大的误触与安全攻击面。
3. **保护配置文件权限**：`~/.config/remote-pi/config.json` 包含 Bot Token，应严格维持 `600` 文件权限（仅当前系统用户可读写）。
4. **日志隐私与权限**：运行日志（`~/.local/var/log/remote-pi.log`）权限设为 `600`，且仅记录无敏感内容的元数据（消息类型、字符数与工具名称，不记录消息正文与工具参数）。

---

## License

[MIT](LICENSE) © 2026 Yunpeng Pan
