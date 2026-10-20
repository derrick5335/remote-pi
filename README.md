<p align="right">
  <b>English</b> | <a href="README.zh-CN.md">简体中文</a>
</p>

<h1 align="center">telegram-herdr-pi</h1>

<p align="center">
  <b>Drive the <a href="https://pi.dev">Pi</a> coding agents running in <a href="https://herdr.dev">Herdr</a> on your machine — from Telegram.</b><br>
  One session, two views: the terminal on your desk and a Telegram chat on your phone. No public IP, SSH tunnel or cloud relay.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/node-%3E%3D22.18.0-brightgreen.svg" alt="Node.js >= 22.18.0">
  <img src="https://img.shields.io/badge/Pi-1.3.0-blueviolet.svg" alt="Pi 1.3.0">
  <img src="https://img.shields.io/badge/requires-Herdr-orange.svg" alt="Requires Herdr">
  <img src="https://img.shields.io/badge/chat-Telegram-26A5E4.svg" alt="Telegram">
  <img src="https://img.shields.io/badge/license-MIT-green.svg" alt="MIT License">
</p>

---

## What it is

telegram-herdr-pi connects a Telegram bot to the interactive Pi agents that run in your Herdr panes. Pi keeps running on your machine, with your files, tools and credentials; Telegram is just another window onto the same session — the way Claude Code Remote Control works, for Pi.

- **Start at the desk, continue on the phone.** Run `/remote-control` in any Pi pane and the session appears as its own Telegram topic.
- **Start on the phone.** Send `/topic ~/dev/my-app` and a real Pi starts in a new Herdr workspace; walk back to the desk and keep typing in that pane.
- **Never two writers.** Each session belongs to exactly one interactive Pi process. The gateway attaches views to it; it never starts a second Pi on the same session file.

```text
 Telegram (phone)            your machine
 ┌──────────────┐   HTTPS   ┌────────────────────┐  bridge.sock  ┌──────────────────────────┐
 │ chat / topics│◄─────────►│ gateway.mjs        │◄─────────────►│ Herdr pane: interactive  │
 │ drafts, 👀👌 │   long    │ (launchd service)  │  JSON lines   │ Pi + remote-pi.ts        │◄── your terminal
 └──────────────┘   poll    └────────────────────┘               └──────────────────────────┘
```

## Highlights

- 🖥️↔📱 **Shared session** — phone prompts appear in the real Pi TUI; prompts typed at the desk show up in Telegram as `🖥 …`. Prompts go through Pi's public API, never simulated keystrokes or transcript scraping.
- 🌊 **Live drafts** — while Pi works you see a live preview with the current tool (`⚙️ bash: npm test`) and Telegram's native **Stop** button; the final answer arrives as a normal message.
- 👀 **Status at a glance** — your message gets `👀` received → `👨‍💻` working → `👌` done (`💔` error, `🤷` no text reply).
- 🔔 **Quiet by default** — only a finished Telegram-started task or a question that needs you makes your phone ring. Intermediate replies and terminal-started runs are silent, and nothing rings while you are at your desk (`presenceFile`).
- ❓ **Answer from anywhere** — `remote_ask` questions show buttons in Telegram and a picker in the terminal; the first answer wins. When Pi is blocked on another extension's dialog you get the screen tail with `⏎ Enter` / `⎋ Esc`.
- 📎 **Rich input** — photos go to the model as images, files are saved locally and passed by path, albums arrive as one prompt, voice notes are transcribed with your own `sttCommand`. Pi can send files back with `remote_attach`.
- 🧵 **Parallel work** — one Telegram topic per Pi session; `/topic`, `/close`, `/new`, `/resume`, `/model` all work from the phone.
- 🛡️ **Robust** — survives gateway restarts and network drops (extension auto-reconnects, in-flight output and pending questions are recovered), binds to Herdr terminal identities so reused pane ids never hijack the wrong pane, and accepts messages from a single whitelisted user only.
- 🪶 **Small and native** — about 2,000 lines in total, one runtime dependency (`markdown-it`), only Pi 1.3.0's public extension API and Herdr's socket API.

## Requirements

- macOS (launchd service included) or Linux (run in the foreground or under systemd)
- [Node.js](https://nodejs.org) ≥ 22.18.0
- [Pi](https://pi.dev) 1.3.0 (`@earendil-works/pi-coding-agent`), logged in, `pi` on `PATH`
- [Herdr](https://herdr.dev) with its server running, `herdr` on `PATH` (the gateway never starts Herdr for you)
- A Telegram bot token from [@BotFather](https://t.me/BotFather) and your numeric Telegram user id

## Quick start

**1. Install**

```bash
git clone https://github.com/derrick5335/telegram-herdr-pi.git
cd telegram-herdr-pi
npm install --omit=dev
npm test            # offline self-test, prints "self-test: ok"
```

**2. Prepare the bot** — in @BotFather, open the Mini App (**Open**) → your bot → **Bot Settings** → **Threads Settings**:

- enable **Threaded Mode** (topics in the private chat);
- recommended: turn on the option that **prevents users from creating and deleting topics**. Telegram does not tell bots when a topic is deleted, so let the bot own the lifecycle: create with `/topic`, remove with `/close`.

To find your user id, message the bot once and run:

```bash
read -s TOKEN && curl -s "https://api.telegram.org/bot${TOKEN}/getUpdates" | \
  node -e 'd=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(d.result?.at(-1)?.message?.from?.id)'; unset TOKEN
```

**3. Install the service (macOS)**

```bash
./install.sh install
```

The installer asks for the bot token and user id, writes `~/.config/remote-pi/config.json` (mode 600; `cwd` starts as the repository directory — point it at your project), links the Pi extension to `~/.pi/agent/extensions/remote-pi.ts` and registers a launchd service. Manage it with:

```bash
pi-remote-gateway status | logs | restart | stop | start | uninstall
```

On Linux, create the config yourself (see [Configuration](#configuration)), link the extension with `ln -sfn "$PWD/remote-pi.ts" ~/.pi/agent/extensions/remote-pi.ts`, and run `npm start`.

**4. Use it** — send any message to the bot. Pi panes that were already running pick up the extension after Pi's `/reload`.

> The command name `pi-remote-gateway`, the `remote-pi.ts` extension and the `~/.config/remote-pi` / `~/.local/var/remote-pi` paths keep their original names for compatibility with existing installs.

## Using it

### From the desk

In any Pi running inside a Herdr pane:

```text
/remote-control [on|off|status]
```

The session gets its own `📡` topic with the last exchange as a preview, and the Pi footer shows `📱 remote`. The setting survives `/reload` and session switches. `/remote-control off` — or `/close` in the topic — only detaches Telegram; your Pi keeps running.

### From the phone

- Text in the main chat drives the main session (started lazily in a new Herdr workspace on the first message).
- Messages sent while Pi is working steer the current turn; `/followup` queues one for afterwards.
- `/topic [path]` starts another Pi for a project in its own topic and Herdr workspace; `/close` quits it and closes its pane.
- `/new` starts a fresh session **in the same Pi** (same pane, the terminal switches too); `/resume` lists past sessions of the workspace and never opens a session that is already running elsewhere.

### Commands

| Command | What it does |
| :--- | :--- |
| *text, photo, file, voice* | Prompt Pi; while it works, steer the current turn |
| `/topic [path]` | New topic with its own Pi (default: current workspace) |
| `/close` | Close this topic: quit a gateway-started Pi and its pane, or just detach a desktop Pi |
| `/new` | Fresh session in the same Pi, keeping the model |
| `/resume` | Pick one of the 12 most recent sessions of this workspace |
| `/model [query]` · `/thinking [level]` | Switch model / thinking level |
| `/status` | Model, context usage, cost and session file |
| `/compact [focus]` | Compact the context |
| `/abort` | Stop the current run (bypasses the queue); the draft's Stop button does the same |
| `/followup <text>` | Queue a prompt for after the current turn |
| `/name <name>` | Name the session (the topic title follows) |
| `/sh <command>` | Run a shell command in the workspace without the model |
| `/restart` | Restart the gateway (bypasses the queue); Pi keeps running |
| `/help` · `/start` | Help plus Pi's own extension, prompt and skill commands |

Any other `/command` is routed to Pi's native command of the same name (Telegram names are lowercased, `-` becomes `_`, max 32 characters). Ambiguous names are refused instead of guessed.

### Notifications

| Event | Rings? |
| :--- | :--- |
| Final answer of a run you started from Telegram | ✅ unless you are at your desk |
| `remote_ask` question, Pi blocked on a dialog | ✅ unless you are at your desk |
| Intermediate replies, tool progress, drafts | 🔕 |
| Runs started from the terminal | 🔕 |

"At your desk" means the `presenceFile` exists — create it from a screen-unlock hook and delete it on lock.

## Configuration

`~/.config/remote-pi/config.json` (override the path with `REMOTE_PI_CONFIG`):

```json
{
  "telegram": { "botToken": "123456789:ABC…", "allowedUserId": "123456789" },
  "cwd": "~/dev/my-project",
  "sttCommand": "",
  "presenceFile": "~/.local/var/remote-pi/present"
}
```

| Key | Default | Meaning |
| :--- | :--- | :--- |
| `telegram.botToken` | required | Bot token from @BotFather |
| `telegram.allowedUserId` | required | The only Telegram user the bot answers |
| `cwd` | required on first run | Workspace of the main session (`~/` allowed) |
| `sttCommand` | `""` | Voice transcription command; receives the audio path as `$1`, prints the text |
| `presenceFile` | `""` | While this file exists, nothing rings |
| `stateDir` | `~/.local/var/remote-pi` | Gateway state, downloads (kept 30 days), lock and `bridge.sock` |
| `logFile` | `~/.local/var/log/remote-pi.log` | Log file (also `REMOTE_PI_LOG_FILE`); content-free metadata only |

Voice examples: Groq Whisper `curl -s https://api.groq.com/openai/v1/audio/transcriptions -H "Authorization: Bearer $GROQ_API_KEY" -F file=@$1 -F model=whisper-large-v3-turbo -F response_format=text`, or local Apple Silicon `mlx_whisper --model mlx-community/whisper-large-v3-turbo $1`.

Models, credentials and other extensions are configured in Pi itself.

## Security

- Whoever controls the Telegram account controls your machine with your user's permissions — Telegram chats are not end-to-end encrypted. Use it only in a 1-on-1 chat with your own account and never add the bot to a group.
- The bot ignores every user except `allowedUserId` and every non-private chat.
- Keep `config.json` at mode 600. The log and state directories are created private; the log records message kinds and lengths, never message text or tool arguments.
- The `/sh` guard against stopping the service is an accident guard, not a security boundary.

## How it works

- `gateway.mjs` long-polls Telegram, renders Markdown to Telegram HTML, and talks to each Pi over a private Unix socket (`bridge.sock`, mode 600) using JSON lines. Output streams as `sendMessageDraft` previews and ends with a regular `sendMessage`.
- `remote-pi.ts` is a Pi extension built on Pi 1.3.0's public API. It forwards Pi's events, executes the gateway's requests (prompt, model, compact, new/switch session, …), adds `/remote-control`, `remote_attach` and `remote_ask`, and reconnects on its own. Its on/off state is stored as Herdr pane metadata (`remote_pi=on`).
- Herdr owns the processes: the gateway talks to Herdr's socket API to create workspaces, start Pi (`agent.start`) and read screens, enables the extension through pane metadata instead of typing into a shell, receives blocked-status changes as pushed `events.subscribe` events, and binds sessions to Herdr `terminal_id`s. The only CLI call is `herdr status server --json` at startup to find the socket.
- Pi owns the sessions: they stay in Pi's native session directory; `state.json` only remembers which topic views which pane and session.
- Known limits of Pi 1.3.0's public API: no native queue inspection/clearing and no auto-retry events.

References: [Pi extensions](https://pi.dev/docs/latest/extensions), [Herdr CLI](https://herdr.dev/docs/cli-reference/), [Telegram Bot API](https://core.telegram.org/bots/api), [Claude Code Remote Control](https://code.claude.com/docs/en/remote-control) (the experience this project mirrors).

## Development

```bash
npm install          # dev dependencies: ESLint, TypeScript, Pi 1.3.0 types
npm test             # node gateway.mjs --self-test — offline, fake Telegram and Herdr, 60 s watchdog
npm run lint         # ESLint
npm run typecheck    # tsc --noEmit on remote-pi.ts against @earendil-works/pi-coding-agent@1.3.0
```

Project rules for contributors and agents live in [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE) © 2026 Yunpeng Pan
