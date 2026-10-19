<p align="right">
  <b>English</b> | <a href="README.zh-CN.md">简体中文</a>
</p>

# remote-pi

<p align="center">
  <b>A lightweight Telegram Bot gateway for the <a href="https://github.com/mariozechner/pi-coding-agent">Pi</a> coding agent</b><br>
  Control and drive your local or remote development machine directly from Telegram on your phone — no public IP, SSH tunneling, or cloud relays required.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/node-%3E%3D22.18.0-brightgreen.svg" alt="Node.js">
  <img src="https://img.shields.io/badge/platform-Telegram%20Only-blue.svg" alt="Platform">
  <img src="https://img.shields.io/badge/daemon-macOS%20Launchd-orange.svg" alt="macOS Launchd">
  <img src="https://img.shields.io/badge/license-MIT-green.svg" alt="License">
</p>

---

## Scope & Platform Notice

- **Chat Interface**: **Currently Telegram Only**. The gateway is deeply integrated with the Telegram Bot API (leveraging real-time in-place streaming messages via `sendMessage` + `editMessageText`, inline button keyboards, receipt emoji reactions, expandable blockquotes, and media downloads).
- **Supported OS**:
  - **macOS**: Provides an out-of-the-box `./install.sh` script to install the gateway as a persistent launchd daemon, paired with `caffeinate` to keep Pi responsive while connected to power without preventing normal sleep.
  - **Linux**: Can be run directly in the foreground or managed via standard systemd user units.

---

## Key Features

- ⚡ **Lightweight & Minimalist**: Built around a clean, single-file core (`gateway.mjs`) using only the Node.js standard library plus `markdown-it` for Telegram HTML rendering. No heavy frameworks.
-  **Sleep & Wake Self-Healing**: Automatically detects system sleep/wake drift on laptops. Upon lid opening or wake, immediately aborts stale poll sockets and probes network connectivity, restoring the connection in 1–2 seconds instead of hanging on 60-second socket timeouts.
- 🔒 **Clean State & Config Separation**: Follows 12-Factor principles — `config.json` remains strictly immutable. Runtime workspaces, recent projects, and pane/session bindings are tracked in `state.json`; sessions stay in Pi’s native session directory.
- 🎯 **100% Pi-Native**: Uses Pi 1.3.0’s public Extension API, Pi CLI, and Herdr socket API. One interactive Pi process owns each session; Telegram and the terminal are views of that process. No private patches or side-channel files.
- 🌊 **Native Draft Streaming**: Streams thoughts and responses in real time using silent message creation and in-place editing (`sendMessage` + `editMessageText`), eliminating duplicate dialogs, ghost bubbles, and delivery flashes across all clients.
- 🛠️ **Expandable Tool Cards**: Ongoing tool executions (Bash commands, file read/write, grep) are grouped into native collapsible blockquotes (`<blockquote expandable>`) to keep mobile chat clean and readable.
- 📄 **Long Replies as Readable Files**: Final replies longer than `longReplyChars` (default 8000) are delivered as a standalone dark-mode-friendly HTML document (rendered with full CommonMark + GFM tables), with the first chunk kept in chat as a preview. Configure or disable (`0`) via `longReplyChars`; `/export` exports the whole session via Pi's native `pi --export`.
- 🚑 **One-Tap Error Recovery**: Model errors, empty replies and extension failures attach an inline keyboard (1h TTL): retry the last prompt, retry on a fallback model (`fallbackModels`), pick another model, restart a gateway-created Pi (desktop Pi must be restarted in its pane), or view the redacted gateway log — no typing required.
- 🎮 **One Remote-Control Extension**:
  - `remote-pi.ts` provides `remote_attach` (send local files) and `remote_ask` (multiple-choice questions in Telegram and the terminal; first answer wins). Tools are active only while connected.
  - **TUI Footer Status**: Shows persistent `📱 remote` in the Pi TUI footer while the bridge socket is connected, `📱 reconnecting…` while retrying, and clears when remote control is off. Disconnecting from Telegram shows an informational notification.
  - Install other extensions through Pi’s native extension mechanism. Their TUI dialogs are not proxied: blocked notifications show the screen tail with Enter/Esc controls only, without parsing numbered options.
- 🎙️ **Multimodal Context & Voice Transcription (STT)**:
  - **Voice Input**: Configure `sttCommand` (e.g. Groq Whisper API or local Apple Silicon `mlx-whisper`) to convert Telegram voice notes into prompts automatically.
  - **Vision & Attachments**: Send photos (inlined as visual context) or documents, PDFs, and code files (saved locally and passed into context).
- 💬 **Live Steering & Reaction ACK**:
  - Send messages while Pi is working to dynamically steer the agent turn without waiting for it to finish.
  - User messages receive a single receipt reaction (`👀` by default), which stays unchanged. Completion is reported by the run summary card, not another reaction.
- 📊 **Run Summary Card & Quick Actions**: At the end of every run, sends a summary card (`✅ Done · 2m13s · +$0.04 · 12.3k tok · ctx 31%`), listing changed files (`+a −d`). Includes inline action buttons: `📄 Diff` (view inline or download unified diff), `✅ Commit` (streamed conventional commit prompt), and `↩️ Undo run` (interactive restore and cleanup). Terminal-originated runs (`remote_user_input`) and desk-present runs (`presenceFile`) send summary cards silently (`disable_notification: true`).
- 🔒 **Single-Instance Mutex & Strict Whitelist**:
  - Unix domain socket file lock prevents concurrent instances from interfering with the same session.
  - Strict numeric `allowedUserId` whitelist only accepts messages from your private chat; rejects unauthorized users and ignores all group chats.

---

## Commands

| Command | Description |
| :--- | :--- |
| *Plain Text* | Chat with Pi. Messages sent while Pi is working act as live steering instructions |
| `/cwd [path]` | Switch workspace directory (absolute path or `~`-relative; errors if invalid). Without argument, show inline keyboard of up to 20 recently used projects |
| `/topic [path]` | Start a new topic (thread) session for parallel tasks; without argument, uses current workspace |
| `/close` | Close the current topic after confirmation: quit/close gateway-created Pi panes; desktop-attached panes only detach. Delete the topic |
| `/model [query]` | Show inline keyboard to select a model, or switch directly by keyword/ID |
| `/thinking [level]` | View or set model thinking level (e.g. `off`, `low`, `high`) |
| `/new` | Start a fresh session, reset context, and display environment details |
| `/resume` | List sessions for the current workspace from Pi’s native directory; if already open, offer to view the existing pane |
| `/sh <command>` | Execute a shell command directly in the workspace directory (0 tokens, millisecond response). Note: the block on service restart/stop commands here is only an accident guard, not a security boundary — the bot holder already has full shell access |
| `/get <filepath>` | Download a file from the current workspace to Telegram |
| `/followup <prompt>` | Queue a follow-up prompt without interrupting the current agent turn |
| `/git_commit_push [instructions]` | Stage, commit, and push changes with antigravity/gemini-3.8-flash (thinking off), then restore the previous model and thinking level (also accepts `/git-commit-push`) |
| `/status` | Show current session ID, active model, token context usage, and cost |
| `/agents` | Status of every agent in Herdr, grouped by workspace (📱 = Telegram session, 📡 = pushed to Telegram); tap one to see its screen |
| `/compact [focus]` | Trigger context compaction and summarization |
| `/export` | Export the full session as an HTML file (Pi native `pi --export`) and send it as a document |
| `/fork` | Branch the session from a previous user message |
| `/abort` | Stop current agent execution immediately, keeping queued messages |
| `/queue [clear]` | View/reset the gateway’s queue display; Pi 1.3.0 cannot inspect or clear native queues through the public Extension API |
| `/help` | Show help, followed by available extension, prompt template, and skill commands |

### Admin

`/restart` is visible in the Telegram command menu; `/name` and `/upgrade` remain typeable but hidden.

| Command | Description |
| :--- | :--- |
| `/name <name>` | Set the session name |
| `/restart` | Restart the gateway; once ready, update the original notice to “✅ Gateway restarted” |
| `/upgrade` | Self-upgrade the gateway: fast-forward git pull → npm install → offline self-test (auto-rollback on failure) → restart |

> **Tip**: Skills and custom commands installed in Pi are automatically surfaced in Telegram as callable commands (e.g. `/skill_name`). The internal `/remote-pi-new`, `/remote-pi-switch`, and `/remote-pi-fork` bridge commands are hidden from both Telegram command discovery and Pi terminal autocomplete; the gateway can still execute them.

### Custom command routing

- The shared Telegram menu discovers Pi commands from the main view. `/help` lists commands for the current view, including Topic-only commands; those commands can be typed even when absent from the shared menu.
- All gateway command names are reserved, including hidden commands (`/name`, `/upgrade`) and aliases (`/start`, `/commands`). Custom commands cannot replace them or publish a different description under those names.
- [Telegram command names](https://core.telegram.org/bots/api#botcommand) use lowercase letters, digits and underscores, with a 32-character limit. If conversion or truncation makes different Pi names collide, the conflicting menu entry is omitted and `/help` marks it as ambiguous. Sending an ambiguous name returns an error without executing Pi. No automatic renaming is performed; use an unambiguous native spelling, or the Pi terminal.
- Custom command execution always resolves against the current Pi session's command list, not cached aliases from the main view or a previous project. Removed commands return “Unknown command” even if an old menu entry remains visible until the next menu refresh.

---

## Prerequisites

1. **Node.js**: **>= 22.18.0** (Node 24 LTS recommended; relies on native `import.meta.main`).
2. **Pi CLI 1.3.0**: Install and authenticate `@earendil-works/pi-coding-agent`; `pi` must be available on `PATH`. This is the supported public Extension API target.
3. **[Herdr](https://herdr.dev)**: Required; `herdr` must be available on `PATH`. The gateway reuses a running server or starts a headless server when needed, and fails at startup if Herdr is missing.
4. **Telegram Bot Token & Numeric User ID**:
   - Talk to [@BotFather](https://t.me/BotFather) on Telegram and send `/newbot` to create your bot and obtain a **Bot Token**.
   - Get your numeric Telegram User ID (send any message to your new bot, then run):
     ```bash
     read -s TOKEN   # Paste your Bot Token
     curl -s "https://api.telegram.org/bot${TOKEN}/getUpdates" | \
       node -e 'fs=require("fs");d=JSON.parse(fs.readFileSync(0,"utf-8"));console.log(d.result?.slice(-1)[0]?.message?.from?.id)'
     unset TOKEN
     ```

---

## Quick Start

### 1. Clone & Install Dependencies

```bash
git clone https://github.com/derrick5335/remote-pi.git
cd remote-pi
npm install --omit=dev
```

### 2. Run Offline Self-Test

Verify parsing, commands, and core logic without connecting to Telegram:

```bash
npm test
# Outputs "self-test: ok" upon success
```

Lint (ESLint, safety rules only):

```bash
npm run lint
```

### 3. Configure

Copy the configuration template and secure file permissions:

```bash
mkdir -p ~/.config/remote-pi
cp config.example.json ~/.config/remote-pi/config.json
chmod 600 ~/.config/remote-pi/config.json
```

Edit `~/.config/remote-pi/config.json` with your credentials and workspace path:

```json
{
  "telegram": {
    "botToken": "123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ",
    "allowedUserId": "123456789"
  },
  "cwd": "~/dev/my-project"
}
```

### 4. Install the Pi Extension

The macOS installer and `pi-remote-gateway upgrade` manage this link automatically. For foreground/Linux use, run from the repository root:

```bash
mkdir -p ~/.pi/agent/extensions
ln -sfn "$PWD/remote-pi.ts" ~/.pi/agent/extensions/remote-pi.ts
```

This also replaces an older symlink target. Do not overwrite an unrelated regular file at that path. Reload existing Pi instances with Pi’s native `/reload` after updating the extension.

### 5. Start the Gateway

#### Option A: Foreground (Development / Linux / Debugging)

```bash
npm start
# Or: node gateway.mjs
```

#### Option B: macOS launchd Service (Recommended)

Run the included installation script to register a persistent background daemon that starts on login and auto-restarts on crash:

```bash
./install.sh install
```

Manage the service anytime via the installed helper CLI:

```bash
pi-remote-gateway status   # Check service state and recent logs
pi-remote-gateway upgrade  # Self-upgrade: git pull (ff-only) + npm install + self-test + auto-restart
pi-remote-gateway restart  # Restart service after code/config edits
pi-remote-gateway logs     # Tail output log in real time (tail -f)
pi-remote-gateway stop     # Stop background daemon
```

---

## Configuration Reference

Configuration is loaded from `~/.config/remote-pi/config.json` by default (can be overridden with `REMOTE_PI_CONFIG`).

### Core Configuration

`telegram.botToken`, `telegram.allowedUserId`, and `cwd` (on first run) are strictly required. Runtime workspace switches via `/cwd` and recent projects are tracked cleanly in `state.json` (`~/.local/var/remote-pi/state.json`), keeping `config.json` immutable.

| Key | Environment Variable | Default | Description |
| :--- | :--- | :--- | :--- |
| `telegram.botToken` | `TELEGRAM_BOT_TOKEN` | *Required* | Telegram Bot Token provided by @BotFather |
| `telegram.allowedUserId` | `TELEGRAM_ALLOWED_USER_ID` | *Required* | Numeric Telegram User ID permitted to access the bot |
| `cwd` | `PI_CWD` | *Required on first run* | Initial workspace directory; required unless restored from `state.json`. Supports `~/`. Runtime `/cwd` switches persist in `state.json` |

### Advanced Options (Sensible Defaults)

| Key | Environment Variable | Default | Description |
| :--- | :--- | :--- | :--- |
| `sttCommand` | - | `""` | Shell command executed for voice note transcription |
| `stateDir` | - | `~/.local/var/remote-pi` | Directory for gateway state, downloads, instance lock and `bridge.sock`; Pi sessions remain in Pi’s native directory |
| `logFile` | `REMOTE_PI_LOG_FILE` | `~/.local/var/log/remote-pi.log` | Gateway output log file |
| `telegram.ackEmoji` | `TELEGRAM_ACK_EMOJI` | `"👀"` | Emoji reaction placed on message upon receipt |
| `longReplyChars` | `REMOTE_PI_LONG_REPLY_CHARS` | `8000` | Replies longer than this are sent as an HTML document (first chunk stays in chat with a note); `0` disables |
| `downloadRetentionDays` | `REMOTE_PI_DOWNLOAD_RETENTION_DAYS` | `30` | Days to keep downloaded files in the state downloads dir and `failed-reply-*.txt` copies (cleaned up on start and every 24h by mtime); `0` disables cleanup |
| `fallbackModels` | `REMOTE_PI_FALLBACK_MODELS` | `[]` | Comma-separated `provider/modelId` list offering a "Retry with <model>" button on errors (picks the next entry after the current model, wrapping) |
| `doneCard` | `REMOTE_PI_DONE_CARD` | `true` | Send a summary and change card at the end of each run with diff/commit/undo buttons (sent with notification, or silently for terminal-originated runs and while presenceFile exists) |
| `presenceFile` | `REMOTE_PI_PRESENCE_FILE` | `""` | Optional presence marker file path; while this file exists, proactive pushes (run completion cards, errors, Herdr blocked alerts) are sent silently (`disable_notification: true`). Can be created/deleted by a screen lock/unlock hook (e.g. sleepwatcher or hammerspoon). Supports `~/` |

> **Environment Variable Precedence**: Listed environment variables take precedence over `config.json`. Pi models, credentials, trust, and additional extensions are managed by Pi itself, not gateway configuration.

---

## Advanced Usage

### Topics / Parallel Sessions

The gateway supports running multiple independent Pi sessions in parallel using Telegram private-chat topics (Telegram Bot API 9.3+).

1. **Enable Topics in @BotFather**:
   - Open [@BotFather](https://t.me/BotFather) on Telegram.
   - Tap **Open** to launch the BotFather Mini App → select your bot → **Bot Settings** → **Threads Settings** → enable **Threaded Mode** (the classic `/mybots` text menu does not expose this setting).
2. **Create a Topic Session**:
   - Send `/topic [path]` to spin up an independent topic for a project directory. Without an argument, it uses the current session's workspace.
   - Each newly created topic starts an interactive Pi in its own Herdr pane/workspace. Sessions use Pi’s native directory, not a separate Telegram history.
3. **Manage Topics**:
   - Inside a topic, `/cwd <path>` switches the workspace for that topic only and renames the topic tab.
   - `/close` asks for confirmation and deletes the topic. The last view of a gateway-created Pi quits it and closes its pane; a desktop-attached Pi is only detached and keeps running.
   - In the main chat, `/status` lists all running/idle/stopped topic sessions.
   - Pi is not stopped for inactivity or evicted by a gateway concurrency limit. If Pi exits back to the shell, the next phone message restarts it in the same pane with its existing session.

### Voice Transcription (STT)

Configure `"sttCommand"` in `config.json`. When a voice message is received, the gateway passes the downloaded audio file path as `$1`. The standard output (`stdout`) is captured as transcribed prompt text.

**Example 1: Using Groq Whisper API (Ultra-fast cloud inference)**
```json
{
  "sttCommand": "curl -s https://api.groq.com/openai/v1/audio/transcriptions -H \"Authorization: Bearer $GROQ_API_KEY\" -F file=@$1 -F model=whisper-large-v3-turbo -F response_format=text"
}
```

**Example 2: Local Apple Silicon Hardware Acceleration (mlx-whisper)**
```json
{
  "sttCommand": "mlx_whisper --model mlx-community/whisper-large-v3-turbo $1"
}
```

### One session, any device

- **From your phone**: Chat in Telegram or create a topic with `/topic [path]`. The gateway opens a real interactive Pi in a Herdr pane; switch to that pane on the desktop and type immediately. `/new` resets the shared session, not a separate phone process.
- **From your desktop**: Run `/remote-control` (or `/remote-control on|off|status`) in any Pi pane. An unknown pane gets its own Telegram topic named after Pi's session name (`📡 <session_name>`), falling back to the first user prompt or directory basename. Enable Threaded Mode in @BotFather first. The last exchange (`👤 …` / `🤖 …`) is backfilled as a silent preview message. Renaming via `/name` or in Pi syncs to the topic title (`editForumTopic`). The native Herdr metadata token `remote_pi=on` preserves opt-in across extension/session reloads and clears on quit. While the bridge is connected, the Herdr sidebar shows a `📱` badge next to the agent and the Pi TUI footer shows `📱 remote` (`📱 reconnecting…` during reconnects). Closing a desktop-attached topic turns remote control off and notifies the terminal user without terminating Pi.
- **Both directions**: Phone prompts appear in the real Pi TUI; desktop-typed prompts appear in Telegram as `🖥 <text>`. Prompts use the socket and Pi’s native input API, never terminal keystrokes or transcript scraping. Prompts originating from the terminal send completion cards and empty-reply warnings silently to Telegram without buzzing your phone.
- **Resume without another writer**: `/resume` lists sessions for the current cwd from `~/.pi/agent/sessions` (or Pi’s native directory environment overrides). If another pane already serves a session, the gateway offers to point the topic at that pane instead of opening another Pi on the same file.
- **Dialogs**: `remote_ask` appears in both views; the first answer dismisses the other. Other extensions’ TUI dialogs stay in the terminal; Herdr blocked notifications include a screen tail and only `⏎ Enter` / `⎋ Esc` controls.
- **Lifecycle**: A gateway (re)start only re-attaches to Pi panes that are still running — it never launches a new Pi by itself; if none is running, the first message starts one. Extensions reconnect and saved bindings restore the views. When Pi quits to the shell, the next phone prompt resumes it in the same pane. Closing a desktop-attached topic never kills that Pi.
- **Visibility**: `/agents` remains a read-only list of all Herdr agents with screen previews. Pi reports its own status through Herdr’s native integration.

**Pi 1.3.0 public API limits**: Queue inspection/clearing is unavailable, so `/queue clear` resets the gateway display but does not remove Pi’s pending native messages. Automatic retry start/end notifications are also unavailable; other native events, including compaction and run completion, are forwarded.

---

## Architecture

```text
[ Telegram Client ]
       ↕ HTTPS long polling / messages / edits / callbacks
[ gateway.mjs ] — router, streaming, run cards
       ↕ JSON lines over <stateDir>/bridge.sock (Unix socket, mode 0600)
[ Herdr pane: interactive Pi + remote-pi.ts ] ↔ [ Desktop terminal ]
       ↕ Pi public Extension API / native CLI
[ Local Workspace & System Tools ]
```

- **One owner, many views**: Each session belongs to one interactive Pi process. `state.json` stores pane/session bindings; native Pi session files remain in `~/.pi/agent/sessions` (subject to Pi’s native environment overrides).
- **Native lifecycle**: Herdr creates/starts panes; Pi handles prompts, models, compaction, and session replacement. The gateway preserves its RPC-shaped client interface with `PaneRpc`, without spawning another Pi through a subprocess RPC mode.
- **Power Management**: On macOS, launchd invokes `/usr/bin/caffeinate -s -i -- node gateway.mjs`. This prevents idle sleep on AC power while preserving manual sleep and lid-close behavior.
- **References**: [Pi Extension API](https://pi.dev/docs/latest/extensions) (implementation targets installed Pi 1.3.0), [Herdr CLI](https://herdr.dev/docs/cli-reference/), and [Herdr integrations](https://herdr.dev/docs/integrations/).

---

## Security

1. **Local Privileges**: Controlling the Telegram Bot grants full access to execute shell commands and modify files with the privileges of your host user account.
2. **Never Add to Groups**: This bot is exclusively designed for 1-on-1 private chats. Do not add the bot to any group chat.
3. **Protect Your Config**: `~/.config/remote-pi/config.json` holds your Bot Token. Always ensure permissions are set to `600` (`chmod 600 config.json`).
4. **Log Privacy & Permissions**: The log file (`~/.local/var/log/remote-pi.log`) is restricted to mode `600` and records content-free metadata only (message kind, length, and tool name; no message text or tool arguments).

---

## License

[MIT](LICENSE) © 2026 Yunpeng Pan
