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

- **Chat Interface**: **Currently Telegram Only**. The gateway is deeply integrated with the Telegram Bot API (leveraging temporary live previews via `sendMessageDraft`, persistent replies via `sendMessage`, inline keyboards, status reactions, expandable blockquotes, and media downloads).
- **Supported OS**:
  - **macOS**: Provides an out-of-the-box `./install.sh` script to install the gateway as a persistent launchd daemon, paired with `caffeinate` to keep Pi responsive while connected to power without preventing normal sleep.
  - **Linux**: Can be run directly in the foreground or managed via standard systemd user units.

---

## Key Features

- ⚡ **Lightweight & Minimalist**: Built around a clean, single-file core (`gateway.mjs`) using only the Node.js standard library plus `markdown-it` for Telegram HTML rendering. No heavy frameworks.
- 🔒 **Clean State & Config Separation**: Follows 12-Factor principles — `config.json` remains strictly immutable. Runtime workspaces and pane/session bindings are tracked in `state.json`; sessions stay in Pi’s native session directory.
- 🎯 **100% Pi-Native**: Uses Pi 1.3.0’s public Extension API, Pi CLI, and Herdr socket API. One interactive Pi process owns each session; Telegram and the terminal are views of that process. No private patches or side-channel files.
- 🌊 **Live Drafts**: `sendMessageDraft` shows temporary text and current tool progress, independently for each topic. Updates are throttled to 1.5 seconds with 20-second keepalives; final replies are sent as persistent text messages. After a reply, an empty “Thinking…” placeholder is never sent again in that run. If drafts fail, previews stop for that run without falling back to edits. Drafts show Telegram's native Stop button (`can_stop: true`, Bot API 10.3); stopping generation acts as `/abort` in the owning chat/topic, for the allowed private-chat user only.
- 🔁 **Retry Errors**: Assistant error replies include a single `🔁 Retry` button to resend the last prompt. Long replies are delivered as text chunks.
- 🎮 **One Remote-Control Extension**:
  - `remote-pi.ts` provides `remote_attach` (send local files) and `remote_ask` (multiple-choice questions in Telegram and the terminal; first answer wins). Tools are active only while connected.
  - **TUI Footer Status**: Shows persistent `📱 remote` in the Pi TUI footer while the bridge socket is connected, `📱 reconnecting…` while retrying, and clears when remote control is off. Disconnecting from Telegram shows an informational notification.
  - Install other extensions through Pi’s native extension mechanism. Their TUI dialogs are not proxied: blocked notifications show the screen tail with Enter/Esc controls only, without parsing numbered options.
- 🎙️ **Multimodal Context & Voice Transcription (STT)**:
  - **Voice Input**: Configure `sttCommand` (e.g. Groq Whisper API or local Apple Silicon `mlx-whisper`) to convert Telegram voice notes into prompts automatically.
  - **Vision & Attachments**: Send photos (inlined as visual context) or documents, PDFs, and code files (saved locally and passed into context).
- 💬 **Live Steering & Reaction ACK**:
  - Send messages while Pi is working to dynamically steer the agent turn without waiting for it to finish.
  - On the triggering user message: `👀` received → `👨‍💻` working → `👌` replied, `💔` error, or `🤷` no text reply. The final error state follows the latest assistant message, so a successful internal retry ends with `👌`. Abort clears the reaction. Terminal-originated runs do not set reactions.
- 🔒 **Single-Instance Mutex & Strict Whitelist**:
  - Unix domain socket file lock prevents concurrent instances from interfering with the same session.
  - Strict numeric `allowedUserId` whitelist only accepts messages from your private chat; rejects unauthorized users and ignores all group chats.

---

**Notifications**: Final assistant replies notify only for Telegram-originated runs when you are not at your desk; tool-use replies and all terminal-originated replies are silent. `remote_ask` questions and blocked alerts notify unless the presence marker exists. Compaction failures are always silent.

## Commands

| Command | Description |
| :--- | :--- |
| *Plain Text* | Chat with Pi. Messages sent while Pi is working act as live steering instructions |
| `/topic [path]` | Start a new topic (thread) session for parallel tasks; without argument, uses current workspace |
| `/close` | Close the current topic after confirmation: quit/close gateway-created Pi panes; desktop-attached panes only detach. Delete the topic |
| `/model [query]` | Show inline keyboard to select a model, or switch directly by keyword/ID |
| `/thinking [level]` | View or set model thinking level (e.g. `off`, `low`, `high`) |
| `/new` | Start a fresh session even when disconnected, reset context, and show the active model |
| `/resume` | List sessions for the current workspace from Pi’s native directory; if already open, offer to view the existing pane |
| `/sh <command>` | Execute a shell command directly in the workspace directory (0 tokens, millisecond response). Note: the block on service restart/stop commands here is only an accident guard, not a security boundary — the bot holder already has full shell access |
| `/followup <prompt>` | Queue a follow-up prompt without interrupting the current agent turn |
| `/status` | Show current session ID, active model, token context usage, and cost |
| `/compact [focus]` | Trigger context compaction and summarization |
| `/abort` | Stop current agent execution immediately, keeping queued messages |
| `/help` | Show help, followed by available extension, prompt template, and skill commands |

### Admin

`/restart` and `/name` are visible in the Telegram command menu. `/start` is an alias for `/help`.

| Command | Description |
| :--- | :--- |
| `/name <name>` | Set the session name |
| `/restart` | Restart immediately, bypassing stuck session updates; once ready, update the original notice to “✅ Gateway restarted” |

> **Tip**: Installed Pi skills and custom commands use the native command router. The internal `/remote-pi-new` and `/remote-pi-switch` bridge commands are hidden from Telegram discovery; terminal autocomplete is not modified.

### Custom command routing

- The shared Telegram menu discovers Pi commands from the main view. `/help` lists commands for the current view, including Topic-only commands; those commands can be typed even when absent from the shared menu.
- All gateway command names and the `/start` alias are reserved. Custom commands cannot replace them or publish a different description under those names. Other names use generic native Pi command routing, without per-command shortcuts.
- [Telegram command names](https://core.telegram.org/bots/api#botcommand) use lowercase letters, digits and underscores, with a 32-character limit. If conversion or truncation makes different Pi names collide, the conflicting menu entry is omitted and `/help` marks it as ambiguous. Sending an ambiguous name returns an error without executing Pi. No automatic renaming is performed; use an unambiguous native spelling, or the Pi terminal.
- Custom command execution always resolves against the current Pi session's command list, not cached aliases from the main view or a previous project. Removed commands return “Unknown command” even if an old menu entry remains visible until the next menu refresh.

---

## Prerequisites

1. **Node.js**: **>= 22.18.0** (Node 24 LTS recommended; relies on native `import.meta.main`).
2. **Pi CLI 1.3.0**: Install and authenticate `@earendil-works/pi-coding-agent`; `pi` must be available on `PATH`. This is the supported public Extension API target.
3. **[Herdr](https://herdr.dev)**: Required; `herdr` must be available on `PATH`. The Herdr server must already be reachable; the gateway never starts it automatically.
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

Verify core invariants using fake Telegram/Herdr adapters and temporary local bridge sockets, without connecting to real Telegram or Herdr. A 60-second watchdog reports the active test and exits non-zero on hangs; assertions in polling fakes stop polling and reject the test instead of entering network backoff:

```bash
timeout 120 node gateway.mjs --self-test
# Outputs "self-test: ok" upon success
```

Developer checks (install dev dependencies with `npm install` first):

```bash
npm run lint
npm run typecheck
```

`typecheck` runs `tsc --noEmit` on `remote-pi.ts` using the installed Pi 1.3.0 public types, not vendored declarations. `tsconfig.json` maps the installed package and its TypeBox types under `/Users/panyunpeng/.pi/agent/install/releases/1.3.0/node_modules`; adjust those paths on other machines. Type-only imports are erased by Node's native type stripping, so `npm test` needs no TypeScript loader.

The project's line-budget targets are (including comments and blank lines): `gateway.mjs` ≤1500, `remote-pi.ts` ≤360, `install.sh` ≤140, core total ≤2000, and `self-test.mjs` ≤900. ESLint readability rules remain enabled; budget reductions must not cram statements onto a line.

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

The macOS installer manages this link automatically. For foreground/Linux use, run from the repository root:

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
pi-remote-gateway restart  # Restart service after code/config edits
pi-remote-gateway logs     # Tail output log in real time (tail -f)
pi-remote-gateway stop     # Stop background daemon
```

---

## Configuration Reference

Configuration is loaded from `~/.config/remote-pi/config.json` by default (can be overridden with `REMOTE_PI_CONFIG`).

### Core Configuration

`telegram.botToken`, `telegram.allowedUserId`, and `cwd` (on first run) are strictly required. Runtime pane/session bindings and topic workspaces are tracked in `state.json` (`~/.local/var/remote-pi/state.json`), keeping `config.json` immutable. Use `/topic <path>` to work in another project.

| Key | Environment Variable | Default | Description |
| :--- | :--- | :--- | :--- |
| `telegram.botToken` | - | *Required* | Telegram Bot Token provided by @BotFather |
| `telegram.allowedUserId` | - | *Required* | Numeric Telegram User ID permitted to access the bot |
| `cwd` | - | *Required on first run* | Initial workspace directory; required unless restored from `state.json`. Supports `~/` |

### Advanced Options (Sensible Defaults)

| Key | Environment Variable | Default | Description |
| :--- | :--- | :--- | :--- |
| `sttCommand` | - | `""` | Shell command executed for voice note transcription |
| `stateDir` | - | `~/.local/var/remote-pi` | Directory for gateway state, downloads, instance lock and `bridge.sock`; Pi sessions remain in Pi’s native directory |
| `logFile` | `REMOTE_PI_LOG_FILE` | `~/.local/var/log/remote-pi.log` | Gateway output log file |
| `presenceFile` | - | `""` | Optional desk-presence marker. While present, final replies and questions/blocked alerts are silent. Supports `~/`; manage it with a screen lock/unlock hook |

Downloads are retained for a fixed 30 days and cleaned up at startup and every 24 hours. Telegram polling uses a 25-second long poll with a 35-second request timeout and exponential backoff with jitter on failures.

> **Environment Variables**: Only `REMOTE_PI_CONFIG` (config path) and `REMOTE_PI_LOG_FILE` (log path) override gateway configuration. Pi models, credentials, trust, and additional extensions are managed by Pi itself.

---

## Advanced Usage

### Topics / Parallel Sessions

The gateway supports running multiple independent Pi sessions in parallel using Telegram private-chat topics (Telegram Bot API 9.3+).

1. **Enable Topics in @BotFather**:
   - Open [@BotFather](https://t.me/BotFather) on Telegram.
   - Tap **Open** to launch the BotFather Mini App → select your bot → **Bot Settings** → **Threads Settings** → enable **Threaded Mode** (the classic `/mybots` text menu does not expose this setting).
2. **Create a Topic Session**:
   - Send `/topic [path]` to spin up an independent topic for a project directory. Without an argument, it uses the current session's workspace.
   - Each newly created topic starts an interactive Pi in its own Herdr pane/workspace. When ready, it reports the provider/model and directory in one line. Sessions use Pi’s native directory, not a separate Telegram history.
3. **Manage Topics**:
   - Use `/topic <path>` to create a separate topic for another project. A manually opened topic inherits the main session's workspace.
   - `/close` asks for confirmation and deletes the topic. The last view of a gateway-created Pi quits it and closes its pane; a desktop-attached Pi is only detached and keeps running. If a topic is deleted directly in the Telegram client, the gateway automatically cleans it up (quitting owned Pi, detaching desktop Pi, and purging state) on the next delivery attempt.
   - `/status` shows the current view's model, session, context usage, and cost.
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
- **From your desktop**: Run `/remote-control` (or `/remote-control on|off|status`) in any Pi pane. An unknown pane gets its own Telegram topic named after Pi's session name (`📡 <session_name>`), falling back to the first user prompt or directory basename. Enable Threaded Mode in @BotFather first. The last exchange (`👤 …` / `🤖 …`) is backfilled as a silent preview message. Renaming via `/name` or in Pi syncs to the topic title (`editForumTopic`). The native Herdr metadata token `remote_pi=on` preserves opt-in across extension/session reloads and clears on quit. While the bridge is connected, the Pi TUI footer shows `📱 remote` (`📱 reconnecting…` during reconnects). Closing a desktop-attached topic turns remote control off and notifies the terminal user without terminating Pi.
- **Both directions**: Phone prompts appear in the real Pi TUI; desktop-typed prompts appear in Telegram as `🖥 <text>`. Prompts use the socket and Pi’s native input API, never terminal keystrokes or transcript scraping. Terminal-originated replies are silent; runs without text replies do not send extra placeholder messages.
- **Resume without another writer**: `/resume` asks the connected Pi for the 12 most recently modified sessions for the current cwd using public `SessionManager.list`, respecting Pi’s active native session directory. If another pane already serves a session, the gateway offers to point the topic at that pane instead of opening another Pi on the same file.
- **Dialogs**: `remote_ask` appears in both views; the first answer dismisses the other. Other extensions’ TUI dialogs stay in the terminal; Herdr blocked notifications include a screen tail and only `⏎ Enter` / `⎋ Esc` controls.
- **Lifecycle & terminal identity**: Sessions bind to Herdr terminal identities (`terminal_id`), preventing stale pane IDs from reusing or closing unrelated panes after Herdr restarts. A gateway (re)start only re-attaches to Pi panes that are still running — it never launches a new Pi by itself; if none is running, the first message starts one. Reconnecting keeps pending `remote_ask` terminal questions active and re-sends them to Telegram. When Pi quits to the shell, the next phone prompt resumes it in the same pane. Closing a desktop-attached topic never kills that Pi.
- **Blocked prompts**: Herdr `events.subscribe` pushes `pane.agent_status_changed` events for bound, connected panes; there is no periodic status poll. Changes to bindings resubscribe, socket closure reconnects with exponential backoff, and each subscription reconciles once using `agent.list`. While a session is working, entering blocked sends a screen-tail preview and Enter/Esc buttons; open `remote_ask` dialogs suppress duplicate alerts. Buttons re-check blocked status before sending keys.

**Pi 1.3.0 public API limits**: Native queue inspection/clearing and automatic retry start/end notifications are unavailable. Compaction and agent lifecycle events are forwarded.

---

## Architecture

```text
[ Telegram Client ]
       ↕ HTTPS long polling / drafts / final messages / reactions / callbacks
[ gateway.mjs ] — router and streaming
       ↕ JSON lines over <stateDir>/bridge.sock (Unix socket, mode 0600)
[ Herdr pane: interactive Pi + remote-pi.ts ] ↔ [ Desktop terminal ]
       ↕ Pi public Extension API / native CLI
[ Local Workspace & System Tools ]
```

- **One owner, many views**: Each session belongs to one interactive Pi process. `state.json` stores pane/session bindings; native Pi session files remain in `~/.pi/agent/sessions` (subject to Pi’s native environment overrides).
- **Per-session ordering**: Each view serializes its events and incoming updates; there is no global Telegram output queue or method monkey-patching. Attachment uploads use a separate per-session promise chain, preserving file order without blocking events or other sessions. Only `/abort`, the native draft Stop button, and `/restart` bypass the update chain, so a stuck command cannot block recovery. New topics are registered and their updates enqueued synchronously; persistence and the welcome message run in the background with error logging.
- **Native lifecycle**: Before `agent.start`, the gateway sets `remote_pi=on` using Herdr `pane.report_metadata`, retaining the foreground-shell safety check. No shell `export` or simulated input is injected; the extension resolves `bridge.sock` from configuration, without `REMOTE_PI_ATTACH` or `REMOTE_PI_BRIDGE_SOCKET`. Herdr creates/starts panes; Pi handles prompts, models, compaction, and session replacement. The gateway preserves its RPC-shaped client interface with `PaneRpc`, without spawning another Pi through a subprocess RPC mode.
- **Herdr transport**: Pane lookup, foreground-process checks, workspace creation, agent startup, and pane closure use the socket API. The only Herdr CLI call is `herdr status server --json` at startup to discover the socket (5-second timeout). Discovery and speech-to-text use the same promisified `execFile` helper; transcription runs `bash -c <sttCommand> stt <path>` with a 120-second timeout. Native `agent.start` receives `timeout_ms: 45000`; its socket request allows an additional 2 seconds for transport.
- **Command menu**: Commands are registered once using `setMyCommands` with the default scope. Older `all_private_chats` or other narrower command scopes take precedence if still configured; clearing those is a separate, authorized migration step.
- **Power Management**: On macOS, launchd invokes `/usr/bin/caffeinate -s -i -- node gateway.mjs`. This prevents idle sleep on AC power while preserving manual sleep and lid-close behavior.
- **References**: [Pi Extension API](https://pi.dev/docs/latest/extensions) (implementation targets installed Pi 1.3.0), [Herdr socket API](https://herdr.dev/docs/socket-api/), [Herdr CLI](https://herdr.dev/docs/cli-reference/), [Herdr integrations](https://herdr.dev/docs/integrations/), [Telegram draft lifecycle](https://core.telegram.org/bots/api#sendmessagedraft), [Telegram generation-stop updates](https://core.telegram.org/bots/api#messagegenerationstopped), [Telegram retry parameters](https://core.telegram.org/bots/api#responseparameters), [Telegram command-scope precedence](https://core.telegram.org/bots/api#determining-list-of-commands), [Node subprocesses](https://nodejs.org/api/child_process.html#child_processexecfilefile-args-options-callback), and [Node socket lifecycle](https://nodejs.org/api/net.html#event-close).

---

## Security

1. **Local Privileges**: Controlling the Telegram Bot grants full access to execute shell commands and modify files with the privileges of your host user account.
2. **Never Add to Groups**: This bot is exclusively designed for 1-on-1 private chats. Do not add the bot to any group chat.
3. **Protect Your Config**: `~/.config/remote-pi/config.json` holds your Bot Token. Always ensure permissions are set to `600` (`chmod 600 config.json`).
4. **Log Privacy & Permissions**: The log file (`~/.local/var/log/remote-pi.log`) is restricted to mode `600` and records content-free metadata only (message kind, length, and tool name; no message text or tool arguments).

---

## License

[MIT](LICENSE) © 2026 Yunpeng Pan
