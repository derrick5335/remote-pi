# remote-pi

Telegram Bot gateway for Pi RPC. No SSH, public port, VPS, Herdr, or npm dependencies.

## Setup

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy its token.
2. Send the new bot `/start` once.
3. Get your numeric Telegram user ID without a third-party bot:

   ```bash
   read -s TOKEN
   curl -s "https://api.telegram.org/bot${TOKEN}/getUpdates" |
     python3 -c 'import json,sys; print(json.load(sys.stdin)["result"][-1]["message"]["from"]["id"])'
   unset TOKEN
   ```

4. Install and start the launchd service:

   ```bash
   cd /Users/user/dev/remote-pi
   chmod +x install.sh gateway.mjs
   ./install.sh
   ```

The installer stores the token in `~/.config/remote-pi/config.json` with mode `600`. Pi runs in this repository with the existing `~/.pi/agent` configuration. Gateway sessions are persisted separately under `~/.local/var/remote-pi/sessions` so desktop and Telegram Pi processes never write the same session.

## Commands

Send normal text to prompt Pi. Messages sent while Pi is working become steering messages.

- `/help`, `/commands`, `/cwd`（切换 `~/dev` 下的项目，热重载 Pi 子进程）
- `/sh <命令>`（直接在项目目录执行 Shell，0 Token 秒级响应）
- `/get <相对路径>`（下载项目文件或导出产物）
- `/followup <消息>`（排队追加后续任务，不打断当前轮次）
- `/model`, `/thinking`
- `/resume`, `/new`, `/name`, `/session`, `/fork`, `/clone`
- `/compact`, `/export`, `/abort`（停止当前任务，排队消息保留；`/abort clear` 连队列清空）, `/queue`
- Extension commands and prompt templates
- Skills appear in Telegram as `/skill_name`; manual `/skill-name` is also accepted and mapped to Pi's `/skill:name`

Telegram 发送的图片、文件、视频、语音均可作为上下文：文件保存到 `~/.local/var/remote-pi/downloads` 并把路径写进 Prompt，图片同时内联给模型，无大小限制（Telegram Bot API 上限 20MB）。语音消息支持 STT 转写：在 `~/.config/remote-pi/config.json` 配置 `"sttCommand"`（bash 命令，`$1` 为音频文件路径，stdout 即转写文本），例如 Groq Whisper：

```json
{
  "sttCommand": "curl -s https://api.groq.com/openai/v1/audio/transcriptions -H 'Authorization: Bearer $GROQ_API_KEY' -F file=@$1 -F model=whisper-large-v3-turbo -F response_format=text"
}
```

未配置 `sttCommand` 时语音仅落盘。模型还可主动使用两个 Telegram 工具（由同目录的 `telegram-extension.mjs` 提供，Gateway 自动以 `-e` 加载）：`telegram_attach` 把本地文件作为附件发到聊天（让 Pi 主动交付产物）；`telegram_ask` 用内联按钮向用户提问。Agent replies are rendered as safe Telegram HTML (headings, lists, quotes, links, inline code, fenced code, bold, italic, and strikethrough), with plain-text fallback for malformed input. Only the configured user in a private chat is accepted.

## Streaming & UI

助手回复用 Telegram 原生流式草稿（`sendMessageDraft`，聊天中可直接点停止按钮中止生成），API 不支持时自动回退为静音预览消息 + 编辑。工具面板、队列提示等中间消息全部静音（`disable_notification`），只有最终回复会响铃。

- **消息即时反馈（Reaction ACK）**：收到用户消息时，Bot 立即在原消息贴上“已接收”表情（默认 `👀`，消除等待焦虑）；任务或命令完成后，在同一条消息上添加或更新为“完成”表情（默认 `👍`）。可通过配置文件或环境变量 `TELEGRAM_ACK_EMOJI` 与 `TELEGRAM_DONE_EMOJI` 自定义。
- **可折叠长输出（Expandable Blockquote）**：支持 Telegram 7.2+ 原生可折叠引用块。`/sh` 执行结果超过 3 行时自动折叠显示，工具面板操作步骤也会自动折叠，保持手机端界面清爽。

## Service

```bash
pi-telegram-gateway start
pi-telegram-gateway stop
pi-telegram-gateway restart
pi-telegram-gateway status
pi-telegram-gateway logs
```

Run the offline self-check:

```bash
node gateway.mjs --self-test
```

## Power behavior

The LaunchAgent runs `caffeinate -s -i -- node gateway.mjs`: it prevents idle sleep and keeps Dark Wake active while connected to power, while leaving lid-close and manual sleep intact. `KeepAlive` starts it at user login, restarts crashes, and restores it after wake; Telegram polling retries stale network connections.

## Security

Telegram Bot chats are not end-to-end encrypted. Anyone controlling the allowed Telegram account can instruct Pi, which has the same filesystem and command privileges as the local user. Keep two-factor authentication enabled and never add the bot to a group.
