# remote-pi

> 通过 Telegram 远程操作 [Pi](https://github.com/mariozechner/pi-coding-agent) coding agent 的轻量网关。

随时随地在手机 Telegram 上向本机的 Pi 编程助手发送需求、排队任务、查看工具调用进度与流式输出，并接收生成产物。

---

## 平台与支持范围

- **聊天平台**：**当前仅支持 Telegram**。网关针对 Telegram Bot API 进行了深度优化（包括 `sendMessageDraft` 流式草稿实时预览、内联按钮交互、多模态附件解析与单用户消息队列）。
- **运行环境**：
  - **macOS**：提供开箱即用的 `./install.sh` 脚本，基于 launchd 常驻运行并使用 `caffeinate` 防睡眠。
  - **Linux**：支持直接前台运行或通过 systemd 自行托管。

---

## 核心特性

- ⚡ **单文件极简核心**：除 `markdown-it` 用于 Telegram HTML 格式渲染外，全部基于 Node.js 标准库实现，无重型框架包袱。
- 🌊 **原生流式输出**：优先利用 Telegram 官方流式草稿（`sendMessageDraft`）实时展示思考过程与回复；遇 API 限制时自动回退为静音消息编辑。
- 🛠️ **可折叠工具面板**：模型调用工具时以原生可折叠引用块（Expandable Blockquote）呈现执行状态，不刷屏。
- 🎙️ **多模态上下文**：
  - **语音转写**：可配置 `sttCommand`（如 whisper / mlx-whisper），在 Telegram 发送语音即可自动转写为 Prompt。
  - **视觉与附件**：直接发送图片或文件（PDF、代码、音视频），网关自动下载到本地并作为当前轮次的上下文传给 Pi。
- 🔌 **扩展（Extensions）与工具增强**：
  - 自带 Companion Extension（`telegram-extension.mjs`），向模型注入 `telegram_attach`（向用户回传本地文件）和 `telegram_ask`（内联按钮问答）两个工具。
  - 支持配置加载用户自定义的 Pi 扩展（`-e` 注入），并支持在 Telegram 中交互响应 Extension 的 UI 事件（`ctx.ui.select` / `ctx.ui.confirm` / `ctx.ui.input`）。
- 🔒 **单实例与安全控制**：基于 Unix Domain Socket 的互斥锁，杜绝多实例竞争导致会话混乱；严格的单用户白名单机制，忽略群聊与未授权访问。

---

## 常用命令

| 命令 | 说明 |
| :--- | :--- |
| 直接发文字 | 与 Pi 对话；任务执行中发送文字会作为 steer（实时干预） |
| `/cwd` | 查看当前工作目录，或在配置的 `devRoot` 下切换项目 |
| `/model [关键词]` | 查看可用模型列表或直接搜索切换 |
| `/thinking [level]` | 查看或设置模型的思考级别（如 `off`, `low`, `high`） |
| `/new` | 开启全新会话，重置上下文并汇报环境状态 |
| `/resume` | 弹出最近历史会话列表供选择恢复 |
| `/sh <shell 命令>` | 在当前工作目录下直接执行系统 Shell 命令并返回结果 |
| `/get <文件路径>` | 将当前项目中的文件作为附件下载到 Telegram |
| `/followup <指令>` | 排队追加后续任务指令 |
| `/session` 或 `/status` | 查看当前会话 ID、模型、上下文消耗比例及费用 |
| `/compact [要求]` | 主动触发上下文压缩与总结 |
| `/fork` | 从历史用户消息创建分支会话 |
| `/abort` | 立即中断当前正在运行的 Agent 任务 |
| `/help` | 显示完整的指令帮助 |

---

## 环境准备

1. **Node.js**：需要 **>= 22.18.0**（推荐 Node 24 LTS，依赖 ES 模块原生 `import.meta.main`）。
2. **Pi CLI**：确保已安装并登录 Pi 编码助手（如 `@mariozechner/pi-coding-agent`），在终端中可直接执行 `pi` 命令。
3. **Telegram Bot**：
   - 在 Telegram 中联系 [@BotFather](https://t.me/BotFather) 创建 Bot 并获取 **Bot Token**（格式类似 `123456789:ABCdefGh...`）。
   - 联系 [@userinfobot](https://t.me/userinfobot) 获取你自己的 **纯数字 User ID**。

---

## 快速上手

### 1. 克隆与安装依赖

```bash
git clone https://github.com/your-username/remote-pi.git
cd remote-pi
npm install --omit=dev
```

### 2. 离线自检

运行离线单元自检，验证环境与解析逻辑：

```bash
npm test
# 或者: node gateway.mjs --self-test
```
输出 `self-test: ok` 即表示测试通过。

### 3. 配置

复制配置模板：

```bash
mkdir -p ~/.config/remote-pi
cp config.example.json ~/.config/remote-pi/config.json
chmod 600 ~/.config/remote-pi/config.json
```

编辑 `~/.config/remote-pi/config.json`，填入你的 `botToken` 与 `allowedUserId`：

```json
{
  "botToken": "123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ",
  "allowedUserId": "123456789",
  "cwd": "/path/to/your/workspace",
  "devRoot": "~/dev"
}
```

### 4. 运行服务

#### 方式 A：前台直接运行（开发 / Linux / 调试）

```bash
npm start
# 或者: node gateway.mjs
```

#### 方式 B：macOS launchd 常驻后台（推荐）

本项目自带安装脚本，将 gateway 注册为 launchd 用户守护进程，并在崩溃时自动拉起：

```bash
./install.sh install
```

安装后可通过快捷命令管理守护进程：

```bash
pi-telegram-gateway status   # 查看运行状态与近期日志
pi-telegram-gateway restart  # 代码或配置修改后重启
pi-telegram-gateway logs     # 持续跟踪运行日志
pi-telegram-gateway stop     # 停止守护进程
```

---

## 配置项详解

配置文件路径默认为 `~/.config/remote-pi/config.json`（可通过环境变量 `REMOTE_PI_CONFIG` 覆盖）。

| 配置键 | 环境变量 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `botToken` | `TELEGRAM_BOT_TOKEN` | *必填* | Telegram BotFather 提供的 Bot Token |
| `allowedUserId` | `TELEGRAM_ALLOWED_USER_ID` | *必填* | 允许访问的 Telegram 纯数字用户 ID |
| `cwd` | `PI_CWD` | 当前执行目录 | Pi 子进程启动时的工作目录（支持 `~/` 展开） |
| `devRoot` | `DEV_ROOT` | `~/dev`（若存在） | 项目根目录，用于 `/cwd` 命令列出一级子项目进行切换。若不需要可设为 `null` |
| `piBin` | `PI_BIN` | `"pi"` | Pi CLI 可执行文件路径 |
| `approve` | - | `true` | 是否向 Pi 传递 `--approve`（自动批准工具调用） |
| `enableCompanionExtension` | `REMOTE_PI_COMPANION_EXTENSION` | `true` | 是否自动挂载自带的 `telegram-extension.mjs` 扩展（提供 `telegram_attach` 与 `telegram_ask` 工具） |
| `extensions` | `REMOTE_PI_EXTENSIONS` | `[]` | 额外注入 Pi 的自定义扩展文件路径数组（支持 `~/` 及相对配置文件的路径） |
| `sttCommand` | - | `""` | 语音转写命令，例如 `"mlx_whisper --model mlx-community/whisper-large-v3-turbo $1"` |
| `stateDir` | - | `~/.local/var/remote-pi` | 会话状态、下载附件与套接字锁的存放目录 |
| `logFile` | `REMOTE_PI_LOG_FILE` | `~/.local/var/log/remote-pi.log` | 网关运行日志输出文件 |
| `ackEmoji` | `TELEGRAM_ACK_EMOJI` | `"👀"` | 收到消息时的反馈表情 |
| `doneEmoji` | `TELEGRAM_DONE_EMOJI` | `"🫡"` | 消息处理完成时的反馈表情 |

> **提示**：环境变量会优先覆盖配置文件中的对应设置。对于 `REMOTE_PI_EXTENSIONS`，支持传入 JSON 数组字符串（如 `'["/path/ext1.ts"]'`）或逗号分隔的路径列表。

---

## 架构与原理

```
[ Telegram App ]
       ↕ (HTTPS Long Polling / SendMessageDraft / Media / Callbacks)
[ gateway.mjs ] (Single Node.js Process, stdlib + markdown-it)
       ↕ (JSON-RPC over stdio / Unix Domain Socket Lock)
[ pi --mode rpc ]
       ↕ (-e companion & custom extensions)
[ Host Filesystem & Tools ]
```

1. **Telegram 通信**：`gateway.mjs` 采用长轮询接收 Telegram Update，单用户白名单过滤；向用户发送消息时结合 Markdown 格式化、超长分页截断与草稿流式预览。
2. **RPC 驱动**：通过 `child_process.spawn` 启动 `pi --mode rpc --continue` 独立子进程，通过标准输入输出传输 JSON-RPC 消息。
3. **伴侣扩展**：自动加载的 `telegram-extension.mjs` 为模型补充移动端聊天所需的工具（回传文件、按钮选择）；用户如果需要加载自己的扩展，只需在 `extensions` 数组中添加路径即可。

---

## 安全须知

1. **权限等同本机用户**：控制了 Telegram Bot 即获得了在你电脑上运行代码与 Shell 命令的权限。
2. **严禁加入群组**：本项目仅针对私聊（Private Chat）设计。切勿将你的 Bot 加入任何 Telegram 群组，以免他人利用 Bot 窃取或篡改本机数据。
3. **妥善保管 Token**：配置文件 `~/.config/remote-pi/config.json` 包含 Bot Token，应确保文件权限设置为 `600`（`chmod 600 config.json`），切勿提交到公开代码仓库。

---

## License

[MIT](LICENSE)
