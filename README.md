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
- 🔒 **Clean State & Config Separation**: Follows 12-Factor principles — `config.json` remains strictly immutable. Runtime workspace switches and recent projects are tracked cleanly in `state.json`, and session paths use stable digests to prevent collision.
- 🎯 **100% Pi-Native**: Driven strictly via Pi's JSON-RPC protocol (`get_state`, `get_session_stats`, `new_session`, etc.). No private hacks, out-of-band files, or intrusive patches.
- 🌊 **Native Draft Streaming**: Streams thoughts and responses in real time using silent message creation and in-place editing (`sendMessage` + `editMessageText`), eliminating duplicate dialogs, ghost bubbles, and delivery flashes across all clients.
- 🛠️ **Expandable Tool Cards**: Ongoing tool executions (Bash commands, file read/write, grep) are grouped into native collapsible blockquotes (`<blockquote expandable>`) to keep mobile chat clean and readable.
- 📄 **Long Replies as Readable Files**: Final replies longer than `longReplyChars` (default 8000) are delivered as a standalone dark-mode-friendly HTML document (rendered with full CommonMark + GFM tables), with the first chunk kept in chat as a preview. Configure or disable (`0`) via `longReplyChars`; `/export` exports the whole session via Pi's native `export_html`.
- 🚑 **One-Tap Error Recovery**: Model errors, empty replies, unexpected Pi exits and extension failures attach an inline keyboard (1h TTL): retry the last prompt, retry on a fallback model (`fallbackModels`), pick another model, restart Pi, or view the redacted gateway log — no typing required.
- 🎮 **Telegram Companion Extension**:
  - Automatically loads `remote-extension.mjs`, giving the model two tools: `remote_attach` (send local files and generated artifacts back to chat) and `remote_ask` (interactive multiple-choice questions via buttons).
  - Supports loading custom Pi extensions via config (`-e`), and proxies Pi extension UI requests (`ctx.ui.select` / `ctx.ui.confirm` / `ctx.ui.input`) directly to Telegram.
- 🎙️ **Multimodal Context & Voice Transcription (STT)**:
  - **Voice Input**: Configure `sttCommand` (e.g. Groq Whisper API or local Apple Silicon `mlx-whisper`) to convert Telegram voice notes into prompts automatically.
  - **Vision & Attachments**: Send photos (inlined as visual context) or documents, PDFs, and code files (saved locally and passed into context).
- 💬 **Live Steering & Reaction ACK**:
  - Send messages while Pi is working to dynamically steer the agent turn without waiting for it to finish.
  - User messages receive a single receipt reaction (`👀` by default), which stays unchanged. Completion is reported by the run summary card, not another reaction.
- 📊 **Run Summary Card & Quick Actions**: At the end of every run, sends a summary card with notification (`✅ Done · 2m13s · +$0.04 · 12.3k tok · ctx 31%`), listing changed files (`+a −d`). Includes inline action buttons: `📄 Diff` (view inline or download unified diff), `✅ Commit` (streamed conventional commit prompt), and `↩️ Undo run` (interactive restore and cleanup).
- 📌 **Pinned Session Status Board**: Lazily creates and pins a single status board per session (`⏳ Working / 💤 Idle / ⚠️ Pi stopped / 🖥 On desktop`), updated in place with 3-second throttling and a 15-second live ticker. Displays running tool summary, active model, thinking level, context window percent, queued follow-ups, and last run stats.
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
| `/close` | Close the current topic session (confirm dialog → stop its Pi process and delete the topic) |
| `/model [query]` | Show inline keyboard to select a model, or switch directly by keyword/ID |
| `/thinking [level]` | View or set model thinking level (e.g. `off`, `low`, `high`) |
| `/new` | Start a fresh session, reset context, and display environment details |
| `/resume` | Show recently saved sessions to resume, with access to desktop Pi sessions in the workspace |
| `/sh <command>` | Execute a shell command directly in the workspace directory (0 tokens, millisecond response). Note: the block on service restart/stop commands here is only an accident guard, not a security boundary — the bot holder already has full shell access |
| `/get <filepath>` | Download a file from the current workspace to Telegram |
| `/followup <prompt>` | Queue a follow-up prompt without interrupting the current agent turn |
| `/status` | Show current session ID, active model, token context usage, and cost |
| `/agents` | Status of every agent in Herdr, grouped by workspace (📱 = Telegram session, 📡 = pushed to Telegram); tap one to see its screen |
| `/compact [focus]` | Trigger context compaction and summarization |
| `/export` | Export the full session as an HTML file (Pi native `export_html`) and send it as a document |
| `/fork` | Branch the session from a previous user message |
| `/handoff` | Hand off session to desktop Pi (safely stops phone Pi, gives copyable command & Take Back button) |
| `/abort` | Stop current agent execution immediately, keeping queued messages |
| `/queue [clear]` | View the message queue; `/queue clear` is the only command to clear it |
| `/help` | Show help, followed by available extension, prompt template, and skill commands |

### Admin (typeable, hidden from the Telegram menu)

| Command | Description |
| :--- | :--- |
| `/name <name>` | Set the session name |
| `/restart` | Restart the gateway |
| `/upgrade` | Self-upgrade the gateway: fast-forward git pull → npm install → offline self-test (auto-rollback on failure) → restart |

> **Tip**: Skills and custom commands installed in Pi are automatically surfaced in Telegram as callable commands (e.g. `/skill_name`).

---

## Prerequisites

1. **Node.js**: **>= 22.18.0** (Node 24 LTS recommended; relies on native `import.meta.main`).
2. **Pi CLI**: A globally installed and authenticated Pi CLI (e.g. `@mariozechner/pi-coding-agent`).
3. **Telegram Bot Token & Numeric User ID**:
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

### 4. Start the Gateway

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
| `piBin` | `PI_BIN` | Auto-detected | Path to the `pi` executable (auto-detects Homebrew / global npm paths) |
| `approve` | - | `true` | Pass `--approve` to Pi (trusts project-local settings and extensions for this run) |
| `herdr` | `REMOTE_PI_HERDR` | `true` | Automatically integrate with Herdr (connects to existing server or launches headless server; assigns workspace/pane envs) |
| `enableCompanionExtension` | `REMOTE_PI_COMPANION_EXTENSION` | `true` | Load companion extension (`remote_attach` and `remote_ask` tools) |
| `extensions` | `REMOTE_PI_EXTENSIONS` | `[]` | Additional Pi extension file paths to pass via `-e` |
| `sttCommand` | - | `""` | Shell command executed for voice note transcription |
| `stateDir` | - | `~/.local/var/remote-pi` | Directory for runtime state, session files, downloads, and lock socket |
| `logFile` | `REMOTE_PI_LOG_FILE` | `~/.local/var/log/remote-pi.log` | Gateway output log file |
| `idleStopMinutes` | `REMOTE_PI_IDLE_STOP_MINUTES` | `30` | Inactivity minutes before a non-streaming topic session's Pi process is stopped (restarts on next message; main session never idle-stopped); `0` disables idle-stopping entirely |
| `maxSessions` | `REMOTE_PI_MAX_SESSIONS` | `4` | Maximum concurrently running Pi processes across all sessions (stops least recently active non-streaming topic when limit is reached) |
| `telegram.ackEmoji` | `TELEGRAM_ACK_EMOJI` | `"👀"` | Emoji reaction placed on message upon receipt |
| `longReplyChars` | `REMOTE_PI_LONG_REPLY_CHARS` | `8000` | Replies longer than this are sent as an HTML document (first chunk stays in chat with a note); `0` disables |
| `downloadRetentionDays` | `REMOTE_PI_DOWNLOAD_RETENTION_DAYS` | `30` | Days to keep downloaded files in the state downloads dir and `failed-reply-*.txt` copies (cleaned up on start and every 24h by mtime); `0` disables cleanup |
| `fallbackModels` | `REMOTE_PI_FALLBACK_MODELS` | `[]` | Comma-separated `provider/modelId` list offering a "Retry with <model>" button on errors (picks the next entry after the current model, wrapping) |
| `doneCard` | `REMOTE_PI_DONE_CARD` | `true` | Send a summary and change card with notification and diff/commit/undo buttons at the end of each run |
| `statusBoard` | `REMOTE_PI_STATUS_BOARD` | `true` | Maintain a pinned status board per session with throttled updates showing status, tool, model, context, and follow-ups |

> **Environment Variable Precedence**: Environment variables always take precedence over `config.json`. For `REMOTE_PI_EXTENSIONS`, you can pass a JSON array string (`'["~/my-ext.ts"]'`) or a comma-separated list.

---

## Advanced Usage

### Topics / Parallel Sessions

The gateway supports running multiple independent Pi sessions in parallel using Telegram private-chat topics (Telegram Bot API 9.3+).

1. **Enable Topics in @BotFather**:
   - Open [@BotFather](https://t.me/BotFather) on Telegram.
   - Tap **Open** to launch the BotFather Mini App → select your bot → **Bot Settings** → **Threads Settings** → enable **Threaded Mode** (the classic `/mybots` text menu does not expose this setting).
2. **Create a Topic Session**:
   - Send `/topic [path]` to spin up an independent topic for a project directory. Without an argument, it uses the current session's workspace.
   - Each topic gets its own isolated Pi process, workspace, and session history (`sessionDir + "-t<threadId>"`).
3. **Manage Topics**:
   - Inside a topic, `/cwd <path>` switches the workspace for that topic only and renames the topic tab.
   - `/close` inside a topic prompts for confirmation, stops that topic's Pi process, and deletes the topic.
   - In the main chat, `/status` lists all running/idle/stopped topic sessions.
   - Inactive topic sessions are automatically idle-stopped after `idleStopMinutes` (default 30) and seamlessly resumed upon your next message.

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

### Herdr Desktop Visibility & Notifications

When you run [Herdr](https://herdr.dev), the gateway integrates deeply with Herdr's socket API:

1. **Every Telegram session is visible in Herdr**:
   - Each Telegram chat session (main chat and each topic) gets its own dedicated Herdr workspace labeled `📱 <basename>` (or `📱 <basename>#<threadId>`).
   - The gateway reports agent status (`working`, `idle`, `blocked` with the question title) directly to Herdr over its socket (source `remote-pi`), so Telegram sessions appear live in Herdr's agent list (`herdr agent list`).
   - Inside the pane, a compact ANSI viewer (`gateway.mjs --watch-session`) renders a read-only live transcript of the conversation (user messages, assistant text, tool executions, errors, and compactions).
2. **Desktop Pi Remote Control via Topics (opt-in per agent)**:
   - When running other desktop Pi agents in Herdr, turning on remote control bridges that agent to its **own Telegram forum topic**. Opt in per agent by typing `/remote-control` (or `/remote-control on|off|status`) inside that desktop Pi.
   - **Prerequisite**: Threaded Mode / forum topics must be enabled for your bot in Telegram (via @BotFather Mini App: Bot Settings → Threads Settings → Threaded Mode). If topics are not enabled, notifications fall back to the main chat.
   - `install.sh` (and `pi-remote-gateway upgrade`) symlinks `herdr-extension.ts` to `~/.pi/agent/extensions/remote-pi.ts`.
   - The opt-in is stored on the Herdr pane itself as a native metadata token (`remote_pi=on`), and is cleared when that Pi quits.
   - **Live Streaming**: The pane's Pi conversation streams into the topic at message-level granularity (user messages, assistant replies chunked or exported as HTML documents, and tool calls merged in-place into an expandable tool panel; thinking parts and raw tool results are omitted).
   - **Interactive Prompting & Control**: Send text messages directly into the topic to prompt the desktop agent (with automatic echo suppression). `/status` displays the agent status and current screen, `/abort` sends `Esc` to interrupt the running task.
   - **Needs confirmation** (`blocked`): you get the screen tail plus buttons for detected options (`1. Yes`, `2. …`), plus `⏎ Enter` / `⎋ Esc`. Notifications for `blocked` ping you, while `done` notifications arrive silently.
   - `/agents` lists all Herdr agents: `📱` marks Telegram sessions, while `📡` marks desktop agents bridged via remote control.

### Phone ↔ Desktop Handoff

Two Pi processes must never write to the same session file simultaneously. The gateway keeps its sessions in `~/.local/var/remote-pi/sessions`, completely separate from your desktop Pi's default directory (`~/.pi/agent/sessions/`).

- **Phone → Desktop (`/handoff`)**:
  - Sends `/handoff` to gracefully stop the gateway's Pi process and release Herdr agent authority.
  - If Herdr is running, the gateway stops the pane viewer and launches the interactive Pi directly in that same Herdr pane via `herdr agent start`, so the official Herdr Pi integration seamlessly takes over status reporting.
  - Generates a copyable fallback command to continue on desktop:
    ```bash
    cd '<cwd>' && pi --session '<sessionFile>'
    ```
  - While handed off, the pinned status board displays `🖥 On desktop since HH:MM`, and messages sent in Telegram are not sent to Pi.
  - Tap `⬅️ Take back` to resume the session on Telegram:
    - The gateway checks the Herdr pane's agent status: if it is still `working` or `blocked`, it safely refuses to take back to avoid concurrent writes.
    - If `idle` or `done`, it sends `/quit` to that pane, waits for the desktop Pi process to exit back to the shell, and resumes the session on Telegram (reloading the latest history, restarting the pane viewer, and reporting status).
    - If the desktop Pi does not exit within 10 seconds, it alerts you and keeps the handoff mark.
  - Or tap `✨ New session here` to start fresh in Telegram.
- **Desktop → Phone (Desktop Sessions in `/resume`)**:
  - Run `/resume`. If previous desktop Pi sessions exist for the current directory, a `🖥 Desktop sessions` button appears.
  - Lists up to 10 newest desktop session files with relative timestamps and previews.
  - Pick a session, confirm that the desktop Pi on that session has exited, and the gateway seamlessly loads it via `switch_session`.

---

## Architecture

```text
[ Telegram Client ]
       ↕ (HTTPS Long Polling / SendMessageDraft / Reactions / Callbacks)
[ gateway.mjs ] (Single daemon process, Node stdlib + markdown-it, Unix Socket Lock)
       ↕ (JSON-RPC over stdio)
[ pi --mode rpc --continue ]
       ↕ (-e remote-extension.mjs & custom extensions)
[ Local Workspace & System Tools ]
```

- **Power Management**: On macOS, launchd invokes `/usr/bin/caffeinate -s -i -- node gateway.mjs`. This prevents idle sleep on AC power (allowing Dark Wake to process commands immediately) while preserving manual sleep and lid-close behavior.
- **Session Isolation**: Sessions spawned by the gateway are stored under `~/.local/var/remote-pi/sessions`, isolated from your desktop Pi session history to avoid concurrency conflicts on the same session file.

---

## Security

1. **Local Privileges**: Controlling the Telegram Bot grants full access to execute shell commands and modify files with the privileges of your host user account.
2. **Never Add to Groups**: This bot is exclusively designed for 1-on-1 private chats. Do not add the bot to any group chat.
3. **Protect Your Config**: `~/.config/remote-pi/config.json` holds your Bot Token. Always ensure permissions are set to `600` (`chmod 600 config.json`).

---

## License

[MIT](LICENSE) © 2026 Yunpeng Pan
