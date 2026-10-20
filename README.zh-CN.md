<p align="right">
  <a href="README.md">English</a> | <b>简体中文</b>
</p>

<h1 align="center">telegram-herdr-pi</h1>

<p align="center">
  <b>用 Telegram 驱动你电脑上、运行在 <a href="https://herdr.dev">Herdr</a> 里的 <a href="https://pi.dev">Pi</a> 编码 agent。</b><br>
  一个会话，两个视图：桌上的终端和手机上的 Telegram 聊天。不需要公网 IP、SSH 隧道或云端中转。
</p>

<p align="center">
  <img src="https://img.shields.io/badge/node-%3E%3D22.18.0-brightgreen.svg" alt="Node.js >= 22.18.0">
  <img src="https://img.shields.io/badge/Pi-1.3.0-blueviolet.svg" alt="Pi 1.3.0">
  <img src="https://img.shields.io/badge/requires-Herdr-orange.svg" alt="Requires Herdr">
  <img src="https://img.shields.io/badge/chat-Telegram-26A5E4.svg" alt="Telegram">
  <img src="https://img.shields.io/badge/license-MIT-green.svg" alt="MIT License">
</p>

---

## 这是什么

telegram-herdr-pi 把一个 Telegram bot 接到你在 Herdr 窗格里运行的交互式 Pi 上。Pi 始终在你的电脑上运行，使用你本机的文件、工具和凭据；Telegram 只是同一个会话的另一个窗口——相当于 Pi 版的 Claude Code Remote Control。

- **桌前开始，手机继续。** 在任意 Pi 窗格里执行 `/remote-control`，这个会话就会出现在一个独立的 Telegram Topic 里。
- **手机上开始。** 发送 `/topic ~/dev/my-app`，网关会在新的 Herdr workspace 里启动一个真正的 Pi；回到电脑前，直接在那个窗格里接着输入。
- **永远只有一个写入者。** 每个会话只属于一个交互式 Pi 进程，网关只是把视图挂上去，绝不会对同一个会话文件再启动第二个 Pi。

```text
 Telegram（手机）             你的电脑
 ┌──────────────┐   HTTPS   ┌────────────────────┐  bridge.sock  ┌──────────────────────────┐
 │ 聊天 / Topic │◄─────────►│ gateway.mjs        │◄─────────────►│ Herdr 窗格：交互式       │
 │ 草稿、👀👌   │  长轮询   │（launchd 服务）    │  JSON lines   │ Pi + remote-pi.ts        │◄── 你的终端
 └──────────────┘           └────────────────────┘               └──────────────────────────┘
```

## 亮点

- 🖥️↔📱 **同一个会话** —— 手机发的提示会出现在真实的 Pi 终端界面里；桌前输入的提示会以 `🖥 …` 同步到 Telegram。提示走 Pi 的公开 API，从不模拟按键，也不抓取会话记录。
- 🌊 **实时草稿** —— Pi 工作时可以看到实时预览、当前工具（`⚙️ bash: npm test`）和 Telegram 原生的**停止**按钮，最终回答以普通消息送达。
- 👀 **状态一眼可见** —— 你发的消息上依次显示 `👀` 已收到 → `👨‍💻` 处理中 → `👌` 完成（`💔` 出错，`🤷` 没有文字回复）。
- 🔔 **默认安静** —— 只有从 Telegram 发起的任务完成，或有问题需要你回答时，手机才会响。中间回复和终端发起的任务都静音；你在桌前时（`presenceFile`）一律不响。
- ❓ **在哪都能回答** —— `remote_ask` 的提问在 Telegram 里是按钮，在终端里是选择框，先回答的一方生效。Pi 卡在其他扩展的对话框时，你会收到屏幕末尾的内容和 `⏎ Enter` / `⎋ Esc` 按钮。
- 📎 **丰富的输入** —— 照片作为图片直接给模型，文件保存到本地后把路径交给 Pi，相册合并成一条提示，语音用你自己的 `sttCommand` 转写。Pi 可以用 `remote_attach` 把文件发回给你。
- 🧵 **并行工作** —— 每个 Pi 会话一个 Telegram Topic；`/topic`、`/close`、`/new`、`/resume`、`/model` 都能在手机上用。
- 🛡️ **健壮** —— 网关重启、网络中断都不怕（扩展自动重连，正在输出的内容和待答提问都会恢复）；按 Herdr 的 `terminal_id` 绑定终端，窗格 ID 被复用也不会接错窗格；只接受白名单里的一个用户。
- 🪶 **小而原生** —— 总共约 2000 行，唯一的运行时依赖是 `markdown-it`；只使用 Pi 1.3.0 的公开扩展 API 和 Herdr 的 socket API。

## 运行要求

- macOS（自带 launchd 服务安装）或 Linux（前台运行或用 systemd 托管）
- [Node.js](https://nodejs.org) ≥ 22.18.0
- [Pi](https://pi.dev) 1.3.0（`@earendil-works/pi-coding-agent`），已登录，`pi` 在 `PATH` 中
- [Herdr](https://herdr.dev)，服务端已在运行，`herdr` 在 `PATH` 中（网关不会替你启动 Herdr）
- 从 [@BotFather](https://t.me/BotFather) 获取的 bot token，以及你的 Telegram 数字用户 ID

## 快速开始

**1. 安装**

```bash
git clone https://github.com/derrick5335/telegram-herdr-pi.git
cd telegram-herdr-pi
npm install --omit=dev
npm test            # 离线自检，输出 "self-test: ok"
```

**2. 设置 bot** —— 在 @BotFather 里打开 Mini App（**Open**）→ 你的 bot → **Bot Settings** → **Threads Settings**：

- 开启 **Threaded Mode**（私聊里的 Topic）；
- 建议开启**禁止用户创建和删除 Topic** 的选项。Telegram 不会通知 bot 某个 Topic 被删除了，所以让 bot 来管理 Topic 的生命周期：用 `/topic` 创建，用 `/close` 删除。

查自己的用户 ID：先给 bot 发一条消息，然后运行：

```bash
read -s TOKEN && curl -s "https://api.telegram.org/bot${TOKEN}/getUpdates" | \
  node -e 'd=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(d.result?.at(-1)?.message?.from?.id)'; unset TOKEN
```

**3. 安装服务（macOS）**

```bash
./install.sh install
```

安装脚本会询问 bot token 和用户 ID，写入 `~/.config/remote-pi/config.json`（权限 600；`cwd` 初始为仓库目录，请改成你的项目），把 Pi 扩展链接到 `~/.pi/agent/extensions/remote-pi.ts`，并注册 launchd 服务。之后用下面的命令管理：

```bash
pi-remote-gateway status | logs | restart | stop | start | uninstall
```

Linux 上请手动创建配置（见[配置](#配置)），用 `ln -sfn "$PWD/remote-pi.ts" ~/.pi/agent/extensions/remote-pi.ts` 链接扩展，然后运行 `npm start`。

**4. 开始使用** —— 给 bot 发任意消息即可。之前已经在运行的 Pi 窗格，执行一次 Pi 的 `/reload` 就能加载扩展。

> 为了兼容已有安装，管理命令 `pi-remote-gateway`、扩展文件 `remote-pi.ts`，以及 `~/.config/remote-pi`、`~/.local/var/remote-pi` 这些路径都保留原来的名字。

## 使用

### 在桌前

在任意运行于 Herdr 窗格中的 Pi 里执行：

```text
/remote-control [on|off|status]
```

这个会话会得到一个专属的 `📡` Topic，并附上最近一问一答作为预览；Pi 底栏显示 `📱 remote`。这个开关在 `/reload` 和切换会话后依然保留。`/remote-control off`，或在 Topic 里执行 `/close`，都只会断开 Telegram，你的 Pi 会继续运行。

### 在手机上

- 主聊天里的文字驱动主会话（收到第一条消息时，才在新的 Herdr workspace 里启动）。
- Pi 工作时发送的消息会调整当前这一轮；`/followup` 则把消息排到这一轮之后。
- `/topic [path]` 为某个项目在独立的 Topic 和 Herdr workspace 里再启动一个 Pi；`/close` 会退出它并关闭窗格。
- `/new` 在**同一个 Pi** 里开始新会话（同一个窗格，终端也会同步切换）；`/resume` 列出这个 workspace 的历史会话，并且绝不会去打开一个已经在别处运行的会话。

### 命令

| 命令 | 作用 |
| :--- | :--- |
| *文字、照片、文件、语音* | 向 Pi 发送提示；Pi 工作时用来调整当前这一轮 |
| `/topic [path]` | 新建一个带独立 Pi 的 Topic（默认使用当前 workspace） |
| `/close` | 关闭当前 Topic：网关启动的 Pi 会退出并关闭窗格，桌面接入的 Pi 只断开 |
| `/new` | 在同一个 Pi 里开始新会话，保留当前模型 |
| `/resume` | 从这个 workspace 最近的 12 个会话里选一个 |
| `/model [query]` · `/thinking [level]` | 切换模型 / 思考等级 |
| `/status` | 模型、上下文用量、费用和会话文件 |
| `/compact [focus]` | 压缩上下文 |
| `/abort` | 停止当前任务（不排队，立即执行）；点草稿上的停止按钮效果相同 |
| `/followup <text>` | 把一条提示排到当前这一轮之后 |
| `/name <name>` | 给会话命名（Topic 标题同步更新） |
| `/sh <command>` | 在 workspace 里直接执行 shell 命令，不经过模型 |
| `/restart` | 重启网关（不排队，立即执行）；Pi 继续运行 |
| `/help` · `/start` | 帮助，以及 Pi 自身的扩展、提示模板和技能命令 |

其他任何 `/命令` 都会转给 Pi 里同名的原生命令（Telegram 命令名会转成小写，`-` 变成 `_`，最多 32 个字符）。有歧义的命令名会直接拒绝，不做猜测。

### 通知

| 事件 | 是否响铃 |
| :--- | :--- |
| 从 Telegram 发起的任务给出最终回答 | ✅（你在桌前时除外） |
| `remote_ask` 提问、Pi 卡在对话框 | ✅（你在桌前时除外） |
| 中间回复、工具进度、草稿 | 🔕 |
| 从终端发起的任务 | 🔕 |

“在桌前”指 `presenceFile` 存在——可以用解锁屏幕的钩子创建它，锁屏时删除。

## 配置

`~/.config/remote-pi/config.json`（可以用 `REMOTE_PI_CONFIG` 指定其他路径）：

```json
{
  "telegram": { "botToken": "123456789:ABC…", "allowedUserId": "123456789" },
  "cwd": "~/dev/my-project",
  "sttCommand": "",
  "presenceFile": "~/.local/var/remote-pi/present"
}
```

| 配置项 | 默认值 | 含义 |
| :--- | :--- | :--- |
| `telegram.botToken` | 必填 | @BotFather 给的 bot token |
| `telegram.allowedUserId` | 必填 | bot 唯一会响应的 Telegram 用户 |
| `cwd` | 首次运行必填 | 主会话的 workspace（支持 `~/`） |
| `sttCommand` | `""` | 语音转写命令；音频路径作为 `$1` 传入，命令输出转写后的文字 |
| `presenceFile` | `""` | 这个文件存在期间，一律不响铃 |
| `stateDir` | `~/.local/var/remote-pi` | 网关状态、下载文件（保留 30 天）、实例锁和 `bridge.sock` |
| `logFile` | `~/.local/var/log/remote-pi.log` | 日志文件（也可用 `REMOTE_PI_LOG_FILE` 指定）；只记录不含内容的元数据 |

语音转写示例：Groq Whisper `curl -s https://api.groq.com/openai/v1/audio/transcriptions -H "Authorization: Bearer $GROQ_API_KEY" -F file=@$1 -F model=whisper-large-v3-turbo -F response_format=text`，或本地 Apple Silicon `mlx_whisper --model mlx-community/whisper-large-v3-turbo $1`。

模型、凭据和其他扩展都在 Pi 里配置。

## 安全

- 谁控制了这个 Telegram 账号，谁就能以你的用户权限控制这台电脑——Telegram 聊天不是端到端加密的。只在你自己账号的一对一私聊里使用，永远不要把 bot 拉进群。
- bot 会忽略 `allowedUserId` 以外的所有用户，以及所有非私聊。
- `config.json` 请保持 600 权限。日志和状态目录创建时就是私有的；日志只记录消息类型和长度，从不记录消息正文或工具参数。
- `/sh` 里阻止停止服务的检查只是防误操作，不是安全边界。

## 工作原理

- `gateway.mjs` 长轮询 Telegram，把 Markdown 渲染成 Telegram HTML，并通过私有 Unix socket（`bridge.sock`，权限 600）以 JSON lines 和每个 Pi 通信。输出先以 `sendMessageDraft` 预览流式展示，最后用普通的 `sendMessage` 发出。
- `remote-pi.ts` 是基于 Pi 1.3.0 公开 API 的 Pi 扩展。它转发 Pi 的事件，执行网关的请求（提示、模型、压缩、新建/切换会话……），提供 `/remote-control`、`remote_attach` 和 `remote_ask`，并会自动重连。它的开关状态保存在 Herdr 窗格元数据里（`remote_pi=on`）。
- 进程归 Herdr 管：网关通过 Herdr 的 socket API 创建 workspace、启动 Pi（`agent.start`）、读取屏幕；用窗格元数据打开扩展的远程开关，而不是往 shell 里敲命令；blocked 状态变化由 `events.subscribe` 主动推送；并按 Herdr 的 `terminal_id` 绑定会话。唯一的 CLI 调用是启动时用 `herdr status server --json` 查找 socket。
- 会话归 Pi 管：会话文件留在 Pi 原生的会话目录里；`state.json` 只记录哪个 Topic 在看哪个窗格和会话。
- Pi 1.3.0 公开 API 的已知限制：没有原生的队列查看/清空接口，也没有自动重试事件。

参考：[Pi 扩展](https://pi.dev/docs/latest/extensions)、[Herdr CLI](https://herdr.dev/docs/cli-reference/)、[Telegram Bot API](https://core.telegram.org/bots/api)、[Claude Code Remote Control](https://code.claude.com/docs/en/remote-control)（本项目对标的体验）。

## 开发

```bash
npm install          # 开发依赖：ESLint、TypeScript、Pi 1.3.0 类型
npm test             # node gateway.mjs --self-test —— 离线运行，使用假的 Telegram 和 Herdr，带 60 秒超时保护
npm run lint         # ESLint
npm run typecheck    # 用 @earendil-works/pi-coding-agent@1.3.0 的类型对 remote-pi.ts 做 tsc --noEmit
```

面向贡献者和 agent 的项目规则见 [AGENTS.md](AGENTS.md)。

## 许可证

[MIT](LICENSE) © 2026 Yunpeng Pan
