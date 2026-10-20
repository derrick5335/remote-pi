#!/usr/bin/env node

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, openAsBlob, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { chmod, lstat, mkdir, readFile, readdir, realpath, rename, stat, truncate, unlink, writeFile } from "node:fs/promises";
import net from "node:net";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import MarkdownIt from "markdown-it";
import { herdrRequest, readJsonLines, writeJsonLine } from "./remote-pi.ts";
// ref: https://nodejs.org/api/child_process.html#child_processexecfilefile-args-options-callback — bounded, promisified subprocesses.
const execFileAsync = promisify(execFile);
const MAX_MESSAGE = 4000;
const MAX_LOG_SIZE = 5 * 1024 * 1024;
let HERDR_DISABLED_FOR_TEST = false;
const setTestMode = (on) => { HERDR_DISABLED_FOR_TEST = Boolean(on); };
const log = (tag, ...args) => console.log(`${new Date().toISOString()} [${tag}]`, ...args);
const BOT_COMMANDS = [
  { command: "help", description: "Show help and Pi native commands" },
  { command: "new", description: "Start a new session" },
  { command: "resume", description: "Pick a past session" },
  { command: "topic", description: "Start a new topic session for a path" },
  { command: "close", description: "Close current topic session" },
  { command: "model", description: "Switch or inspect model" },
  { command: "thinking", description: "Set thinking level" },
  { command: "status", description: "Current model, session, tokens & cost" },
  { command: "compact", description: "Compact session context" },
  { command: "abort", description: "Stop current execution" },
  { command: "followup", description: "Queue message after current turn finishes" },
  { command: "name", description: "Rename current session / topic" },
  { command: "sh", description: "Run a shell command directly" },
  // ref: https://core.telegram.org/bots/api#setmycommands — publish /restart in the slash menu.
  { command: "restart", description: "Restart the gateway service" },
];
const RESERVED_COMMANDS = new Set([...BOT_COMMANDS.map((c) => c.command), "start"]);
const HELP = `telegram-herdr-pi\n\nJust send text to chat with Pi; messages sent while it is working act as steering.\n\n` + BOT_COMMANDS.map((c) => `/${c.command.padEnd(19)} ${c.description}`).join("\n");
function parseCommand(text) {
  const match = text.match(/^\/([\w:-]+)(?:@\w+)?(?:\s+([\s\S]*))?$/);
  return match ? { name: match[1].toLowerCase(), argument: match[2]?.trim() ?? "" } : null;
}
function buildDevPath(basePath = process.env.PATH) {
  const home = homedir();
  const extra = [join(home, ".local/bin"), join(home, ".bun/bin"), join(home, ".cargo/bin"), join(home, ".opencode/bin"), join(home, ".antigravity/antigravity/bin"), "/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", dirname(process.execPath)];
  return [...new Set([...extra, ...(basePath || "/usr/bin:/bin:/usr/sbin:/sbin").split(":")].filter(Boolean))].join(":");
}
process.env.PATH = buildDevPath(process.env.PATH);
// ref: AWS Architecture Blog — Exponential Backoff And Jitter (https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/)
function pollBackoffMs(failures, random = Math.random) {
  return Math.max(500, Math.round(random() * Math.min(60_000, 1000 * (2 ** (Math.max(1, failures) - 1)))));
}
const NON_IDEMPOTENT_METHODS = new Set(["sendMessage", "sendDocument", "sendPhoto", "sendMediaGroup", "copyMessage", "forwardMessage"]);
const CONNECT_PHASE_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT"]);
// ref: https://core.telegram.org/bots/api#making-requests — avoid replaying non-idempotent requests after ambiguous failures.
function shouldRetryTelegram(method, { status, error } = {}) {
  const safe = !NON_IDEMPOTENT_METHODS.has(method);
  return typeof status === "number" ? status === 429 || safe && status >= 500
    : error != null && (safe || CONNECT_PHASE_CODES.has(error.cause?.code || error.code));
}
function telegramCommandName(command) {
  const name = command.source === "skill" ? `skill_${command.name.slice("skill:".length)}` : command.name;
  return name.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 32);
}
// ref: https://core.telegram.org/bots/api#botcommand — normalization and the 32-character limit can collapse distinct Pi names.
function commandRoutes(commands) {
  const routes = new Map();
  for (const command of commands) {
    const names = [command.name.toLowerCase(), telegramCommandName(command)];
    if (command.source === "skill") names.push(`skill-${command.name.slice("skill:".length).toLowerCase()}`);
    for (const name of names) {
      if (!name || RESERVED_COMMANDS.has(name)) continue;
      if (!routes.has(name)) routes.set(name, new Set());
      routes.get(name).add(command.name);
    }
  }
  return routes;
}
function expandableBlockquote(text) {
  const clean = String(text || "").trim();
  return clean ? `\`\`\`expandable\n${clean}\n\`\`\`` : "";
}
// markdown-it + 自定义 renderer → Telegram HTML 子集（b/i/s/u/code/pre/a/blockquote）
// html:false：模型输出里的原始 HTML 一律转义，防注入；linkify:true：裸 URL 自动成链接
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escAttr = (s) => esc(s).replace(/"/g, "&quot;");
const md = new MarkdownIt({ html: false, linkify: true, breaks: true });
const { rules } = md.renderer;
rules.code_inline = (t, i) => `<code>${esc(t[i].content)}</code>`;
rules.fence = (t, i) => {
  const info = (t[i].info || "").trim().split(/\s+/)[0];
  const body = esc(t[i].content.replace(/\n$/, ""));
  if (info === "expandable") return `<blockquote expandable>${body}</blockquote>\n\n`;
  return info
    ? `<pre><code class="language-${info.replace(/[^a-zA-Z0-9_+-]/g, "")}">${body}</code></pre>\n\n`
    : `<pre>${body}</pre>\n\n`;
};
rules.code_block = (t, i) => `<pre>${esc(t[i].content)}</pre>\n\n`;

for (const [type, text] of Object.entries({
  paragraph_open: "", heading_open: "<b>", heading_close: "</b>\n\n", blockquote_open: "<blockquote>", blockquote_close: "</blockquote>\n\n",
  link_close: "</a>", hardbreak: "\n", softbreak: "\n", hr: "─ ─ ─\n\n", list_item_close: "\n",
})) rules[type] = () => text;
rules.paragraph_close = () => (listStack.length ? "" : "\n");
// 列表：去掉 ul/ol 包装；有序序号自计数；嵌套按层级缩进（render 同步执行，模块级栈安全）
let listStack = [];
// ref: https://markdown-it.github.io/markdown-it/#Renderer.rules — share rendering for equivalent token types.
for (const [type, initial] of [["bullet", null], ["ordered", 0]]) {
  rules[`${type}_list_open`] = () => {
    listStack.push(initial);
    return listStack.length >= 2 ? "\n" : "";
  };
}
rules.bullet_list_close = rules.ordered_list_close = () => {
  listStack.pop();
  return listStack.length ? "" : "\n";
};
rules.list_item_open = () => {
  const depth = listStack.length, top = listStack[depth - 1];
  if (top === null) return `${"  ".repeat(depth - 1)}• `;
  listStack[depth - 1] = top + 1;
  return `${"  ".repeat(depth - 1)}${top + 1}. `;
};
rules.link_open = (t, i) => `<a href="${escAttr(t[i].attrGet("href") || "")}">`;
rules.image = (t, i) => {
  const src = t[i].attrGet("src") || "";
  const alt = (t[i].children || []).map((c) => c.content).join("") || src;
  return `<a href="${escAttr(src)}">${esc(alt)}</a>`;
};

const rawRender = md.renderer.render.bind(md.renderer);
md.renderer.render = (tokens, options, env) => {
  listStack = [];
  try {
    const out = rawRender(tokens, options, env)
      .replaceAll("<strong>", "<b>").replaceAll("</strong>", "</b>")
      .replaceAll("<em>", "<i>").replaceAll("</em>", "</i>")
      .replaceAll("\n</blockquote>", "</blockquote>")
      // Telegram 无 <table>：拆成手机友好的标题行 + bullet 行（保留单元格内行内标记）
      .replace(/<table>[\s\S]*?<\/table>/g, (m) => {
        const body = (m.match(/<tr>[\s\S]*?<\/tr>/g) || []).map((r) => (r.match(/<t[hd][^>]*>[\s\S]*?<\/t[hd]>/g) || [])
          .map((c) => c.replace(/<\/?t[hd][^>]*>/g, "").trim())).filter((cs) => !cs.every((c) => !c || /^:?-+:?$/.test(c.replace(/<[^>]+>/g, ""))));
        if (body.length < 2) return m;
        const [head, ...data] = body;
        return [`<b>${head.join(" · ")}</b>`, ...data.map((r) => `• ${r.join(" — ")}`)].join("\n") + "\n\n";
      });
    return out.replace(/\n{3,}/g, "\n\n").trim();
  } finally {
    listStack = [];
  }
};
const telegramHtml = (text) => md.render(String(text || ""));
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
function scanFence(text) {
  let open = null;
  for (const line of text.split("\n")) {
    const m = FENCE_RE.exec(line);
    if (!m) continue;
    if (!open && (m[1][0] === "~" || !m[2].includes("`"))) open = { marker: m[1], info: m[2].trim() };
    else if (open && m[1][0] === open.marker[0] && m[1].length >= open.marker.length && !m[2].trim()) open = null;
  }
  return open;
}
function renderChunk(text, from, to) {
  const slice = text.slice(from, to), openStart = scanFence(text.slice(0, from)), openEnd = scanFence(text.slice(0, to));
  const pre = openStart ? `${openStart.marker}${openStart.info}\n` : "";
  const suf = openEnd ? `${slice.endsWith("\n") ? "" : "\n"}${openEnd.marker}` : "";
  return pre + slice + suf;
}
function chunks(text, limit = MAX_MESSAGE) {
  const str = String(text || "(empty)");
  if (str.length <= limit) return [str];
  const parts = [];
  let from = 0;
  while (str.length - from > limit) {
    const target = from + limit;
    let cut = str.lastIndexOf("\n\n", target);
    if (cut <= from || cut < target - 500) cut = str.lastIndexOf("\n", target);
    if (cut <= from) cut = target;
    parts.push(renderChunk(str, from, cut));
    from = cut + (str[cut] === "\n" ? 1 : 0);
  }
  if (from < str.length) parts.push(renderChunk(str, from, str.length));
  return parts;
}
const extractText = (content) => typeof content === "string" ? content
  : Array.isArray(content) ? content.filter((p) => p.type === "text").map((p) => p.text).join("\n") : "";
function toolSummary(name, args = {}) {
  const val = args?.command || args?.path || args?.pattern || args?.query || (Array.isArray(args?.queries) && args.queries.join(", ")) || args?.url || Object.values(args || {}).find((v) => typeof v === "string");
  if (val) return `${name}: ${val}`;
  const json = JSON.stringify(args || {});
  return json && json !== "{}" ? `${name} ${json}` : name;
}
const MIME_EXTENSIONS = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif", "audio/ogg": ".ogg", "audio/mpeg": ".mp3", "audio/wav": ".wav", "video/mp4": ".mp4", "video/quicktime": ".mov", "application/pdf": ".pdf" };
const extensionFromMime = (mime = "") => MIME_EXTENSIONS[String(mime).toLowerCase()] || "";
const attachmentPrompt = (caption, files) => `${caption}\n\nAttachments saved locally:\n${files.map((file) => `- ${file.path}`).join("\n")}`;
function formatAssistantError(errorMessage) {
  const message = String(errorMessage || "Model call failed");
  const tip = /usage limit|quota|balance|credit|insufficient|budget/i.test(message)
    ? "the current model's usage quota is exhausted. Use /model to switch to another available model (e.g. Gemini or Claude)."
    : /rate limit|too many requests|429/i.test(message) ? "provider rate limit hit. Retry shortly, or use /model to switch models." : "";
  return tip ? `⚠️ ${message}\n\n💡 Tip: ${tip}` : `❌ ${message}`;
}
function resolvePath(pathStr, baseDir = process.cwd()) {
  if (!pathStr || typeof pathStr !== "string") return "";
  const expanded = pathStr.startsWith("~/") ? join(homedir(), pathStr.slice(2)) : pathStr === "~" ? homedir() : pathStr;
  return resolve(baseDir, expanded);
}
// pure routing: 判定消息归属的主会话 ("main") 或私聊 Topic ("t:<threadId>")
// ref: Telegram Bot API 9.3 (2025-12-31) Topics in private chats (https://core.telegram.org/bots/api-changelog)
function sessionKeyOf(message) {
  const m = message?.message || message;
  if (!m || m.chat?.type && m.chat.type !== "private" || !m.message_thread_id || m.is_topic_message === false) return "main";
  return `t:${m.message_thread_id}`;
}
function loadState(stateDir) {
  try {
    const raw = JSON.parse(readFileSync(join(stateDir, "state.json"), "utf8"));
    const topics = Object.fromEntries(Object.entries(raw.topics || {})
      .filter(([, info]) => typeof info?.cwd === "string" && existsSync(info.cwd)).map(([id, info]) => [id, { cwd: info.cwd }]));
    const herdrPanes = Object.fromEntries(Object.entries(raw.herdrPanes || {})
      .filter(([, pane]) => pane && typeof pane === "object" && typeof pane.cwd === "string")
      .map(([key, { cwd, paneId, terminalId, sessionFile, workspaceId, owned }]) => [key, {
        cwd, ...(paneId ? { paneId } : {}), ...(sessionFile ? { sessionFile } : {}),
        ...(terminalId ? { terminalId } : {}), ...(workspaceId ? { workspaceId } : {}), owned: owned === true,
      }]));
    return { cwd: typeof raw.cwd === "string" ? raw.cwd : null, topics, herdrPanes, pendingRestartMessageId: Number.isSafeInteger(raw.pendingRestartMessageId) && raw.pendingRestartMessageId > 0 ? raw.pendingRestartMessageId : null };
  } catch { return { cwd: null, topics: {}, herdrPanes: {} }; }
}

function loadConfig() {
  const path = process.env.REMOTE_PI_CONFIG || join(homedir(), ".config", "remote-pi", "config.json");
  const configDir = dirname(path);
  let file = {};
  try { file = JSON.parse(readFileSync(path, "utf8")); } catch (error) {
    if (error.code !== "ENOENT") throw new Error(`Failed to parse config file ${path}: ${error.message}`);
  }

  const stateDir = resolvePath(file.stateDir || join(homedir(), ".local", "var", "remote-pi"), configDir);
  const savedState = loadState(stateDir);
  const targetCwd = savedState.cwd || (file.cwd ? resolvePath(file.cwd, configDir) : null);
  if (!targetCwd) throw new Error(`"cwd" is required: set "cwd" in ${path}`);

  const telegram = file.telegram && typeof file.telegram === "object" ? file.telegram : {};
  const config = {
    botToken: telegram.botToken, allowedUserId: String(telegram.allowedUserId || ""),
    cwd: targetCwd, configPath: path, stateDir, downloadsDir: join(stateDir, "downloads"),
    presenceFile: file.presenceFile ? resolvePath(file.presenceFile, configDir) : "",
    logFile: resolvePath(process.env.REMOTE_PI_LOG_FILE || file.logFile || join(homedir(), ".local", "var", "log", "remote-pi.log"), configDir),
    sttCommand: file.sttCommand || "",
  };
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(config.botToken || "")) throw new Error(`Invalid telegram.botToken in ${path}`);
  if (!/^\d+$/.test(config.allowedUserId)) throw new Error(`Invalid telegram.allowedUserId in ${path}`);
  try { if (statSync(config.cwd).isDirectory()) return config; } catch {}
  throw new Error(`Pi working directory does not exist or is not a directory: ${config.cwd}`);
}

class Telegram {
  constructor(token, offsetPath) {
    Object.assign(this, {
      base: `https://api.telegram.org/bot${token}`, fileBase: `https://api.telegram.org/file/bot${token}`, offsetPath,
      currentPollAc: null, polling: false, pollFailures: 0, outageStart: 0, inConflict: false,
    });
  }
  async call(method, body = {}, timeout = 35_000, maxAttempts = 3, signal = null, quiet = false) {
    for (let attempt = 1; ; attempt++) {
      let status, retryAfter;
      try {
        const reqSignal = signal ? AbortSignal.any([AbortSignal.timeout(timeout), signal]) : AbortSignal.timeout(timeout);
        const res = await fetch(`${this.base}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: reqSignal });
        const data = await res.json();
        if (res.ok && data.ok) {
          if (method !== "getUpdates" || data.result?.length) log("tg:call", `${method} ok${method === "getUpdates" ? ` (updates: ${data.result.length})` : ""}`);
          return data.result;
        }
        status = res.status;
        retryAfter = data.parameters?.retry_after;
        throw new Error(`Telegram ${method}: ${data.description || status}`);
      } catch (error) {
        if (signal?.aborted) throw error;
        if (!quiet) log("tg:call", `${method} attempt ${attempt}/${maxAttempts} failed:`, error.message);
        if (attempt >= maxAttempts || !shouldRetryTelegram(method, { status, error })) throw error;
        // ref: https://core.telegram.org/bots/api#responseparameters — 429 retries honor retry_after.
        await sleep((retryAfter || attempt) * 1000);
      }
    }
  }
  async htmlMessage(method, fields, text, extra = {}) {
    const plain = String(text || "(empty)"), editing = method === "editMessageText";
    try {
      return await this.call(method, { ...fields, text: telegramHtml(plain), parse_mode: "HTML", ...extra });
    } catch (error) {
      const msg = String(error.message || "");
      if (!msg.includes("can't parse entities") && !msg.includes("message is too long")) {
        if (editing && msg.includes("message is not modified")) return;
        throw error;
      }
      // ref: https://core.telegram.org/bots/api#sendmessage — HTML parse/length failures may fall back to plain text.
      log("tg:call", "HTML parse/length fallback:", error.message);
      const length = editing ? Math.min(4000, plain.length) : plain.length;
      const base = { message_thread_id: extra.message_thread_id, disable_notification: extra.disable_notification };
      let last;
      for (let i = 0; i < length; i += 4000) last = await this.call(method, {
        ...fields, text: plain.slice(i, i + 4000), ...(i + 4000 >= length ? extra : base),
      });
      return last;
    }
  }
  sendOne(chatId, text, extra = {}) { return this.htmlMessage("sendMessage", { chat_id: chatId }, text, extra); }
  async send(chatId, text, extra = {}) {
    let last;
    const parts = chunks(text), base = {};
    if (extra?.message_thread_id) base.message_thread_id = extra.message_thread_id;
    if (extra?.disable_notification) base.disable_notification = extra.disable_notification;
    for (let i = 0; i < parts.length; i++) last = await this.sendOne(chatId, parts[i], i === parts.length - 1 ? extra : base);
    return last;
  }
  edit(chatId, messageId, text) { return this.htmlMessage("editMessageText", { chat_id: chatId, message_id: messageId }, text); }
  answer(callbackQueryId, text = "") { return this.call("answerCallbackQuery", { callback_query_id: callbackQueryId, text }).catch((error) => log("tg:call", error)); }
  async sendDocument(chatId, path, extra = {}) {
    const form = new FormData();
    form.set("chat_id", String(chatId));
    if (extra?.message_thread_id) form.set("message_thread_id", String(extra.message_thread_id));
    form.set("document", await openAsBlob(path), basename(path));
    const response = await fetch(`${this.base}/sendDocument`, { method: "POST", body: form, signal: AbortSignal.timeout(60_000) });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(`Telegram sendDocument: ${data.description || response.status}`);
    log("tg:call", `sendDocument ok`);
  }
  // ref: https://core.telegram.org/bots/api#sendmessagedraft — can_stop shows Stop; sendMessage persists the final reply.
  draft(chatId, draftId, text, extra = {}) {
    return this.call("sendMessageDraft", { chat_id: chatId, draft_id: draftId, text: text ? telegramHtml(text) : "", parse_mode: "HTML", can_stop: true, ...extra }, 10_000, 1);
  }
  // ref: https://core.telegram.org/bots/api#setmessagereaction — one emoji per bot, [] clears it.
  async react(chatId, messageId, emoji) {
    if (!messageId) return null;
    try {
      return await this.call("setMessageReaction", { chat_id: chatId, message_id: messageId, reaction: emoji ? [{ type: "emoji", emoji }] : [] }, 10_000, 1);
    } catch { return null; }
  }
  stopPolling() {
    this.polling = false;
    this.currentPollAc?.abort("stop");
    this.currentPollAc = null;
  }
  // ref: https://nodejs.org/api/fs.html#fspromiseswritefilefile-data-options — serialize writes to the shared temporary path.
  saveOffset(mark) {
    if (mark <= (this.savedOffset || 0)) return this.offsetWriteChain;
    this.savedOffset = mark;
    this.offsetWriteChain = (this.offsetWriteChain || Promise.resolve()).catch(() => {}).then(async () => {
      await writeFile(`${this.offsetPath}.tmp`, String(mark), { mode: 0o600 });
      await rename(`${this.offsetPath}.tmp`, this.offsetPath);
    });
    return this.offsetWriteChain;
  }
  async poll(handler) {
    let offset = this.savedOffset = Number(await readFile(this.offsetPath, "utf8").catch(() => "0")) || 0;
    let persistChain = Promise.resolve();
    this.polling = true;
    while (this.polling) {
      try {
        this.currentPollAc = new AbortController();
        const updates = await this.call("getUpdates", { offset, timeout: 25, allowed_updates: ["message", "callback_query", "stopped_message_generation"] }, 35_000, 1, this.currentPollAc.signal, true);
        this.currentPollAc = null;
        if (!this.polling) break;
        this.inConflict = false;
        if (this.pollFailures) log("tg:poll", `back online after ${Math.round((Date.now() - this.outageStart) / 1000)}s (${this.pollFailures} failed polls)`);
        this.pollFailures = this.outageStart = 0;
        for (const update of updates) {
          if (!this.polling) break;
          offset = update.update_id + 1;
          const done = handler(update), mark = offset;
          if (done) persistChain = persistChain.then(() => done).then(() => this.saveOffset(mark))
            .catch((err) => log("tg:poll", `offset persist:`, err.message));
        }
      } catch (error) {
        this.currentPollAc = null;
        if (!this.polling) break;
        const conflict = error.message?.includes("Conflict");
        if (conflict && !this.inConflict) log("tg:poll", `conflict: ${error.message}`);
        if (!conflict && ++this.pollFailures === 1) {
          this.outageStart = Date.now();
          log("tg:poll", `offline: ${error.message}; retrying with backoff`);
        }
        this.inConflict = conflict;
        this.currentPollAc = new AbortController();
        await sleep(conflict ? 15_000 : pollBackoffMs(this.pollFailures), undefined, { signal: this.currentPollAc.signal }).catch(() => {});
        this.currentPollAc = null;
      }
    }
  }
}

const paneHasForegroundShell = (info) => Number.isInteger(info?.shell_pid) && info.shell_pid > 0 && info.foreground_process_group_id === info.shell_pid;

// ref: Pi docs/rpc.md#framing; Node net IPC sockets. The directory is private and the socket is mode 0600.
const matchesBinding = (binding, hello) => Boolean(binding.sessionFile) && binding.sessionFile === hello.sessionFile ||
  binding.paneId === hello.paneId && Boolean(binding.terminalId) && binding.terminalId === hello.terminalId;
class PaneServer {
  constructor(path, onHello) {
    Object.assign(this, { path, onHello, connections: new Map(), sockets: new Set(),
      waiters: new Set(), server: null, starting: null, closed: false });
  }
  async start() {
    if (this.server) return;
    this.starting ??= this.listen().finally(() => { this.starting = null; });
    return this.starting;
  }
  async listen() {
    this.closed = false;
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    // Gateway.start holds the gateway lock before opening this socket; never delete a non-socket.
    const old = await lstat(this.path).catch((error) => { if (error.code !== "ENOENT") throw error; });
    if (old) {
      if (!old.isSocket() || old.uid !== process.getuid()) throw new Error(`Unsafe bridge socket path: ${this.path}`);
      await unlink(this.path);
    }
    const server = net.createServer((socket) => {
      this.sockets.add(socket);
      let connection, chain = Promise.resolve();
      const handshake = setTimeout(() => socket.destroy(), 5000).unref();
      socket.on("error", () => {});
      socket.on("close", () => {
        clearTimeout(handshake);
        this.sockets.delete(socket);
        if (!connection || this.connections.get(connection.hello.paneId) !== connection) return;
        this.connections.delete(connection.hello.paneId);
        for (const rpc of [...connection.clients]) rpc.disconnected(connection);
      });
      readJsonLines(socket, (record) => {
        chain = chain.then(async () => {
          if (socket.destroyed) return;
          if (record.type === "hello") {
            if (record.version !== 1 || record.terminalId !== undefined && typeof record.terminalId !== "string" || typeof record.paneId !== "string" || !record.paneId || typeof record.cwd !== "string" || !record.cwd.startsWith("/") || typeof record.sessionFile !== "string" || !record.sessionFile.startsWith("/") || typeof record.sessionId !== "string" || !Number.isInteger(record.pid) || record.pid <= 0) throw new Error("Invalid bridge hello");
            clearTimeout(handshake);
            const duplicate = [...this.connections.values()].find((c) => c.hello.sessionFile === record.sessionFile && c.hello.paneId !== record.paneId);
            if (duplicate) throw new Error(`Session already served by ${duplicate.hello.paneId}`);
            const previous = this.connections.get(record.paneId);
            connection = connection || { socket, clients: new Set() };
            connection.hello = record;
            this.connections.set(record.paneId, connection);
            if (previous && previous !== connection) {
              for (const rpc of [...previous.clients]) {
                if (matchesBinding(rpc.session.binding, record)) rpc.bind(connection); else rpc.disconnected(previous);
              }
              previous.socket.destroy();
            }
            await this.onHello?.(connection);
            for (const waiter of [...this.waiters]) waiter.check();
          } else {
            if (!connection) throw new Error("Bridge hello required");
            for (const rpc of [...connection.clients]) rpc.receive(record);
          }
        }).catch((error) => socket.destroy(error));
      });
    });
    server.on("error", (error) => log("bridge", `${error.message}`));
    await once(server.listen(this.path), "listening");
    await chmod(this.path, 0o600);
    this.server = server.unref();
  }
  find(binding) {
    return [...this.connections.values()].find((c) => !c.socket.destroyed && c.socket.writable && matchesBinding(binding, c.hello));
  }
  waitFor(predicate, timeout = 30_000) {
    return new Promise((done, reject) => {
      const finish = (error, value) => {
        clearTimeout(timer);
        this.waiters.delete(waiter);
        if (error) reject(error); else done(value);
      };
      const waiter = { check: () => {
        const connection = [...this.connections.values()].find((c) => !c.socket.destroyed && c.socket.writable && predicate(c));
        if (connection) finish(null, connection);
      }, cancel: () => finish(new Error("Bridge server stopped")) };
      const timer = setTimeout(() => finish(new Error("Timed out waiting for Pi bridge hello")), timeout);
      this.waiters.add(waiter);
      waiter.check();
    });
  }
  async stop() {
    this.closed = true;
    for (const waiter of [...this.waiters]) waiter.cancel();
    for (const socket of this.sockets) socket.destroy();
    const server = this.server;
    this.server = null;
    if (server) await new Promise((done) => server.close(done));
  }
}

// Stopping this view or the gateway never stops the interactive Pi.
class PaneRpc {
  constructor(session, onEvent, onClose) {
    Object.assign(this, { session, gateway: session.gateway, onEvent, onClose, proc: null,
      connection: null, pending: new Map(), starting: null, stopping: false });
  }
  async ensureStarted() {
    if (this.proc && !this.proc.destroyed) return;
    this.stopping = false;
    this.starting ??= this.gateway.ensurePaneSession(this).finally(() => { this.starting = null; });
    return this.starting;
  }
  finish(id, error, data = {}) {
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    if (error) pending.reject(error); else pending.done(data);
  }
  bind(connection) {
    this.stopping = false;
    this.connection?.clients.delete(this);
    this.connection = connection;
    connection.clients.add(this);
    this.proc = connection.socket;
    this.session.binding = { ...this.session.binding, paneId: connection.hello.paneId, terminalId: connection.hello.terminalId,
      sessionFile: connection.hello.sessionFile, cwd: connection.hello.cwd };
    this.session.cwd = connection.hello.cwd;
    this.gateway.syncBlockedSubscription();
    for (const [id, pending] of this.pending) {
      if (pending.replacing && pending.from === connection.hello.previousSessionFile && ["new", "resume"].includes(connection.hello.reason)) this.finish(id, null, { cancelled: false });
    }
  }
  receive(record) {
    const pending = this.pending.get(record.id);
    if (record.type === "session_replacing") {
      if (pending?.type === record.command) pending.replacing = true;
    } else if (record.type === "response") {
      if (pending?.type === record.command) this.finish(record.id, record.success ? null : new Error(record.error || "Pi bridge request failed"), record.data || {});
    } else this.onEvent(record);
  }
  disconnected(connection) {
    if (this.connection !== connection) return;
    this.proc = this.connection = null;
    connection.clients.delete(this);
    this.gateway.syncBlockedSubscription();
    const replacing = [...this.pending.values()].some((p) => p.replacing);
    for (const [id, pending] of this.pending) {
      if (!pending.replacing) this.finish(id, new Error("Pi bridge disconnected; command delivery may be incomplete"));
    }
    if (!replacing) this.onClose?.({ expected: this.stopping || this.gateway.bridge.closed });
  }
  async request(type, fields = {}, timeout) {
    await this.ensureStarted();
    if (!Number.isFinite(timeout)) timeout = ["new_session", "switch_session"].includes(type) ? 60_000 : 600_000;
    const id = `pane-${randomBytes(12).toString("hex")}`;
    return new Promise((done, reject) => {
      const timer = setTimeout(() => this.finish(id, new Error(`Pi bridge ${type} timed out; not retried`)), timeout);
      this.pending.set(id, { type, done, reject, timer, from: this.session.binding.sessionFile });
      try { this.write({ id, type, ...fields }); } catch (error) {
        this.finish(id, error);
      }
    });
  }
  write(record) {
    if (!writeJsonLine(this.proc, record)) throw new Error("Pi bridge is not connected");
  }
  stop() {
    this.stopping = true;
    this.connection?.clients.delete(this);
    this.proc = this.connection = null;
    for (const id of this.pending.keys()) this.finish(id, new Error("Pi view detached"));
    this.gateway.syncBlockedSubscription();
  }
}

// A Telegram view of a native interactive Pi; multiple views may share the same PaneRpc connection.
class ChatSession {
  constructor(gateway, { threadId = null, cwd }) {
    Object.assign(this, { gateway, threadId, key: threadId ? `t:${threadId}` : "main", cwd, chatId: gateway.chatId });
    this.binding = { cwd, ...gateway.state.herdrPanes?.[this.key] };
    Object.assign(this, {
      run: null, lastDraftAt: -Infinity, nextOrigin: "telegram", nextTrigger: null,
      isStreaming: false, lastModel: null, lastPrompt: null, lastTopicName: null,
      mediaGroups: new Map(), eventChain: Promise.resolve(), updateChain: Promise.resolve(), uploadChain: Promise.resolve(),
    });
    this.pi = new PaneRpc(this, (event) => this.queueEvent(event), ({ expected }) => { if (!expected) this.clearRun(true); });
  }
  threadExtra(extra = {}) { return this.threadId ? { message_thread_id: this.threadId, ...extra } : extra; }
  async send(text, extra = {}) {
    if (this.closed) return;
    try { return await this.gateway.telegram.send(this.chatId, text, this.threadExtra(extra)); } catch (error) {
      if (!this.threadId || !/message thread not found|TOPIC_DELETED|TOPIC_ID_INVALID/i.test(error.message)) throw error;
      await this.gateway.closeTopic(this.threadId, { deleteTopic: false });
    }
  }
  action(payload, ttl = 10 * 60_000) { return this.gateway.action({ ...payload, sessionKey: this.key }, ttl); }
  keyboard(items, ttl) { return { reply_markup: { inline_keyboard: items.map(({ label, action }) => [{ text: label.slice(0, 60), callback_data: this.action(action, ttl) }]) } }; }
  queueEvent(event) { this.eventChain = this.eventChain.then(() => this.handleEvent(event)).catch((error) => log("bridge", `Pi event [${this.key}]:`, error)); }
  clearRun(aborted = false) {
    const run = this.run;
    if (run) {
      clearInterval(run.timer);
      const emoji = run.error ? "💔" : aborted || run.aborted ? null : run.replied ? "👌" : "🤷";
      void this.gateway.telegram.react(this.chatId, run.trigger, emoji);
    }
    Object.assign(this, { run: null, isStreaming: false });
  }
  ensureRun(trigger = null) {
    if (this.run) return;
    this.isStreaming = true;
    this.run = {
      trigger, origin: this.nextOrigin, draftId: randomBytes(4).readUInt32BE() || 1,
      text: "", tool: null, replied: false, error: false, aborted: false,
    };
    Object.assign(this, { nextTrigger: null, nextOrigin: "telegram" });
    void this.gateway.telegram.react(this.chatId, trigger, "👨‍💻");
    void this.tickRun();
    this.run.timer = setInterval(() => { void this.tickRun(); }, 1000).unref();
  }
  async tickRun(now = Date.now()) {
    const run = this.run;
    if (!run || run.disabled || run.delivering || run.pending || now - this.lastDraftAt < 1500) return;
    const tail = run.text ? chunks(run.text, 3500).at(-1) : "";
    const text = [tail, run.tool ? `⚙️ ${run.tool.slice(0, 300)}` : ""].filter(Boolean).join("\n\n");
    if (!text && run.replied || text === run.sent && now - this.lastDraftAt < 20_000) return;
    run.sent = text;
    this.lastDraftAt = now;
    run.pending = this.gateway.telegram.draft(this.chatId, run.draftId, text, this.threadExtra()).catch((error) => {
      run.disabled = true;
      log("draft", `[${this.key}] disabled:`, error.message);
    }).finally(() => { run.pending = null; });
    await run.pending;
  }
  resetSessionState() {
    this.clearRun(true);
    Object.assign(this, { nextTrigger: null, nextOrigin: "telegram" });
    for (const group of this.mediaGroups.values()) {
      clearTimeout(group.timer);
      group.cancelled = true;
      group.resolveReady();
    }
    this.mediaGroups.clear();
    for (const [key, action] of this.gateway.actions) {
      if (action.type === "ui" && action.sessionKey === this.key) this.gateway.actions.delete(key);
    }
    this.uiMessages?.clear();
  }
  async prompt(message, images, streamingBehavior, triggerMessageId = null) {
    const behavior = streamingBehavior || (this.isStreaming ? "steer" : undefined);
    if (!behavior) {
      this.lastPrompt = { message, images, triggerMessageId };
      this.nextTrigger = triggerMessageId;
      this.nextOrigin = "telegram";
    }
    const fields = { message, ...(images ? { images } : {}), ...(behavior ? { streamingBehavior: behavior } : {}) };
    try {
      await this.pi.request("prompt", fields);
    } catch (error) {
      if (behavior || !/streaming/i.test(error.message)) throw error;
      this.nextTrigger = null;
      await this.pi.request("prompt", { ...fields, streamingBehavior: "steer" });
      this.isStreaming = true;
    }
    if (behavior === "followUp") await this.send("↪ Queued as follow-up", { disable_notification: true });
  }
  async abortRun(shouldAbort = this.pi.proc) {
    this.clearRun(true);
    if (shouldAbort) await this.pi.request("abort").catch(() => {});
    this.resetSessionState();
  }
  async newSession() {
    await this.abortRun();
    try {
      const before = this.pi.proc ? await this.pi.request("get_state").catch(() => null) : null;
      const target = before?.model?.provider && before.model.id ? { provider: before.model.provider, modelId: before.model.id } : this.lastModel;
      if ((await this.pi.request("new_session")).cancelled) return this.send("New session cancelled");
      if (target) {
        await this.pi.request("set_model", target).catch((err) => {
          log("new", `failed to restore model ${target.provider}/${target.modelId}: ${err.message}`);
        });
        this.lastModel = target;
      }
      const state = await this.pi.request("get_state").catch(() => null);
      return this.send(`✅ New session started${state?.model ? ` · ${state.model.provider}/${state.model.id}` : ""}`);
    } catch (error) { return this.send(`❌ ${error.message}`); }
  }
  async handleCommand({ name, argument }, original, updateId = null, triggerMessageId = null) {
    const simple = {
      start: "showHelp", help: "showHelp", model: "showModels", thinking: "showThinking",
      resume: "showSessions", status: "showSession", new: "newSession",
    };
    if (Object.hasOwn(simple, name)) return this[simple[name]](argument);
    switch (name) {
      case "topic": return this.gateway.handleTopicCommand(this, argument);
      case "close": return this.gateway.handleCloseCommand(this);
      case "name":
        if (!argument) return this.send("Usage: /name <session-name>");
        await this.pi.request("set_session_name", { name: argument });
        return this.send(`✅ Session name set to: ${argument}`);
      case "compact": {
        const res = await this.pi.request("compact", argument ? { customInstructions: argument } : {});
        return this.send(res?.tokensBefore ? `Context compacted: ${res.tokensBefore} → ~${res.estimatedTokensAfter} tokens` : "Context compacted.");
      }
      case "followup":
        if (!argument) return this.send("Usage: /followup <message>");
        return this.prompt(argument, undefined, "followUp", triggerMessageId);
      case "abort":
        await this.abortRun();
        return this.send("⏹ Stopped (queued messages kept)");
      case "restart": {
        const message = await this.send("🔄 Restarting gateway…");
        await this.gateway.saveState({ pendingRestartMessageId: message.message_id });
        if (updateId) await this.gateway.telegram.saveOffset(updateId + 1);
        this.gateway.stop();
        setTimeout(() => process.exit(0), 100);
        return;
      }
      case "sh": {
        if (!argument) return this.send("Usage: /sh <command>");
        if (/install\.sh\s+(restart|stop|uninstall)|launchctl\s+(bootout|kickstart)/i.test(argument)) return this.send("❌ Service restart/stop commands are blocked here. Send /restart to restart the gateway.");
        try {
          const res = await this.pi.request("bash", { command: argument });
          const output = res.output ? res.output.trim() : "(no output)";
          return this.send(output.split("\n").length > 3 ? expandableBlockquote(output) : output);
        } catch (error) {
          if (!/abort/i.test(error.message)) return this.send(`❌ ${error.message}`);
        }
        return;
      }
    }
    const data = await this.pi.request("get_commands");
    const targets = commandRoutes(data.commands).get(name);
    if (targets?.size > 1) return this.send(`Ambiguous command: /${name}\nMatches: ${[...targets].map((target) => `/${target}`).join(", ")}\nUse an unambiguous native name from /help, or run it in the Pi terminal.`);
    if (targets?.size === 1) return this.prompt(`/${[...targets][0]}${argument ? ` ${argument}` : ""}`, undefined, undefined, triggerMessageId);
    return this.send(`Unknown command: /${name}\nUse /help`);
  }
  async handleMediaGroup(messages) {
    const media = (await Promise.all(messages.map((m) => this.gateway.extractMedia(m)))).filter(Boolean);
    const files = media.map((m) => m.saved), images = media.map((m) => m.image).filter(Boolean);
    const caption = messages.filter((m) => m.caption).at(-1)?.caption;
    if (files.length || caption) {
      await this.prompt(files.length ? attachmentPrompt(caption || "Please review these files.", files) : caption,
        images.length ? images : undefined, undefined, messages[0]?.message_id);
    }
  }
  async showHelp() {
    await this.send(HELP);
    if (!this.pi.proc) return;
    const data = await this.pi.request("get_commands");
    if (!data.commands.length) return;
    const routes = commandRoutes(data.commands);
    const text = data.commands.map((item) => {
      const name = telegramCommandName(item);
      const issue = RESERVED_COMMANDS.has(name) ? `Telegram /${name} is gateway-reserved; use Pi terminal`
        : routes.get(name)?.size > 1 ? `Telegram /${name} is ambiguous; use an unambiguous native name or Pi terminal` : "";
      return `/${item.name}${item.description ? ` — ${item.description}` : ""}${issue ? ` [${issue}]` : ""}`;
    }).join("\n");
    await this.send(text);
  }
  async showModels(query) {
    const data = await this.pi.request("get_available_models");
    const models = data.models || [];
    const exact = query && models.find((m) => `${m.provider}/${m.id}` === query || m.id === query);
    if (exact) return this.gateway.handleCallback(null, this, { type: "model", provider: exact.provider, modelId: exact.id });
    const filtered = models.filter((m) => !query || `${m.provider}/${m.id} ${m.name}`.toLowerCase().includes(query.toLowerCase()));
    if (!filtered.length) return this.send(`No matching model: ${query}`);
    const suffix = filtered.length > 18 ? `\n\n(${filtered.length} models; showing first 18 — use /model <query> to filter)` : "";
    return this.send(`Pick a model:${suffix}`, this.keyboard(filtered.slice(0, 18).map((m) => ({ label: `${m.provider}/${m.id}`, action: { type: "model", provider: m.provider, modelId: m.id } }))));
  }
  async showThinking(argument) {
    const data = await this.pi.request("get_available_thinking_levels");
    if (argument) {
      if (!data.levels.includes(argument)) return this.send(`Available levels: ${data.levels.join(", ")}`);
      return this.gateway.handleCallback(null, this, { type: "thinking", level: argument });
    }
    return this.send("Pick a thinking level:", this.keyboard(data.levels.map((l) => ({ label: l, action: { type: "thinking", level: l } }))));
  }
  async showSessions() {
    const { sessions } = await this.pi.request("list_sessions");
    if (!sessions.length) return this.send("No past sessions for this directory yet.");
    return this.send("Pick a session:", this.keyboard(sessions.map((s) => ({ label: s.title, action: { type: "resume", path: s.path } }))));
  }
  async showSession() {
    const [state, stats] = await Promise.all([this.pi.request("get_state"), this.pi.request("get_session_stats")]);
    const model = state.model ? `${state.model.provider}/${state.model.id}` : "none";
    const context = stats.contextUsage ? `${stats.contextUsage.tokens ?? "?"}/${stats.contextUsage.contextWindow} (${stats.contextUsage.percent ?? "?"}%)` : "n/a";
    await this.send([
      `Name: ${state.sessionName || "(unnamed)"}`, `Model: ${model}`, `Thinking: ${state.thinkingLevel}`,
      `State: ${state.isStreaming ? "working" : "idle"}`, `Context: ${context}`,
      `Cost: $${Number(stats.cost || 0).toFixed(4)}`, `Session: ${state.sessionId}`, `File: ${state.sessionFile || "not persisted"}`,
    ].join("\n"));
  }
  async handleEvent(event) {
    if (event.type === "remote_user_input") {
      Object.assign(this, { nextOrigin: "terminal", nextTrigger: null });
      await this.send(`🖥 ${event.text}`, { disable_notification: true });
      return;
    }
    if (event.type === "session_info_changed") {
      if (!this.threadId) return;
      const newName = `${this.binding.owned === false ? "📡 " : ""}${(event.name || basename(this.cwd) || "topic").trim()}`.slice(0, 128);
      if (this.lastTopicName === newName) return;
      this.lastTopicName = newName;
      // ref: https://core.telegram.org/bots/api#editforumtopic — private chats support topic names.
      await this.gateway.telegram.call("editForumTopic", { chat_id: this.chatId, message_thread_id: this.threadId, name: newName })
        .catch((error) => log("topic", `failed to rename topic ${this.threadId}: ${error.message}`));
      return;
    }
    if (event.type === "extension_ui_resolved") {
      for (const [key, action] of this.gateway.actions) {
        if (action.type === "ui" && action.requestId === event.id && action.sessionKey === this.key) this.gateway.actions.delete(key);
      }
      const messageId = this.uiMessages?.get(event.id);
      this.uiMessages?.delete(event.id);
      if (messageId) await this.gateway.telegram.call("editMessageReplyMarkup", { chat_id: this.chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } }).catch(() => {});
      return;
    }
    if (event.type === "agent_start") this.ensureRun(this.nextTrigger);
    if (event.type === "tool_execution_start" || event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta" ||
      ["message_start", "message_end"].includes(event.type) && event.message?.role === "assistant") this.ensureRun();
    if (event.type === "agent_settled") this.clearRun(event.aborted);
    if (!this.gateway.chatReady) return;
    if (event.type === "compaction_end" && event.errorMessage) await this.send(`⚠️ Context compaction failed: ${event.errorMessage}`, { disable_notification: true });
    const run = this.run;
    if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta" && run) run.text += event.assistantMessageEvent.delta;
    if (event.type === "message_end" && event.message?.role === "assistant" && run) {
      const message = event.message;
      let text = extractText(message.content);
      if (message.stopReason === "aborted") run.aborted = true;
      run.error = Boolean(message.stopReason === "error" || message.errorMessage);
      if (run.error) text = [text, formatAssistantError(message.errorMessage)].filter(Boolean).join("\n\n");
      run.delivering = true;
      try {
        await run.pending;
        if (this.run !== run) return;
        if (text) {
          const extra = { disable_notification: message.stopReason === "toolUse" || run.origin !== "telegram" || this.gateway.isUserPresent() };
          if ((message.stopReason === "error" || message.errorMessage) && this.lastPrompt) Object.assign(extra, this.keyboard([{ label: "🔁 Retry", action: { type: "retry" } }]));
          await this.send(text, extra);
          run.replied = true;
        }
        Object.assign(run, { text: "", draftId: randomBytes(4).readUInt32BE() || 1 });
      } finally { run.delivering = false; }
    }
    if (event.type === "tool_execution_start") {
      if (run) run.tool = toolSummary(event.toolName, event.args);
      // ref: https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html — never log tool arguments.
      log("tool", `start: ${event.toolName}`);
    }
    if (event.type === "tool_execution_end") {
      if (run) run.tool = null;
      if (event.toolName === "remote_attach" && !event.isError) {
        const rawPaths = event.result?.details?.paths || event.args?.paths || [];
        const paths = event.result?.details?.paths ? rawPaths : rawPaths.map((p) => resolve(this.cwd, p));
        for (const path of paths) {
          this.uploadChain = this.uploadChain.then(() => this.gateway.telegram.sendDocument(this.chatId, path, this.threadExtra()))
            .catch((error) => this.send(`❌ Failed to send attachment ${basename(path)}: ${error.message}`))
            .catch((error) => log("upload", error));
        }
      }
    }
    if (event.type === "extension_ui_request") await this.handleUiRequest(event);
    if (event.type === "extension_error") await this.send(`❌ Extension ${event.extensionPath}: ${event.error}`);
  }
  async handleUiRequest(request) {
    if (request.method !== "select" || this.uiMessages?.has(request.id) && [...this.gateway.actions.values()]
      .some((a) => a.type === "ui" && a.sessionKey === this.key && a.requestId === request.id && a.expires > Date.now())) return;
    const sent = await this.send([request.title, request.message].filter(Boolean).join("\n"), {
      ...this.keyboard(request.options.map((value) => ({ label: value, action: { type: "ui", requestId: request.id, response: { value } } }))),
      disable_notification: this.gateway.isUserPresent(),
    });
    if (sent?.message_id) (this.uiMessages ||= new Map()).set(request.id, sent.message_id);
  }
  stop() {
    this.resetSessionState();
    this.pi?.stop?.();
  }
}

class Gateway {
  constructor(config) {
    Object.assign(this, {
      config, chatId: config.allowedUserId, chatReady: false, state: loadState(config.stateDir),
      telegram: new Telegram(config.botToken, join(config.stateDir, "telegram-offset")), actions: new Map(),
      stateWriteChain: Promise.resolve(), paneStartChain: Promise.resolve(), downloadCleanupTimer: null,
      blockedStatuses: new Map(), subscribedPanesKey: "", herdrSocketPath: null, herdrSubSocket: null, herdrSubTimer: null, herdrSubRetries: 0,
      stopping: false,
      bridge: new PaneServer(join(config.stateDir, "bridge.sock"), (connection) => this.onPaneHello(connection)),
    });
    this.mainSession = new ChatSession(this, { threadId: null, cwd: config.cwd });
    this.sessions = new Map([["main", this.mainSession]]);
    // 延迟初始化 state.json 中持久化的有效 topic 会话
    for (const [threadId, info] of Object.entries(this.state.topics)) {
      const tid = Number(threadId);
      this.sessions.set(`t:${tid}`, new ChatSession(this, { threadId: tid, cwd: info.cwd }));
    }
  }
  // ref: Claude Code Remote Control CLAUDE_CLIENT_PRESENCE_FILE skips phone pushes while present (https://code.claude.com/docs/en/remote-control)
  isUserPresent() { return Boolean(this.config?.presenceFile && existsSync(this.config.presenceFile)); }
  async persistPaneSession(session) {
    this.state.herdrPanes = { ...this.state.herdrPanes, [session.key]: { ...session.binding, cwd: session.cwd } };
    if (session.threadId !== null) this.state.topics[session.threadId] = { ...this.state.topics[session.threadId], cwd: session.cwd };
    await this.saveState({ herdrPanes: this.state.herdrPanes, topics: this.state.topics });
  }
  async onPaneHello(connection) {
    const hello = connection.hello;
    let targets = [...this.sessions.values()].filter((s) => matchesBinding(s.binding, hello));
    if (!targets.length) {
      if (!this.chatReady) return;
      const me = this.me || await this.telegram.call("getMe");
      if (!me?.has_topics_enabled) {
        log("bridge", `Topics must be enabled to attach desktop pane ${hello.paneId}`);
        return;
      }
      const topicTitle = `📡 ${hello.sessionName || hello.recent?.firstUserText || basename(hello.cwd) || "Pi"}`.slice(0, 128);
      const session = await this.createTopic({ cwd: hello.cwd, name: topicTitle,
        binding: { paneId: hello.paneId, terminalId: hello.terminalId, sessionFile: hello.sessionFile, cwd: hello.cwd, owned: false } });
      targets = [session];
      await session.send(`📡 Remote control on — ${hello.paneId}\n${hello.cwd}\nThe terminal and this topic share one Pi session.`);
      const recent = [["👤", hello.recent?.lastUserText], ["🤖", hello.recent?.lastAssistantText]]
        .filter(([, text]) => text).map(([icon, text]) => `${icon} ${text}`);
      if (recent.length) await session.send(recent.join("\n\n"), { disable_notification: true });
    }
    for (const session of targets) {
      if (session.threadId && !session.lastTopicName) {
        session.lastTopicName = `${session.binding.owned === false ? "📡 " : ""}${hello.sessionName || hello.recent?.firstUserText || basename(hello.cwd) || "Pi"}`.slice(0, 128);
      }
      const wasUnbound = !session.pi.proc;
      session.pi.bind(connection);
      const state = hello.state;
      if (state) {
        session.isStreaming = state.isStreaming; if (!state.isStreaming) session.clearRun();
        if (state.model) session.lastModel = { provider: state.model.provider, modelId: state.model.id };
      }
      await this.persistPaneSession(session);
      // Startup may register bot commands before Pi attached; refresh native aliases once the main view binds.
      if (wasUnbound && session.threadId === null) this.registerBotCommands().catch(() => {});
    }
  }
  // ref: Herdr AgentSessionInfo / pane.report_agent_session schema — native path identity, with the metadata fallback.
  async liveSessionPane(sessionFile) {
    const connected = this.bridge.find({ sessionFile });
    if (connected) return connected.hello.paneId;
    if (!this.herdrSocketPath) return null;
    const data = await this.herdr("agent.list", {});
    return (data?.agents || []).find((a) => a.agent === "pi" &&
      (a.agent_session?.kind === "path" && a.agent_session.value || a.tokens?.remote_pi_session) === sessionFile)?.pane_id || null;
  }
  ensurePaneSession(rpc, options = {}) {
    // Serialize starts, including sessions arriving concurrently from different topics.
    const work = this.paneStartChain.then(() => this.startPaneSession(rpc, options));
    this.paneStartChain = work.catch(() => {});
    return work;
  }
  // Returns true when rpc ends up bound to a live Pi pane. spawn:false attaches only —
  // a gateway (re)start must never create workspaces or launch Pi processes by itself.
  // ref: https://herdr.dev/docs/socket-api/; installed schema: pane_info / pane_process_info / workspace_created / agent_started / ok.
  async startPaneSession(rpc, { spawn = true } = {}) {
    const session = rpc.session, file = session.binding.sessionFile;
    if (HERDR_DISABLED_FOR_TEST && !this.bridge.server) throw new Error("Self-test must provide a fake connected pane");
    await this.bridge.start();
    let connection = this.bridge.find(session.binding);
    const livePane = !connection && file ? await this.liveSessionPane(file) : null;
    if (livePane && !await this.waitForShell(livePane, 1)) {
      // A live Pi without hello is not permission to create another writer.
      connection = await this.bridge.waitFor((c) => c.hello.sessionFile === file && c.hello.paneId === livePane);
    }
    if (!connection) {
      if (!spawn) return false;
      if (!this.herdrSocketPath) throw new Error("Herdr is required: install herdr and ensure its server is reachable");
      let pane, created = false;
      if (session.binding.owned && session.binding.paneId && session.binding.terminalId) {
        try { pane = (await this.herdr("pane.get", { pane_id: session.binding.paneId }))?.pane; } catch {}
        if (pane?.terminal_id !== session.binding.terminalId) pane = null;
      }
      if (!pane?.pane_id) {
        const label = `${basename(session.cwd) || "remote-pi"}${session.threadId ? `#${session.threadId}` : ""}`;
        try {
          pane = (await this.herdr("workspace.create", { cwd: session.cwd, label, focus: false }))?.root_pane;
          created = Boolean(pane?.pane_id);
        } catch (error) { log("herdr", `failed to create workspace for ${session.cwd}: ${error.message}`); }
      }
      if (!pane?.pane_id) throw new Error("Herdr is required: install herdr and ensure its server is reachable");
      const paneId = pane.pane_id;
      session.binding = { ...session.binding, paneId, terminalId: pane.terminal_id, workspaceId: pane.workspace_id, cwd: session.cwd, owned: true };
      await this.persistPaneSession(session);
      const shell = await this.waitForShell(paneId, created ? 10 : 1);
      if (!shell && pane.agent !== "pi") throw new Error(`Pane ${paneId} is busy; no terminal input was sent`);
      const waiting = this.bridge.waitFor((c) => matchesBinding(session.binding, c.hello));
      waiting.catch(() => {}); // agent start may outlive the hello deadline.
      if (shell) {
        // ref: Herdr `herdr api schema --json`: PaneReportMetadataParams — enable attachment without shell input.
        await this.herdr("pane.report_metadata", { pane_id: paneId, source: "remote-pi", tokens: { remote_pi: "on" } });
        await this.herdr("agent.start", { name: `remote-${randomBytes(6).toString("hex")}`, kind: "pi", pane_id: paneId,
          args: file ? ["--session", file] : [], timeout_ms: 45_000 });
      }
      connection = await waiting;
    }
    rpc.bind(connection);
    await this.persistPaneSession(session);
    return true;
  }
  async closePaneSession(session) {
    const otherViews = [...this.sessions.values()].filter((s) => s !== session && matchesBinding(s.binding, session.binding));
    for (const other of otherViews) {
      other.binding.owned ||= session.binding.owned;
      await this.persistPaneSession(other);
    }
    if (!otherViews.length && session.pi.proc) await session.pi.request(session.binding.owned ? "quit" : "remote_off", {}, 10_000);
    if (session.binding.owned && !otherViews.length && session.binding.paneId && this.herdrSocketPath) {
      const paneId = session.binding.paneId;
      let pane = null;
      try { pane = (await this.herdr("pane.get", { pane_id: paneId }))?.pane; } catch {}
      if (session.binding.terminalId && pane?.terminal_id === session.binding.terminalId) {
        if (!await this.waitForShell(paneId, 30)) throw new Error("Pi has not exited; pane and topic were kept");
        await this.herdr("pane.close", { pane_id: paneId });
      }
    }
    session.stop();
  }
  async closeTopic(threadId, { deleteTopic }) {
    const key = `t:${threadId}`, target = this.sessions.get(key);
    if (target) {
      target.closed = true;
      try { await this.closePaneSession(target); } catch (error) {
        if (deleteTopic) {
          target.closed = false;
          throw error;
        }
        log("topic", `deleted topic ${threadId}: ${error.message}`);
        target.stop();
      }
    }
    this.sessions.delete(key);
    delete this.state.topics[threadId];
    delete this.state.herdrPanes?.[key];
    await this.saveState({ topics: this.state.topics, herdrPanes: this.state.herdrPanes });
    if (deleteTopic) await this.telegram.call("deleteForumTopic", { chat_id: this.chatId, message_thread_id: threadId }).catch(() => {});
  }
  async createTopic({ cwd, name, binding, threadId }) {
    threadId ??= (await this.telegram.call("createForumTopic", { chat_id: this.chatId, name })).message_thread_id;
    const session = new ChatSession(this, { threadId, cwd });
    if (binding) session.binding = binding;
    session.lastTopicName = name;
    this.sessions.set(session.key, session);
    await this.persistPaneSession(session);
    return session;
  }
  // ref: https://nodejs.org/api/process.html#when-to-use-queuemicrotask-vs-processnexttick — register and enqueue before yielding.
  getOrCreateSession(message) {
    const key = sessionKeyOf(message);
    if (this.sessions.has(key)) return this.sessions.get(key);
    const session = new ChatSession(this, { threadId: Number(key.slice(2)), cwd: this.mainSession.cwd });
    this.sessions.set(key, session);
    void this.persistPaneSession(session).then(() => session.send(`Topic session started with workspace:\n${session.cwd}\n\nUse /topic <path> for another project.`))
      .catch((error) => log("topic", `Failed to initialize ${key}: ${error.message}`));
    return session;
  }
  async start() {
    // launchd 以 O_APPEND 持有日志 fd，newsyslog 处理不了这种 fd；启动时截断 + 每小时巡检（服务极少重启，只靠启动截断等于没截）
    const trimLog = () => stat(this.config.logFile).then((s) => s.size > MAX_LOG_SIZE ? truncate(this.config.logFile, 0) : null).catch(() => {});
    await trimLog();
    setInterval(trimLog, 60 * 60_000).unref();
    // ref: https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html — protect log and state permissions
    await chmod(this.config.logFile, 0o600).catch(() => {});
    for (const dir of [this.config.stateDir, this.config.downloadsDir]) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await chmod(dir, 0o700).catch(() => {});
    }
    await this.acquireLock();
    if (HERDR_DISABLED_FOR_TEST) throw new Error("Self-test cannot start the gateway");
    try {
      const { stdout } = await execFileAsync("herdr", ["status", "server", "--json"], { timeout: 5000, killSignal: "SIGKILL" });
      this.herdrSocketPath = JSON.parse(stdout).socket;
    } catch { throw new Error("Herdr is required: install herdr and ensure its server is reachable"); }
    await this.bridge.start();
    await this.telegram.call("deleteWebhook", { drop_pending_updates: false }).catch(() => {});
    this.me = await this.telegram.call("getMe");
    try {
      await this.telegram.call("getChat", { chat_id: this.chatId });
      this.chatReady = true;
    } catch (error) {
      if (!error.message.includes("chat not found")) throw error;
    }
    // Startup attaches only; the first message owns lazy Pi startup.
    const attached = await this.ensurePaneSession(this.mainSession.pi, { spawn: false }).catch(() => false);
    await this.registerBotCommands();
    this.syncBlockedSubscription();
    for (const connection of this.bridge.connections.values()) await this.onPaneHello(connection);
    this.cleanupDownloads();
    this.downloadCleanupTimer = setInterval(() => this.cleanupDownloads(), 24 * 60 * 60_000).unref();
    log("gateway", `@${this.me.username} ready; Pi ${attached ? "attached" : "not attached (starts on first message)"}`);
    await this.completeRestart();
    await this.telegram.poll((update) => this.dispatchUpdate(update));
  }
  async completeRestart() {
    if (!this.state.pendingRestartMessageId) return;
    await this.telegram.edit(this.chatId, this.state.pendingRestartMessageId, "✅ Gateway restarted")
      .then(() => this.saveState({ pendingRestartMessageId: null }))
      .catch((error) => log("restart", `failed to update restart notice: ${error.message}`));
  }
  async saveDownload(fileId, name, needsBase64 = false) {
    const file = await this.telegram.call("getFile", { file_id: fileId });
    const response = await fetch(`${this.telegram.fileBase}/${file.file_path}`, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`Telegram download: ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    const safe = name.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80) || "file";
    const path = join(this.config.downloadsDir, `${Date.now()}-${safe}`);
    await writeFile(path, buffer);
    return { path, data: needsBase64 ? buffer.toString("base64") : null };
  }
  // Downloads expire after a fixed 30 days.
  async cleanupDownloads() {
    try {
      for (const entry of await readdir(this.config.downloadsDir, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const path = join(this.config.downloadsDir, entry.name);
        const info = await stat(path).catch(() => null);
        if (info && info.mtimeMs < Date.now() - 30 * 24 * 60 * 60_000) await unlink(path).catch(() => {});
      }
    } catch (error) { log("download", "cleanup:", error.message); }
  }
  isAllowed(from, chat) { return String(from?.id) === this.config.allowedUserId && (!chat || chat.type === "private"); }
  async dispatchUpdate(update) {
    // ref: https://core.telegram.org/bots/api#messagegenerationstopped — no from field; authenticate the private chat id.
    if (update.stopped_message_generation) {
      const smg = update.stopped_message_generation;
      if (!this.isAllowed(smg.chat, smg.chat)) return;
      return this.sessions.get(sessionKeyOf(smg))?.handleCommand({ name: "abort", argument: "" }, "/abort", update.update_id);
    }
    const m = update.message, callback = update.callback_query;
    if (!m && !callback || !this.isAllowed((m || callback).from, m?.chat || callback?.message?.chat)) return Promise.resolve();
    const action = callback?.data?.startsWith("a:") ? this.actions.get(callback.data.slice(2)) : null, command = parseCommand(m?.text?.trim() || "");
    const session = m ? this.getOrCreateSession(m) : this.sessions.get(action?.sessionKey) || this.mainSession;
    this.chatReady = true;
    if (command?.name === "abort" || command?.name === "restart") {
      this.telegram.react(this.chatId, m.message_id, "👀");
      return session.handleCommand(command, m.text, update.update_id);
    }
    // ref: https://docs.python-telegram-bot.org/en/stable/telegram.message.html#telegram.Message.media_group_id — serialize albums at the first message.
    if (m?.media_group_id) {
      this.telegram.react(this.chatId, m.message_id, "👀");
      const key = `${this.chatId}:${m.media_group_id}`;
      let group = session.mediaGroups.get(key);
      if (!group) {
        const { promise: ready, resolve: resolveReady } = Promise.withResolvers();
        group = { messages: [], timer: null, ready, resolveReady, cancelled: false };
        session.mediaGroups.set(key, group);
        const next = session.updateChain.then(async () => {
          await group.ready;
          if (!group.cancelled && group.messages.length) await session.handleMediaGroup(group.messages);
        }).catch((err) => {
          log("update", "Media group error:", err);
          session.send(`❌ Failed to process media group: ${err.message}`);
        });
        session.updateChain = next;
        group.done = next;
      }
      group.messages.push(m);
      if (group.timer) clearTimeout(group.timer);
      group.timer = setTimeout(() => {
        session.mediaGroups.delete(key);
        group.resolveReady();
      }, 1200);
      return group.done;
    }
    const next = session.updateChain.then(() => this.handleUpdate(update, session));
    session.updateChain = next.catch((error) => log("update", error));
    return next;
  }
  async handleUpdate(update, session = this.mainSession) {
    const m = update.message, callback = update.callback_query;
    try {
      if (m) {
        const kind = m.text ? "text" : m.photo ? "photo" : m.voice ? "voice" : m.document ? "document" : m.video ? "video" : m.video_note ? "video_note" : m.audio ? "audio" : "other";
        // ref: https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html — never log user message content.
        const textLen = (m.text || m.caption || "").length;
        log("update", `msg #${m.message_id}: ${textLen ? `${kind}, ${textLen} chars` : kind}`);
        await this.handleMessage(m, session, update.update_id);
      } else {
        log("update", `callback #${callback.id}`);
        await this.handleCallback(callback, session);
      }
    } catch (error) {
      log("update", error);
      await session.send(`❌ ${error.message}`);
    }
  }
  async extractMedia(m) {
    const photo = m.photo?.at(-1);
    const file = photo || m.document || m.voice || m.video || m.video_note || m.audio || m.animation;
    if (!file) return null;
    const mime = photo ? "image/jpeg" : file.mime_type;
    const isImage = mime?.startsWith("image/");
    const kind = photo ? "photo" : m.voice ? "voice" : m.video_note ? "video_note" : m.audio ? "audio" : "file";
    const saved = await this.saveDownload(file.file_id, file.file_name || `${kind}-${m.message_id}${extensionFromMime(mime)}`, isImage);
    const image = isImage ? { type: "image", data: saved.data, mimeType: mime } : null;
    return { saved, image, label: m.voice ? "voice message" : file.file_name ? `file ${file.file_name}` : kind };
  }
  async handleMessage(message, session = null, updateId = null) {
    session ??= this.getOrCreateSession(message);
    const media = await this.extractMedia(message), text = message.text?.trim();
    if (!media && !text) return;
    this.telegram.react(this.chatId, message.message_id, "👀");
    if (!media) {
      const command = parseCommand(text);
      return command ? session.handleCommand(command, text, updateId, message.message_id)
        : session.prompt(text, undefined, undefined, message.message_id);
    }
    if (message.voice && this.config.sttCommand) {
      try {
        const { stdout } = await execFileAsync("bash", ["-c", this.config.sttCommand, "stt", media.saved.path], { timeout: 120_000, killSignal: "SIGKILL" })
          .catch((error) => { throw new Error(`Speech-to-text failed: ${error.message.slice(-300)}`); });
        const transcript = stdout.trim();
        if (!transcript) throw new Error("Speech-to-text failed: no output");
        return await session.prompt(`${transcript}${message.caption ? `\n\n${message.caption}` : ""}`, undefined, undefined, message.message_id);
      } catch (error) { return session.send(`❌ ${error.message}`); }
    }
    return session.prompt(attachmentPrompt(message.caption || `User sent a ${media.label}.`, [media.saved]),
      media.image ? [media.image] : undefined, undefined, message.message_id);
  }
  async registerBotCommands() {
    const data = this.mainSession.pi.proc ? await this.mainSession.pi.request("get_commands").catch(() => null) : null;
    const rpcCommands = data?.commands || [];
    const commands = [...BOT_COMMANDS];
    const routes = commandRoutes(rpcCommands);
    for (const command of rpcCommands) {
      const telegramName = telegramCommandName(command);
      if (RESERVED_COMMANDS.has(telegramName) || routes.get(telegramName)?.size !== 1) continue;
      if (!/^[a-z0-9_]{1,32}$/.test(telegramName) || commands.some((item) => item.command === telegramName)) continue;
      commands.push({ command: telegramName, description: (command.description || command.name).replace(/\s+/g, " ").slice(0, 200) });
    }
    const finalCommands = commands.slice(0, 100);
    // ref: https://core.telegram.org/bots/api#determining-list-of-commands — the narrowest scope wins; this bot is private-chat only.
    await this.telegram.call("setMyCommands", { commands: finalCommands, scope: { type: "all_private_chats" } });
  }
  async saveState(patch) {
    this.state = { ...this.state, ...patch };
    const statePath = join(this.config.stateDir, "state.json"), tempPath = `${statePath}.tmp`;
    // 串行化写入：并发 saveState 共享 tmp 路径会 ENOENT，且可能乱序完成
    this.stateWriteChain = this.stateWriteChain.then(async () => {
      try {
        await writeFile(tempPath, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
        await rename(tempPath, statePath);
      } catch (err) {
        log("state", `failed to persist state to ${statePath}: ${err.message}`);
      }
    });
    return this.stateWriteChain;
  }
  action(payload, ttl = 10 * 60_000) {
    const now = Date.now();
    for (const [key, value] of this.actions) if (value.expires < now) this.actions.delete(key);
    const token = randomBytes(6).toString("base64url");
    this.actions.set(token, { ...payload, expires: now + ttl });
    return `a:${token}`;
  }
  // ref: Herdr socket API (`herdr api schema --json`).
  herdr(method, params = {}) {
    if (HERDR_DISABLED_FOR_TEST) throw new Error(`Self-test must never call herdr: ${method}`);
    if (!this.herdrSocketPath) throw new Error("Herdr is unavailable");
    return herdrRequest({ HERDR_SOCKET_PATH: this.herdrSocketPath }, method, params);
  }
  async waitForShell(paneId, attempts) {
    for (let i = 0; i < attempts; i++) {
      if (paneHasForegroundShell((await this.herdr("pane.process_info", { pane_id: paneId }))?.process_info)) return true;
      if (i + 1 < attempts) await sleep(100);
    }
    return false;
  }
  // ref: Herdr `herdr api schema --json`: EventsSubscribeParams / Subscription / SubscriptionEventEnvelope.
  async onAgentStatus(paneId, status) {
    const sessions = [...this.sessions.values()].filter((s) => s.binding.paneId === paneId && s.pi.proc);
    if (!sessions.length) return;
    const prev = this.blockedStatuses.get(paneId);
    this.blockedStatuses.set(paneId, status);
    if (status !== "blocked" || prev === "blocked") return;
    for (const session of sessions) {
      if (!session.isStreaming || session.uiMessages?.size) continue;
      const connection = session.pi.connection;
      const screen = (await this.herdr("agent.read", { target: paneId, source: "visible", lines: 40 }))?.read?.text;
      if (this.blockedStatuses.get(paneId) !== "blocked" || session.pi.connection !== connection || !session.pi.proc ||
        session.binding.paneId !== paneId || session.uiMessages?.size || !this.sessions.has(session.key)) continue;
      const group = randomBytes(6).toString("hex");
      await session.send(`✋ Pi needs your confirmation\n\n${expandableBlockquote(String(screen || "").trim().split("\n").slice(-40).join("\n").slice(-2500))}`, {
        ...session.keyboard([["⏎ Enter", "enter"], ["⎋ Esc", "esc"]].map(([label, key]) => ({
          label, action: { type: "herdr_keys", paneId, key, group },
        }))),
        disable_notification: this.isUserPresent(),
      });
    }
  }
  syncBlockedSubscription(connect = net.createConnection) {
    if (this.stopping || HERDR_DISABLED_FOR_TEST && connect === net.createConnection || !this.herdrSocketPath) return;
    const panes = [...new Set([...this.sessions.values()].filter((s) => s.pi.proc && s.binding.paneId).map((s) => s.binding.paneId))].sort();
    const key = JSON.stringify(panes);
    if (key === this.subscribedPanesKey && this.herdrSubSocket && !this.herdrSubSocket.destroyed) return;
    this.subscribedPanesKey = key;
    clearTimeout(this.herdrSubTimer);
    this.herdrSubSocket?.destroy();
    this.herdrSubSocket = null;
    for (const p of this.blockedStatuses.keys()) if (!panes.includes(p)) this.blockedStatuses.delete(p);
    if (!panes.length) return;
    const socket = this.herdrSubSocket = connect(this.herdrSocketPath), id = randomUUID();
    let chain = Promise.resolve();
    const enqueue = (work) => { chain = chain.then(() => this.herdrSubSocket === socket && work()).catch((e) => log("blocked", e.message)); };
    socket.on("connect", () => writeJsonLine(socket, { id, method: "events.subscribe", params: {
      subscriptions: panes.map((pane_id) => ({ type: "pane.agent_status_changed", pane_id })),
    } }));
    readJsonLines(socket, (msg) => {
      if (msg.id === id && msg.error) return socket.destroy(new Error(msg.error.message || "Herdr subscription rejected"));
      if (msg.id === id && msg.result?.type === "subscription_started") {
        this.herdrSubRetries = 0;
        enqueue(async () => {
          const res = await this.herdr("agent.list", {});
          for (const a of res?.agents || []) if (this.herdrSubSocket === socket && panes.includes(a.pane_id)) await this.onAgentStatus(a.pane_id, a.agent_status);
        });
      } else if (msg.event === "pane.agent_status_changed" && panes.includes(msg.data?.pane_id)) {
        enqueue(() => this.onAgentStatus(msg.data.pane_id, msg.data.agent_status));
      }
    }, false);
    socket.on("error", (error) => log("blocked", error.message));
    socket.on("close", () => {
      if (this.herdrSubSocket !== socket || this.stopping) return;
      this.herdrSubSocket = null;
      this.herdrSubTimer = setTimeout(() => this.syncBlockedSubscription(connect), Math.min(10_000, 250 * 2 ** Math.min(this.herdrSubRetries++, 6))).unref();
    });
  }
  async handleCallback(callback, session = this.mainSession, action = null) {
    if (callback) {
      const token = callback.data?.startsWith("a:") ? callback.data.slice(2) : "";
      action = this.actions.get(token);
      this.actions.delete(token);
      // ref: Telegram Bot API answerCallbackQuery — 收到即应答，客户端转圈等待且过晚会 "query is too old"；每个 callback 只 answer 一次
      if (!action || action.expires < Date.now()) return this.telegram.answer(callback.id, "Expired");
      this.telegram.answer(callback.id).catch(() => {});
      session = this.sessions.get(action.sessionKey || sessionKeyOf(callback)) || session;
    }
    try {
      log("callback", `handling ${action.type}`);
      switch (action.type) {
        case "jump_pane": {
          const connection = this.bridge.connections.get(action.paneId);
          if (!connection) return session.send("That Pi is not connected. Enable /remote-control in its pane first.");
          const old = session.binding;
          session.pi.stop();
          session.resetSessionState();
          session.cwd = connection.hello.cwd;
          session.binding = { paneId: action.paneId, sessionFile: connection.hello.sessionFile, cwd: session.cwd, owned: false };
          session.pi.bind(connection);
          await this.persistPaneSession(session);
          return session.send(`✅ This topic now views Pi in ${action.paneId}. Previous session ${old.paneId || ""} was not stopped.`);
        }
        case "model":
          await session.pi.request("set_model", { provider: action.provider, modelId: action.modelId });
          session.lastModel = { provider: action.provider, modelId: action.modelId };
          return session.send(`✅ ${action.provider}/${action.modelId}`);
        case "thinking":
          await session.pi.request("set_thinking_level", { level: action.level });
          return session.send(`✅ thinking: ${action.level}`);
        case "retry": {
          if (!session.lastPrompt) return session.send("No prompt to retry");
          if (session.isStreaming) return session.send("⚠️ Still streaming; /abort first");
          const { message, images, triggerMessageId } = session.lastPrompt;
          await session.send(`🔁 Retrying last prompt (${message.length} chars)…`);
          return session.prompt(message, images, undefined, triggerMessageId);
        }
        case "resume": {
          const paneId = await this.liveSessionPane(action.path);
          if (paneId && paneId !== session.binding.paneId) {
            return session.send(`This session is already open in ${paneId}; no second Pi was started.`, session.keyboard([
              { label: "View that Pi here", action: { type: "jump_pane", paneId } },
            ]));
          }
          await session.abortRun(session.isStreaming);
          const result = await session.pi.request("switch_session", { sessionPath: action.path });
          return session.send(result.cancelled ? "Resume cancelled" : "✅ Session resumed");
        }
        case "ui": {
          for (const [key, value] of this.actions) {
            if (value.type === "ui" && value.requestId === action.requestId) this.actions.delete(key);
          }
          session.pi.write({ type: "extension_ui_response", id: action.requestId, ...action.response });
          if (callback?.message) {
            const chosen = action.response?.value ?? (action.response?.confirmed ? "Confirm" : "Cancel");
            await this.telegram.edit(callback.message.chat.id, callback.message.message_id, `${callback.message.text}\n\n✅ ${chosen}`).catch(() => {});
          }
          return;
        }
        case "herdr_keys": {
          for (const [key, value] of this.actions) if (value.group === action.group) this.actions.delete(key);
          const target = this.sessions.get(action.sessionKey);
          const agent = (await this.herdr("agent.get", { target: action.paneId }))?.agent;
          if (target?.pi.proc && target.binding.paneId === action.paneId && target.pi.connection?.hello.paneId === action.paneId && !target.uiMessages?.size && agent?.agent_status === "blocked") {
            await this.herdr("agent.send_keys", { target: action.paneId, keys: [action.key] });
          } else await (target || session).send("⚠️ Pi is no longer waiting; nothing sent.", { disable_notification: true });
          if (callback?.message) await this.telegram.call("editMessageReplyMarkup", {
            chat_id: callback.message.chat.id, message_id: callback.message.message_id, reply_markup: { inline_keyboard: [] },
          });
          return;
        }
        case "close_topic":
          if (action.confirmed) return await this.closeTopic(action.threadId, { deleteTopic: true });
          if (callback?.message) await this.telegram.edit(callback.message.chat.id, callback.message.message_id, "Close cancelled.").catch(() => {});
      }
    } catch (error) { await session.send(`❌ ${error.message}`); }
  }
  // ref: Telegram Bot API 9.3 & 9.4 (2026-02-09): createForumTopic in private chats
  async handleTopicCommand(session, argument) {
    const me = await this.telegram.call("getMe");
    if (!me?.has_topics_enabled) return session.send("Topics are not enabled for this bot. Enable Threaded Mode in the @BotFather Mini App:\nopen @BotFather → tap Open → select your bot → Bot Settings → Threads Settings → Threaded Mode.");
    const target = argument ? resolvePath(argument.trim(), session.cwd) : session.cwd;
    let realTarget, targetStat;
    try { targetStat = await stat(realTarget = await realpath(target)); } catch {
      return session.send(`Directory missing or inaccessible: ${target}`);
    }
    if (!targetStat.isDirectory()) return session.send(`Not a valid directory: ${target}`);
    const name = (basename(realTarget) || "topic").slice(0, 128);
    const newSession = await this.createTopic({ cwd: realTarget, name });
    await newSession.pi.ensureStarted();
    const state = await newSession.pi.request("get_state");
    await newSession.send(`✅ Topic ready · ${state.model?.provider || "unknown"}/${state.model?.id || "unknown"} · ${realTarget}`);
    await session.send(`✅ Created topic "${name}" (thread #${newSession.threadId})`);
  }
  // ref: Telegram Bot API 9.3 deleteForumTopic in private chats
  async handleCloseCommand(session) {
    if (session.threadId === null) return session.send("/close only works inside a topic.");
    const keyboard = session.keyboard(["Confirm", "Cancel"].map((label) => ({
      label, action: { type: "close_topic", threadId: session.threadId, confirmed: label === "Confirm" },
    })));
    return session.send(`Close topic "${basename(session.cwd)}"? ${session.binding.owned ? "This will quit its Pi and close its pane." : "This only detaches Telegram; your desktop Pi keeps running."} The topic will be removed.`, keyboard);
  }
  async acquireLock() {
    const sockPath = this.sockPath = join(this.config.stateDir, "gateway.sock");
    const pidFile = this.pidFile = join(this.config.stateDir, "gateway.pid");
    this.lockServer = await new Promise((done, reject) => {
      const client = net.connect(sockPath, () => {
        client.end();
        const pid = existsSync(pidFile) ? readFileSync(pidFile, "utf8").trim() : "";
        reject(new Error(`Another gateway is already running${pid ? ` (pid ${pid})` : ""}. Run ./install.sh stop first`));
      });
      client.on("error", (error) => {
        if (!["ECONNREFUSED", "ENOENT", "ENOTSOCK"].includes(error.code)) return reject(error);
        try { unlinkSync(sockPath); } catch {}
        const server = net.createServer();
        server.on("error", reject);
        server.listen(sockPath, () => done(server));
      });
    });
    this.lockServer.unref();
    writeFileSync(pidFile, String(process.pid), { mode: 0o600 });
  }
  stop() {
    this.stopping = true;
    clearInterval(this.downloadCleanupTimer);
    this.downloadCleanupTimer = null;
    this.telegram?.stopPolling?.();
    clearTimeout(this.herdrSubTimer);
    this.herdrSubSocket?.destroy();
    this.herdrSubSocket = null;
    this.bridge?.stop().catch((error) => log("bridge", `stop: ${error.message}`));
    try { this.lockServer?.close(); } catch {}
    this.lockServer = null;
    try { if (this.sockPath) unlinkSync(this.sockPath); } catch {}
    try {
      if (this.pidFile && existsSync(this.pidFile) && readFileSync(this.pidFile, "utf8").trim() === String(process.pid)) unlinkSync(this.pidFile);
    } catch {}
    for (const session of this.sessions.values()) session.stop();
  }
}

async function main() {
  if (process.argv.includes("--self-test")) return (await import("./self-test.mjs")).selfTest();
  const gateway = new Gateway(loadConfig());
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
    gateway.stop();
    process.exit(0);
  });
  gateway.start().catch((error) => {
    log("gateway", error);
    gateway.stop();
    process.exit(1);
  });
}

if (import.meta.main) main().catch((error) => {
  log("gateway", error);
  process.exit(1);
});

export {
  BOT_COMMANDS, ChatSession, Gateway, HELP, MAX_MESSAGE, PaneRpc, Telegram,
  chunks, expandableBlockquote, formatAssistantError, loadConfig, loadState,
  paneHasForegroundShell, parseCommand, pollBackoffMs, sessionKeyOf, setTestMode,
  shouldRetryTelegram, telegramCommandName, telegramHtml,
};
