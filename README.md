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
- `/resume`, `/new`, `/name`, `/session`, `/history`, `/tree`, `/fork`, `/clone`
- `/compact`, `/export`, `/abort`（清空待办队列并紧急刹车）, `/queue`
- Extension commands and prompt templates
- Skills appear in Telegram as `/skill_name`; manual `/skill-name` is also accepted and mapped to Pi's `/skill:name`

Telegram 图片与原图文档均自动转为图片 Prompt，支持直接发送文本/代码文件（`< 500KB`）作为上下文。Agent replies are rendered as safe Telegram MarkdownV2 (headings, lists, quotes, links, inline code, fenced code, bold, italic, and strikethrough), with plain-text fallback for malformed input. Only the configured user in a private chat is accepted.

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

The LaunchAgent runs `caffeinate -i -- node gateway.mjs`: it prevents idle sleep while leaving lid-close and manual sleep intact. `KeepAlive` starts it at user login, restarts crashes, and restores it after wake; Telegram polling retries stale network connections.

## Security

Telegram Bot chats are not end-to-end encrypted. Anyone controlling the allowed Telegram account can instruct Pi, which has the same filesystem and command privileges as the local user. Keep two-factor authentication enabled and never add the bot to a group.
