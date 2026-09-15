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

- **Chat Interface**: **Currently Telegram Only**. The gateway is deeply integrated with the Telegram Bot API (leveraging `sendMessageDraft` streaming previews, inline button keyboards, emoji reaction state machines, expandable blockquotes, and media downloads).
- **Supported OS**:
  - **macOS**: Provides an out-of-the-box `./install.sh` script to install the gateway as a persistent launchd daemon, paired with `caffeinate` to keep Pi responsive while connected to power without preventing normal sleep.
  - **Linux**: Can be run directly in the foreground or managed via standard systemd user units.

---

## Key Features

- ⚡ **Lightweight & Minimalist**: Built around a clean, single-file core (`gateway.mjs`) using only the Node.js standard library plus `markdown-it` for Telegram HTML rendering. No heavy frameworks.
- 🔒 **Clean State & Config Separation**: Follows 12-Factor principles — `config.json` remains strictly immutable. Runtime workspace switches and recent projects are tracked cleanly in `state.json`, and session paths use stable digests to prevent collision.
- 🎯 **100% Pi-Native**: Driven strictly via Pi's JSON-RPC protocol (`get_state`, `get_session_stats`, `new_session`, etc.). No private hacks, out-of-band files, or intrusive patches.
- 🌊 **Native Draft Streaming**: Streams thoughts and responses in real time using Telegram's official `sendMessageDraft` API (including an in-app Stop button); automatically falls back to silent message editing when drafts are unsupported.
- 🛠️ **Expandable Tool Cards**: Ongoing tool executions (Bash commands, file read/write, grep) are grouped into native collapsible blockquotes (`<blockquote expandable>`) to keep mobile chat clean and readable.
- 🎮 **Telegram Companion Extension**:
  - Automatically loads `remote-extension.mjs`, giving the model two tools: `remote_attach` (send local files and generated artifacts back to chat) and `remote_ask` (interactive multiple-choice questions via buttons; aliases `telegram_attach` / `telegram_ask` retained for compatibility).
  - Supports loading custom Pi extensions via config (`-e`), and proxies Pi extension UI requests (`ctx.ui.select` / `ctx.ui.confirm` / `ctx.ui.input`) directly to Telegram.
- 🎙️ **Multimodal Context & Voice Transcription (STT)**:
  - **Voice Input**: Configure `sttCommand` (e.g. Groq Whisper API or local Apple Silicon `mlx-whisper`) to convert Telegram voice notes into prompts automatically.
  - **Vision & Attachments**: Send photos (inlined as visual context) or documents, PDFs, and code files (saved locally and passed into context).
- 💬 **Live Steering & Reaction ACK**:
  - Send messages while Pi is working to dynamically steer the agent turn without waiting for it to finish.
  - Immediate emoji reactions on user messages (`👀` upon receipt, updated to `🫡` upon completion) eliminate mobile waiting anxiety.
- 🔒 **Single-Instance Mutex & Strict Whitelist**:
  - Unix domain socket file lock prevents concurrent instances from interfering with the same session.
  - Strict numeric `allowedUserId` whitelist only accepts messages from your private chat; rejects unauthorized users and ignores all group chats.

---

## Commands

| Command | Description |
| :--- | :--- |
| *Plain Text* | Chat with Pi. Messages sent while Pi is working act as live steering instructions |
| `/cwd` | View current workspace directory, or switch across recent projects and folders under `devRoot` |
| `/model [query]` | Show inline keyboard to select a model, or switch directly by keyword/ID |
| `/thinking [level]` | View or set model thinking level (e.g. `off`, `low`, `high`) |
| `/new` | Start a fresh session, reset context, and display environment details |
| `/resume` | Show recently saved sessions to resume |
| `/sh <command>` | Execute a shell command directly in the workspace directory (0 tokens, millisecond response) |
| `/get <filepath>` | Download a file from the current workspace to Telegram |
| `/followup <prompt>` | Queue a follow-up prompt without interrupting the current agent turn |
| `/session` or `/status`| Show current session ID, active model, token context usage, and cost |
| `/compact [focus]` | Trigger context compaction and summarization |
| `/fork` | Branch the session from a previous user message |
| `/abort` | Stop current agent execution immediately |
| `/help` | Show full help menu |

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
  "botToken": "123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ",
  "allowedUserId": "123456789",
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
pi-remote-gateway restart  # Restart service after code/config edits
pi-remote-gateway logs     # Tail output log in real time (tail -f)
pi-remote-gateway stop     # Stop background daemon
```

---

## Configuration Reference

Configuration is loaded from `~/.config/remote-pi/config.json` by default (can be overridden with `REMOTE_PI_CONFIG`).

### Core Configuration

Only `botToken` and `allowedUserId` are strictly required. Runtime workspace switches via `/cwd` and recent projects are tracked cleanly in `state.json` (`~/.local/var/remote-pi/state.json`), keeping `config.json` immutable.

| Key | Environment Variable | Default | Description |
| :--- | :--- | :--- | :--- |
| `botToken` | `TELEGRAM_BOT_TOKEN` | *Required* | Telegram Bot Token provided by @BotFather |
| `allowedUserId` | `TELEGRAM_ALLOWED_USER_ID` | *Required* | Numeric Telegram User ID permitted to access the bot |
| `cwd` | `PI_CWD` | `process.cwd()` | Initial workspace working directory (supports `~/`; runtime `/cwd` switches persist in `state.json`) |
| `devRoot` | `DEV_ROOT` | `~/dev` (if exists) | Root directory scanned by `/cwd` to switch projects. Set to `null` to disable project scanning |

### Advanced Options (Sensible Defaults)

| Key | Environment Variable | Default | Description |
| :--- | :--- | :--- | :--- |
| `piBin` | `PI_BIN` | Auto-detected | Path to the `pi` executable (auto-detects Homebrew / global npm paths) |
| `approve` | - | `true` | Pass `--approve` to Pi (trusts project-local settings and extensions for this run) |
| `enableCompanionExtension` | `REMOTE_PI_COMPANION_EXTENSION` | `true` | Load companion extension (`remote_attach` and `remote_ask` tools) |
| `extensions` | `REMOTE_PI_EXTENSIONS` | `[]` | Additional Pi extension file paths to pass via `-e` |
| `sttCommand` | - | `""` | Shell command executed for voice note transcription |
| `stateDir` | - | `~/.local/var/remote-pi` | Directory for runtime state, session files, downloads, and lock socket |
| `logFile` | `REMOTE_PI_LOG_FILE` | `~/.local/var/log/remote-pi.log` | Gateway output log file |
| `ackEmoji` | `TELEGRAM_ACK_EMOJI` | `"👀"` | Emoji reaction placed on message upon receipt |
| `doneEmoji` | `TELEGRAM_DONE_EMOJI` | `"🫡"` | Emoji reaction replacing ack emoji when task finishes |

> **Environment Variable Precedence**: Environment variables always take precedence over `config.json`. For `REMOTE_PI_EXTENSIONS`, you can pass a JSON array string (`'["~/my-ext.ts"]'`) or a comma-separated list.

---

## Advanced Usage

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
