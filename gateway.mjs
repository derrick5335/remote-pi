#!/usr/bin/env node

import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, openAsBlob, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { chmod, lstat, mkdir, readFile, readdir, realpath, rename, stat, truncate, unlink, writeFile } from "node:fs/promises";
import net from "node:net";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import MarkdownIt from "markdown-it";
import { readJsonLines, writeJsonLine } from "./remote-pi.ts";

const MAX_MESSAGE = 4000;
const MAX_LOG_SIZE = 5 * 1024 * 1024;
let HERDR_DISABLED_FOR_TEST = false;

function setTestMode(on) {
  HERDR_DISABLED_FOR_TEST = Boolean(on);
}
let stateWriteCounter = 0;
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
  { command: "restart", description: "Restart the gateway service" },
  { command: "agents", description: "Status of all Herdr agents" },
];
const RESERVED_COMMANDS = new Set([...BOT_COMMANDS.map((c) => c.command), "start"]);
const HELP = `Remote Pi\n\nJust send text to chat with Pi; messages sent while it is working act as steering.\n\n` + BOT_COMMANDS.map((c) => `/${c.command.padEnd(19)} ${c.description}`).join("\n");

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

function retryableTelegramStatus(status) {
  return status === 429 || status >= 500;
}

// ref: AWS Architecture Blog — Exponential Backoff And Jitter (https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/)
function pollBackoffMs(failures, random = Math.random) {
  const f = Math.max(1, failures);
  return Math.max(500, Math.round(random() * Math.min(60_000, 1000 * (2 ** (f - 1)))));
}

const NON_IDEMPOTENT_METHODS = new Set(["sendMessage", "sendDocument", "sendPhoto", "sendMediaGroup", "copyMessage", "forwardMessage"]);
const CONNECT_PHASE_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT"]);
function isConnectPhaseError(error) {
  const code = error?.cause?.code || error?.code;
  return Boolean(code && CONNECT_PHASE_CODES.has(code));
}
// ref: https://core.telegram.org/bots/api#making-requests — avoid replaying non-idempotent requests after ambiguous failures.
function shouldRetryTelegram(method, { status, error } = {}) {
  const nonIdempotent = NON_IDEMPOTENT_METHODS.has(method);
  if (typeof status === "number") return nonIdempotent ? status === 429 : retryableTelegramStatus(status);
  return error != null && (!nonIdempotent || isConnectPhaseError(error));
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

rules.paragraph_open = () => "";
rules.paragraph_close = () => (listStack.length ? "" : "\n");
rules.heading_open = () => "<b>";
rules.heading_close = () => "</b>\n\n";
rules.blockquote_open = () => "<blockquote>";
rules.blockquote_close = () => "</blockquote>\n\n";

// 列表：去掉 ul/ol 包装；有序序号自计数；嵌套按层级缩进（render 同步执行，模块级栈安全）
let listStack = [];
rules.bullet_list_open = () => { listStack.push(null); return listStack.length >= 2 ? "\n" : ""; };
rules.ordered_list_open = () => { listStack.push(0); return listStack.length >= 2 ? "\n" : ""; };
rules.bullet_list_close = () => { listStack.pop(); return listStack.length ? "" : "\n"; };
rules.ordered_list_close = () => { listStack.pop(); return listStack.length ? "" : "\n"; };
rules.list_item_open = () => {
  const depth = listStack.length;
  const top = listStack[depth - 1];
  if (top === null) return `${"  ".repeat(depth - 1)}• `;
  listStack[depth - 1] = top + 1;
  return `${"  ".repeat(depth - 1)}${top + 1}. `;
};
rules.list_item_close = () => "\n";

rules.link_open = (t, i) => `<a href="${escAttr(t[i].attrGet("href") || "")}">`;
rules.link_close = () => "</a>";
rules.image = (t, i) => {
  const src = t[i].attrGet("src") || "";
  const alt = (t[i].children || []).map((c) => c.content).join("") || src;
  return `<a href="${escAttr(src)}">${esc(alt)}</a>`;
};

rules.hardbreak = () => "\n";
rules.softbreak = () => "\n";
rules.hr = () => "─ ─ ─\n\n";

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
        const rows = m.match(/<tr>[\s\S]*?<\/tr>/g) || [];
        const cells = rows
          .map((r) => (r.match(/<t[hd][^>]*>[\s\S]*?<\/t[hd]>/g) || [])
            .map((c) => c.replace(/<\/?t[hd][^>]*>/g, "").trim()));
        const body = cells.filter((cs) => !cs.every((c) => !c || /^:?-+:?$/.test(c.replace(/<[^>]+>/g, ""))));
        if (body.length < 2) return m;
        const [head, ...data] = body;
        return [`<b>${head.join(" · ")}</b>`, ...data.map((r) => `• ${r.join(" — ")}`)].join("\n") + "\n\n";
      });
    return out.replace(/\n{3,}/g, "\n\n").trim();
  } finally {
    listStack = [];
  }
};

function telegramHtml(text) {
  return md.render(String(text || ""));
}

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

function scanFence(text) {
  let open = null;
  for (const line of text.split("\n")) {
    const m = FENCE_RE.exec(line);
    if (m) {
      if (!open) {
        if (m[1][0] === "~" || !m[2].includes("`")) open = { marker: m[1], info: m[2].trim() };
      } else if (m[1][0] === open.marker[0] && m[1].length >= open.marker.length && m[2].trim() === "") {
        open = null;
      }
    }
  }
  return open;
}

function renderChunk(text, from, to) {
  const slice = text.slice(from, to);
  const openStart = scanFence(text.slice(0, from));
  const openEnd = scanFence(text.slice(0, to));
  const pre = openStart ? `${openStart.marker}${openStart.info}\n` : "";
  const suf = openEnd ? `${slice.endsWith("\n") ? "" : "\n"}${openEnd.marker}` : "";
  return pre + slice + suf;
}

function chunks(text, limit = MAX_MESSAGE) {
  const str = String(text || "(empty)");
  if (str.length <= limit) return [str];
  const parts = [];
  let from = 0;
  while (from < str.length) {
    if (str.length - from <= limit) {
      parts.push(renderChunk(str, from, str.length));
      break;
    }
    const target = from + limit;
    let cut = str.lastIndexOf("\n\n", target);
    if (cut <= from || cut < target - 500) cut = str.lastIndexOf("\n", target);
    if (cut <= from) cut = target;
    parts.push(renderChunk(str, from, cut));
    from = cut + (str[cut] === "\n" ? 1 : 0);
  }
  return parts;
}

function extractText(content) {
  if (typeof content === "string") return content;
  return Array.isArray(content) ? content.filter((p) => p.type === "text").map((p) => p.text).join("\n") : "";
}

function toolSummary(name, args = {}) {
  const val = args?.command || args?.path || args?.pattern || args?.query || (Array.isArray(args?.queries) && args.queries.join(", ")) || args?.url || Object.values(args || {}).find((v) => typeof v === "string");
  if (val) return `${name}: ${val}`;
  const json = JSON.stringify(args || {});
  return json && json !== "{}" ? `${name} ${json}` : name;
}

function renderToolPanel(tools, isSettled = false) {
  if (!tools.length) return "";
  const total = tools.length;
  const done = tools.filter((t) => t.status !== "running").length;
  const header = isSettled ? `✅ ${total} tool call(s) done` : `⚙️ Running tools (${done}/${total})…`;
  const recent = tools.slice(-6).map((t) => {
    const icon = t.status === "running" ? "⏳" : t.status === "error" ? "❌" : "✅";
    const summary = t.summary.length > 80 ? `${t.summary.slice(0, 77)}…` : t.summary;
    return `• ${icon} ${summary}`;
  });
  const hidden = tools.length - recent.length;
  const prefix = hidden > 0 ? [`… ${hidden} earlier call(s) done`] : [];
  const body = [...prefix, ...recent].join("\n");
  // ponytail: 面板是同一条消息反复 edit，实体结构必须首帧即定（官方 entities 不跨 edit 保留），避免中途跳变
  return `${header}\n${expandableBlockquote(body)}`;
}

function formatContextTokens(count) {
  if (!count || typeof count !== "number") return "";
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${Math.round(count / 1_000)}K`;
  return String(count);
}

function formatSessionReset({ model, cwd }) {
  const modelId = model?.id || "unknown";
  const provider = model?.provider || "unknown";
  const contextTokens = formatContextTokens(model?.contextWindow);
  const context = contextTokens ? `${contextTokens} tokens (detected)` : "unknown";
  const endpoint = model?.baseUrl || "unknown";
  return [
    "✨ Session reset! Starting fresh.",
    "",
    `◆ Model: ${modelId}`,
    `◆ Provider: ${provider}`,
    `◆ Context: ${context}`,
    `◆ Endpoint: ${endpoint}`,
    `◆ CWD: ${cwd}`,
  ].join("\n");
}

function extensionFromMime(mime = "") {
  const map = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif", "audio/ogg": ".ogg", "audio/mpeg": ".mp3", "audio/wav": ".wav", "video/mp4": ".mp4", "video/quicktime": ".mov", "application/pdf": ".pdf" };
  return map[String(mime).toLowerCase()] || "";
}

function attachmentPrompt(caption, files) {
  return `${caption}\n\nAttachments saved locally:\n${files.map((file) => `- ${file.path}`).join("\n")}`;
}

function previewText(text) {
  return text.length > MAX_MESSAGE ? `${text.slice(0, MAX_MESSAGE)}\n\n*(output truncated, still streaming…)*` : text;
}

function formatAssistantError(errorMessage) {
  const message = String(errorMessage || "Model call failed");
  if (/usage limit|quota|balance|credit|insufficient|budget/i.test(message)) {
    return `⚠️ ${message}\n\n💡 Tip: the current model's usage quota is exhausted. Use /model to switch to another available model (e.g. Gemini or Claude).`;
  }
  if (/rate limit|too many requests|429/i.test(message)) {
    return `⚠️ ${message}\n\n💡 Tip: provider rate limit hit. Retry shortly, or use /model to switch models.`;
  }
  return `❌ ${message}`;
}

function runStt(sttCommand, audioPath) {
  return new Promise((resolveStt, rejectStt) => {
    const child = spawn("bash", ["-c", sttCommand, "stt", audioPath], { timeout: 120_000 });
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("error", rejectStt);
    child.on("close", (code) => {
      const text = out.trim();
      if (code === 0 && text) return resolveStt(text);
      rejectStt(new Error(`Speech-to-text failed (exit ${code ?? "signal"}): ${(err.trim() || text || "no output").slice(-300)}`));
    });
  });
}

function resolvePath(pathStr, baseDir = process.cwd()) {
  if (!pathStr || typeof pathStr !== "string") return "";
  const expanded = pathStr.startsWith("~/") ? join(homedir(), pathStr.slice(2)) : pathStr === "~" ? homedir() : pathStr;
  return resolve(baseDir, expanded);
}

// pure routing: 判定消息归属的主会话 ("main") 或私聊 Topic ("t:<threadId>")
// ref: Telegram Bot API 9.3 (2025-12-31) Topics in private chats (https://core.telegram.org/bots/api-changelog)
function sessionKeyOf(messageOrCallbackMessage) {
  if (!messageOrCallbackMessage) return "main";
  const m = messageOrCallbackMessage.message || messageOrCallbackMessage;
  const chatType = m.chat?.type;
  if (chatType && chatType !== "private") return "main";
  const threadId = m.message_thread_id;
  if (!threadId) return "main";
  if (m.is_topic_message === false) return "main";
  return `t:${threadId}`;
}

function loadState(stateDir) {
  const statePath = join(stateDir, "state.json");
  if (!existsSync(statePath)) return { cwd: null, topics: {}, herdrPanes: {} };
  try {
    const raw = JSON.parse(readFileSync(statePath, "utf8"));
    const topics = {};
    if (typeof raw.topics === "object" && raw.topics !== null) {
      for (const [threadId, info] of Object.entries(raw.topics)) {
        if (typeof info?.cwd === "string" && existsSync(info.cwd)) topics[threadId] = { cwd: info.cwd };
      }
    }
    const herdrPanes = {};
    if (typeof raw.herdrPanes === "object" && raw.herdrPanes !== null) {
      for (const [key, paneId] of Object.entries(raw.herdrPanes)) {
        if (typeof paneId === "string" && paneId) herdrPanes[key] = paneId;
        else if (paneId && typeof paneId === "object" && typeof paneId.cwd === "string") {
          herdrPanes[key] = { cwd: paneId.cwd, ...(paneId.paneId ? { paneId: paneId.paneId } : {}), ...(paneId.sessionFile ? { sessionFile: paneId.sessionFile } : {}), ...(paneId.workspaceId ? { workspaceId: paneId.workspaceId } : {}), owned: paneId.owned === true };
        }
      }
    }
    return { cwd: typeof raw.cwd === "string" ? raw.cwd : null, topics, herdrPanes, pendingRestartMessageId: Number.isSafeInteger(raw.pendingRestartMessageId) && raw.pendingRestartMessageId > 0 ? raw.pendingRestartMessageId : null };
  } catch { return { cwd: null, topics: {}, herdrPanes: {} }; }
}

function shellQuote(str) {
  return `'${String(str).replaceAll("'", "'\\''")}'`;
}

async function readFirstLine(filePath) {
  try {
    const raw = await readFile(filePath, "utf8");
    const nl = raw.indexOf("\n");
    return nl === -1 ? raw : raw.slice(0, nl);
  } catch { return null; }
}

async function parseSessionHeader(filePath) {
  try {
    const firstLine = await readFirstLine(filePath);
    const header = firstLine ? JSON.parse(firstLine) : null;
    return header?.type === "session" ? header : null;
  } catch { return null; }
}

async function parseSessionPreview(filePath) {
  try {
    const raw = await readFile(filePath, "utf8");
    for (const line of raw.split("\n", 20)) {
      if (!line) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.type === "session_info" && entry.name) return entry.name;
        if (entry.type === "message" && entry.message?.role === "user") {
          const text = extractText(entry.message.content).slice(0, 60);
          if (text) return text;
        }
      } catch {
        const m = line.match(/"role"\s*:\s*"user"[\s\S]*?"text"\s*:\s*"([^"\\]{1,60})/);
        if (m) return m[1];
      }
    }
    return "";
  } catch { return ""; }
}

function encodeCwdSessionDir(baseDir, cwd) {
  return join(baseDir, `--${cwd.replace(/^[/\\]+/, "").replace(/[/\\:]/g, "-")}--`);
}

async function scanDesktopSessions(desktopDir, targetCwd, limit = 10) {
  if (!desktopDir || !targetCwd) return [];
  const dir = encodeCwdSessionDir(desktopDir, targetCwd);
  if (!existsSync(dir)) return [];
  const names = (await readdir(dir).catch(() => [])).filter((name) => name.endsWith(".jsonl"));
  const matched = [];
  for (const name of names) {
    const path = join(dir, name);
    try {
      const header = await parseSessionHeader(path);
      if (header?.cwd === targetCwd) {
        const s = await stat(path).catch(() => null);
        if (s) matched.push({ path, mtime: s.mtimeMs, id: header.id });
      }
    } catch {}
  }
  matched.sort((a, b) => b.mtime - a.mtime);
  return Promise.all(matched.slice(0, limit).map(async (item) => ({ ...item, title: (await parseSessionPreview(item.path)) || basename(item.path) })));
}

function loadConfig() {
  const path = process.env.REMOTE_PI_CONFIG || join(homedir(), ".config", "remote-pi", "config.json");
  const configDir = dirname(path);
  let file = {};
  if (existsSync(path)) {
    try { file = JSON.parse(readFileSync(path, "utf8")); }
    catch (err) { throw new Error(`Failed to parse config file ${path}: ${err.message}`); }
  }

  const stateDir = resolvePath(file.stateDir || join(homedir(), ".local", "var", "remote-pi"), configDir);
  const savedState = loadState(stateDir);
  const targetCwd = savedState.cwd || (file.cwd ? resolvePath(file.cwd, configDir) : null);
  if (!targetCwd) throw new Error(`"cwd" is required: set "cwd" in ${path}`);

  const telegram = typeof file.telegram === "object" && file.telegram !== null ? file.telegram : {};
  const config = {
    botToken: telegram.botToken,
    allowedUserId: String(telegram.allowedUserId || ""),
    cwd: targetCwd,
    configPath: path,
    stateDir,
    presenceFile: file.presenceFile ? resolvePath(file.presenceFile, configDir) : "",
    logFile: resolvePath(process.env.REMOTE_PI_LOG_FILE || file.logFile || join(homedir(), ".local", "var", "log", "remote-pi.log"), configDir),
    sttCommand: file.sttCommand || "",
  };
  config.downloadsDir = join(config.stateDir, "downloads");
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(config.botToken || "")) throw new Error(`Invalid telegram.botToken in ${path}`);
  if (!/^\d+$/.test(config.allowedUserId)) throw new Error(`Invalid telegram.allowedUserId in ${path}`);
  let cwdIsDir = false;
  try { cwdIsDir = statSync(config.cwd).isDirectory(); } catch {}
  if (!cwdIsDir) throw new Error(`Pi working directory does not exist or is not a directory: ${config.cwd}`);
  return config;
}

class Telegram {
  constructor(token, offsetPath) {
    this.base = `https://api.telegram.org/bot${token}`;
    this.fileBase = `https://api.telegram.org/file/bot${token}`;
    this.offsetPath = offsetPath;
    this.retryNotBefore = 0; // ref: Telegram ResponseParameters retry_after (https://core.telegram.org/bots/api#responseparameters)
    this.currentPollAc = null;
    this.polling = false;
    this.pollFailures = 0;
    this.outageStart = 0;
    this.inConflict = false; }
  async call(method, body = {}, timeout = 35_000, maxAttempts = 3, signal = null, quiet = false) {
    let lastError;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const reqSignal = signal ? AbortSignal.any([AbortSignal.timeout(timeout), signal]) : AbortSignal.timeout(timeout);
        const res = await fetch(`${this.base}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: reqSignal });
        const data = await res.json();
        if (res.ok && data.ok) {
          if (method !== "getUpdates" || data.result?.length) console.log(`${new Date().toISOString()} [tg:call] ${method} ok${method === "getUpdates" ? ` (updates: ${data.result.length})` : ""}`);
          return data.result;
        }
        if (res.status === 429) {
          const retrySec = data?.parameters?.retry_after || attempt + 1;
          this.retryNotBefore = Math.max(this.retryNotBefore, Date.now() + retrySec * 1000);
        }
        lastError = new Error(`Telegram ${method}: ${data.description || res.status}`);
        if (!quiet) console.error(`${new Date().toISOString()} [tg:call] ${method} HTTP ${res.status}: ${data.description || ""}`);
        if (!shouldRetryTelegram(method, { status: res.status }) || attempt === maxAttempts - 1) throw lastError;
        await sleep((data.parameters?.retry_after || attempt + 1) * 1000);
      } catch (error) {
        if (signal?.aborted) throw error;
        if (!quiet) console.error(`${new Date().toISOString()} [tg:call] ${method} attempt ${attempt + 1}/${maxAttempts} failed:`, error.message);
        lastError = error;
        if (!shouldRetryTelegram(method, { error }) || attempt === maxAttempts - 1) throw error;
        await sleep((attempt + 1) * 1000);
      }
    }
    throw lastError; }
  async sendOne(chatId, text, extra = {}) {
    const plain = String(text || "(empty)");
    try {
      return await this.call("sendMessage", { chat_id: chatId, text: telegramHtml(plain), parse_mode: "HTML", ...extra });
    } catch (error) {
      const msg = String(error.message || "");
      if (!msg.includes("can't parse entities") && !msg.includes("message is too long")) throw error;
      console.error("HTML parse/length fallback:", error.message);
      if (plain.length > 4000) {
        let lastMsg;
        for (let i = 0; i < plain.length; i += 4000) {
          lastMsg = await this.call("sendMessage", { chat_id: chatId, text: plain.slice(i, i + 4000), ...(i + 4000 >= plain.length ? extra : {}) });
        }
        return lastMsg;
      }
      return this.call("sendMessage", { chat_id: chatId, text: plain, ...extra });
    }
  }

  async send(chatId, text, extra = {}) {
    let last;
    const parts = chunks(text), base = {};
    if (extra?.message_thread_id) base.message_thread_id = extra.message_thread_id;
    if (extra?.disable_notification) base.disable_notification = extra.disable_notification;
    for (let i = 0; i < parts.length; i++) last = await this.sendOne(chatId, parts[i], i === parts.length - 1 ? extra : base);
    return last; }
  async edit(chatId, messageId, text, ephemeral = false, extra = {}) {
    const plain = String(text || "(empty)");
    const timeout = ephemeral ? 10_000 : 35_000;
    const maxAttempts = ephemeral ? 1 : 3;
    const extraParams = extra?.reply_markup ? { reply_markup: extra.reply_markup } : {};
    try {
      return await this.call("editMessageText", { chat_id: chatId, message_id: messageId, text: telegramHtml(plain), parse_mode: "HTML", ...extraParams }, timeout, maxAttempts);
    } catch (error) {
      const msg = String(error.message || "");
      if (msg.includes("can't parse entities") || msg.includes("message is too long")) {
        console.error("HTML parse/length fallback:", error.message);
        return this.call("editMessageText", { chat_id: chatId, message_id: messageId, text: plain.slice(0, 4000), ...extraParams }, timeout, maxAttempts);
      }
      if (!error.message.includes("message is not modified")) throw error;
    }
  }

  answer(callbackQueryId, text = "") {
    return this.call("answerCallbackQuery", { callback_query_id: callbackQueryId, text }).catch(console.error); }
  async sendChatAction(chatId, action = "typing", extra = {}) {
    try {
      const body = { chat_id: chatId, action };
      if (extra?.message_thread_id) body.message_thread_id = extra.message_thread_id;
      await fetch(`${this.base}/sendChatAction`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(4_000) });
    } catch {}
  }

  async sendDocument(chatId, path, extra = {}) {
    const form = new FormData();
    form.set("chat_id", String(chatId));
    if (extra?.message_thread_id) form.set("message_thread_id", String(extra.message_thread_id));
    form.set("document", await openAsBlob(path), basename(path));
    const response = await fetch(`${this.base}/sendDocument`, { method: "POST", body: form, signal: AbortSignal.timeout(60_000) });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(`Telegram sendDocument: ${data.description || response.status}`);
    console.log(`${new Date().toISOString()} [tg:call] sendDocument ok`); }
  async deleteMessage(chatId, messageId) {
    await this.call("deleteMessage", { chat_id: chatId, message_id: messageId }, 10_000, 1); }
  async setReaction(chatId, messageId, emoji) {
    if (!messageId) return null;
    const reaction = emoji ? [{ type: "emoji", emoji: String(emoji) }] : [];
    try { return await this.call("setMessageReaction", { chat_id: chatId, message_id: messageId, reaction }, 5000, 1); }
    catch { return null; }
  }

  stopPolling() {
    this.polling = false;
    if (this.currentPollAc) { try { this.currentPollAc.abort("stop"); } catch {} this.currentPollAc = null; }
  }

  async poll(handler) {
    let offset = Number(await readFile(this.offsetPath, "utf8").catch(() => "0")) || 0;
    let persistChain = Promise.resolve();
    this.polling = true;
    while (this.polling) {
      try {
        this.currentPollAc = new AbortController();
        const updates = await this.call("getUpdates", { offset, timeout: 25, allowed_updates: ["message", "callback_query"] }, 35_000, 1, this.currentPollAc.signal, true);
        this.currentPollAc = null;
        if (!this.polling) break;
        this.inConflict = false;
        if (this.pollFailures > 0) {
          const s = Math.round((Date.now() - this.outageStart) / 1000);
          console.log(`${new Date().toISOString()} [tg:poll] back online after ${s}s (${this.pollFailures} failed polls)`);
          this.pollFailures = 0;
          this.outageStart = 0;
        }
        for (const update of updates) {
          if (!this.polling) break;
          offset = update.update_id + 1;
          const done = handler(update);
          if (done) {
            const mark = update.update_id + 1;
            persistChain = persistChain.then(() => done).then(async () => {
              const tmp = `${this.offsetPath}.tmp`;
              await writeFile(tmp, String(mark), { mode: 0o600 });
              await rename(tmp, this.offsetPath);
            }).catch((err) => console.error(`${new Date().toISOString()} [tg:poll] offset persist:`, err.message));
          }
        }
      } catch (error) {
        this.currentPollAc = null;
        if (!this.polling) break;
        if (error.message?.includes("Conflict")) {
          if (!this.inConflict) { this.inConflict = true; console.error(`${new Date().toISOString()} [tg:poll] conflict: ${error.message}`); }
          try { this.currentPollAc = new AbortController(); await sleep(15_000, undefined, { signal: this.currentPollAc.signal }); } catch {} finally { this.currentPollAc = null; }
          continue;
        }
        this.inConflict = false;
        this.pollFailures++;
        if (this.pollFailures === 1) { this.outageStart = Date.now(); console.error(`${new Date().toISOString()} [tg:poll] offline: ${error.message}; retrying with backoff`); }
        const backoffMs = pollBackoffMs(this.pollFailures);
        try { this.currentPollAc = new AbortController(); await sleep(backoffMs, undefined, { signal: this.currentPollAc.signal }); } catch {} finally { this.currentPollAc = null; }
      }
    }
  }
}

function runCommand(cmd, args = [], options = {}) {
  if (HERDR_DISABLED_FOR_TEST && (cmd.includes("herdr") || args.some((a) => String(a).includes("herdr")))) {
    throw new Error(`Self-test must never call herdr: ${cmd} ${args.join(" ")}`);
  }
  const { okCodes = [0], ...spawnOptions } = options;
  return new Promise((resolve, reject) => {
    const cp = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...spawnOptions });
    let stdout = "";
    let stderr = "";
    cp.stdout?.setEncoding("utf8");
    cp.stderr?.setEncoding("utf8");
    cp.stdout?.on("data", (d) => { stdout += d; });
    cp.stderr?.on("data", (d) => { stderr += d; });
    const timer = spawnOptions.timeout ? setTimeout(() => {
      cp.kill("SIGKILL");
      reject(new Error(`Command timed out: ${cmd} ${args.join(" ")}`));
    }, spawnOptions.timeout) : null;
    cp.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    cp.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (okCodes.includes(code)) resolve(stdout.trim());
      else reject(new Error(`Command failed (${code}): ${stderr.trim() || stdout.trim()}`));
    });
  });
}

// ref: Herdr Official Docs - CLI Reference & Integrations (https://herdr.dev/docs/cli-reference/ & https://herdr.dev/docs/integrations/)
async function resolveHerdrEnvironment(cwd, { excludePaneIds, threadId, persistedPaneId, paneEnv = {}, runCmd = runCommand, herdrBin, socketPath } = {}) {
  if (HERDR_DISABLED_FOR_TEST && runCmd === runCommand) return {};
  let bin = herdrBin;
  if (!bin) {
    try { bin = (await runCmd("which", ["herdr"], { timeout: 2000 })).trim(); }
    catch {
      const fallback = join(homedir(), ".local", "bin", "herdr");
      if (existsSync(fallback)) bin = fallback;
      else return {};
    }
  }
  let sock = socketPath;
  if (!sock) {
    try {
      const raw = await runCmd(bin, ["status", "server", "--json"], { timeout: 3000 });
      const parsed = JSON.parse(raw);
      if (parsed.running && parsed.socket) sock = parsed.socket;
    } catch {}
  }
  if (!sock) return {};

  let workspaceId, tabId, paneId, createdPane = false;
  const exclude = new Set(excludePaneIds || []);
  if (persistedPaneId && !exclude.has(persistedPaneId)) {
    try {
      const paneRaw = await runCmd(bin, ["pane", "get", persistedPaneId], { timeout: 3000 });
      const existingPane = JSON.parse(paneRaw).result?.pane;
      if (existingPane?.pane_id) { workspaceId = existingPane.workspace_id; tabId = existingPane.tab_id; paneId = existingPane.pane_id; }
    } catch {}
  }
  if (!paneId) {
    try {
      const base = basename(cwd) || "remote-pi";
      const label = threadId ? `${base}#${threadId}` : base;
      const createdRaw = await runCmd(bin, ["workspace", "create", "--cwd", cwd, "--label", label, "--no-focus", ...Object.entries(paneEnv).flatMap(([k, v]) => ["--env", `${k}=${v}`])], { timeout: 5000 });
      const created = JSON.parse(createdRaw);
      workspaceId = created.result?.workspace?.workspace_id; tabId = created.result?.tab?.tab_id; paneId = created.result?.root_pane?.pane_id; createdPane = Boolean(paneId);
    } catch (err) { console.warn(`${new Date().toISOString()} [herdr] failed to create workspace for ${cwd}: ${err.message}`); }
  }
  if (!paneId) return {};
  return { HERDR_ENV: "1", HERDR_SOCKET_PATH: sock, HERDR_BIN_PATH: bin, HERDR_WORKSPACE_ID: workspaceId, HERDR_TAB_ID: tabId, HERDR_PANE_ID: paneId, REMOTE_PI_CREATED_PANE: createdPane ? "1" : "0" };
}

const HERDR_STATUS_ICON = { working: "⏳", blocked: "✋", done: "✅", idle: "💤", unknown: "❔" };

// /remote-control（remote-pi.ts）通过 herdr 原生 pane metadata token 标记订阅
const HERDR_OPT_IN_TOKEN = "remote_pi";

function herdrOptedIn(agent) {
  return agent?.agent === "pi" && agent?.tokens?.[HERDR_OPT_IN_TOKEN] === "on";
}

// ref: Herdr pane.report_agent_session (`herdr api schema --json`); Pi session_start / sessionManager.getSessionFile() (Pi docs/extensions.md)
function resolveAgentSessionFile(agent) {
  if (agent?.agent_session?.kind === "path" && agent?.agent_session?.value) {
    return agent.agent_session.value;
  }
  if (typeof agent?.agent_session?.path === "string") {
    return agent.agent_session.path;
  }
  if (typeof agent?.agent_session === "string") {
    return agent.agent_session;
  }
  return agent?.tokens?.remote_pi_session || null;
}

function herdrTail(screen, maxLines = 30, maxChars = 2500) {
  const lines = String(screen || "").replace(/\s+$/, "").split("\n");
  return lines.slice(-maxLines).join("\n").slice(-maxChars).trim();
}

// ref: Herdr socket API events.subscribe（`herdr api schema --json`；订阅后连接变为单向事件流，订阅集合变化需重连）
// 推送负责实时性，每 15 秒 agent list 全量对账兜底（漏事件、herdr 重启、合盖睡眠）
class HerdrWatcher {
  constructor({ bin, socketPath, isExcluded, onTransition }) {
    this.bin = bin;
    this.socketPath = socketPath;
    this.isExcluded = isExcluded;
    this.onTransition = onTransition;
    this.statuses = new Map();
    this.agents = new Map();
    this.workspaces = new Map();
    this.socket = null;
    this.subscribedKey = null;
    this.syncChain = Promise.resolve();
    this.syncTimer = null;
    this.reconcileTimer = null;
    this.stopped = false; }
  async cli(args, timeout = 5000) {
    return runCommand(this.bin, args, { timeout }); }
  async cliJson(args, timeout = 5000) {
    return JSON.parse(await this.cli(args, timeout)).result; }
  start() {
    this.stopped = false;
    if (HERDR_DISABLED_FOR_TEST) return;
    this.sync();
    this.reconcileTimer = setInterval(() => this.sync(), 15_000);
    this.reconcileTimer.unref?.(); }
  stop() {
    this.stopped = true;
    clearInterval(this.reconcileTimer);
    clearTimeout(this.syncTimer);
    const socket = this.socket;
    this.socket = null;
    socket?.destroy(); }
  scheduleSync(delay) {
    if (HERDR_DISABLED_FOR_TEST) return;
    clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => this.sync(), delay);
    this.syncTimer.unref?.(); }
  sync() {
    if (HERDR_DISABLED_FOR_TEST) return Promise.resolve();
    this.syncChain = this.syncChain.then(() => this.doSync()).catch((error) => {
      console.warn(`${new Date().toISOString()} [herdr] sync failed: ${error.message}`);
      if (!this.stopped) this.scheduleSync(15_000);
    });
    return this.syncChain; }
  async doSync() {
    if (this.stopped) return;
    const [agentList, workspaceList] = await Promise.all([this.cliJson(["agent", "list"]), this.cliJson(["workspace", "list"])]);
    this.workspaces = new Map((workspaceList?.workspaces ?? []).map((w) => [w.workspace_id, w.label]));
    const agents = agentList?.agents ?? [];
    this.agents = new Map(agents.map((a) => [a.pane_id, a]));
    for (const agent of agents) this.observe(agent.pane_id, agent.agent_status);
    for (const paneId of this.statuses.keys()) if (!this.agents.has(paneId)) this.statuses.delete(paneId);
    const paneIds = [...this.agents.keys()].sort();
    if (paneIds.join(",") !== this.subscribedKey || !this.socket) this.subscribe(paneIds);
  }

  // 首见和重复状态不通知；完成由原生 Pi 事件处理，这里只补充 TUI 待确认提醒。
  observe(paneId, status) {
    const prev = this.statuses.get(paneId);
    this.statuses.set(paneId, status);
    if (prev === undefined || prev === status || this.isExcluded(paneId)) return;
    if (status === "blocked") this.notify(paneId, status);
  }

  // 只推送在 Pi 里开启 /remote-control 的 pane：现取 agent get，以 pane 上的 remote_pi token 为准（默认不推送）
  async notify(paneId, status) {
    try {
      const agent = (await this.cliJson(["agent", "get", paneId]))?.agent;
      if (!agent) return;
      this.agents.set(paneId, agent);
      if (!herdrOptedIn(agent)) return;
      await this.onTransition({ paneId, status, agent });
      this.sync();
    } catch (error) {
      console.warn(`${new Date().toISOString()} [herdr] notify ${paneId} failed: ${error.message}`);
    }
  }

  subscribe(paneIds) {
    this.socket?.destroy();
    if (HERDR_DISABLED_FOR_TEST || !this.socketPath) return;
    this.subscribedKey = paneIds.join(",");
    const socket = net.connect(this.socketPath);
    socket.setEncoding("utf8");
    this.socket = socket;
    let buffer = "";
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({
        id: "remote-pi:watch",
        method: "events.subscribe",
        params: { subscriptions: [{ type: "pane.agent_detected" }, ...paneIds.map((paneId) => ({ type: "pane.agent_status_changed", pane_id: paneId }))] },
      })}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) this.handleLine(socket, line);
      }
    });
    socket.on("error", (error) => console.warn(`${new Date().toISOString()} [herdr] event socket: ${error.message}`));
    socket.on("close", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (!this.stopped) this.scheduleSync(5000);
    }); }
  handleLine(socket, line) {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.error) {
      // 典型是 pane_not_found（list 与 subscribe 之间 pane 被关）；断开后由 close 回调重新对账
      console.warn(`${new Date().toISOString()} [herdr] subscribe failed: ${message.error.message || message.error.code}`);
      socket.destroy();
      return;
    }
    if (message.event === "pane_agent_detected" || message.event === "pane.agent_detected") {
      this.scheduleSync(300);
    } else if (message.event === "pane.agent_status_changed" && message.data?.pane_id) {
      const agent = this.agents.get(message.data.pane_id);
      if (agent) agent.agent_status = message.data.agent_status;
      this.observe(message.data.pane_id, message.data.agent_status);
    }
  }

  label(paneId) {
    const agent = this.agents.get(paneId);
    const name = agent?.name || agent?.agent || "agent";
    const where = this.workspaces.get(agent?.workspace_id) || (agent?.cwd ? basename(agent.cwd) : "");
    return `${name}${where ? ` · ${where}` : ""} (${paneId})`;
  }
}

function paneHasForegroundShell(info) {
  return Number.isInteger(info?.shell_pid) && info.shell_pid > 0 && info.foreground_process_group_id === info.shell_pid;
}

// ref: Pi docs/rpc.md#framing; Node net IPC sockets. The directory is private and the socket is mode 0600.
class PaneServer {
  constructor(path, onHello) {
    this.path = path;
    this.onHello = onHello;
    this.connections = new Map();
    this.sockets = new Set();
    this.waiters = new Set();
    this.server = null;
    this.starting = null;
    this.closed = false; }
  async start() {
    if (this.server) return;
    this.starting ??= this.listen().finally(() => { this.starting = null; });
    return this.starting; }
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
      let connection;
      let chain = Promise.resolve();
      const handshake = setTimeout(() => socket.destroy(), 5000);
      handshake.unref?.();
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
            if (record.version !== 1 || typeof record.paneId !== "string" || !record.paneId || typeof record.cwd !== "string" || !record.cwd.startsWith("/") || typeof record.sessionFile !== "string" || !record.sessionFile.startsWith("/") || typeof record.sessionId !== "string" || !Number.isInteger(record.pid) || record.pid <= 0) throw new Error("Invalid bridge hello");
            clearTimeout(handshake);
            const duplicate = [...this.connections.values()].find((c) => c.hello.sessionFile === record.sessionFile && c.hello.paneId !== record.paneId);
            if (duplicate) throw new Error(`Session already served by ${duplicate.hello.paneId}`);
            const previous = this.connections.get(record.paneId);
            connection = connection || { socket, clients: new Set() };
            connection.hello = record;
            this.connections.set(record.paneId, connection);
            if (previous && previous !== connection) {
              for (const rpc of [...previous.clients]) rpc.bind(connection);
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
    server.on("error", (error) => console.error(`[bridge] ${error.message}`));
    await new Promise((done, reject) => {
      server.once("error", reject);
      server.listen(this.path, () => { server.off("error", reject); done(); });
    });
    await chmod(this.path, 0o600);
    this.server = server;
    server.unref(); }
  find({ paneId, sessionFile }) {
    return [...this.connections.values()].find((c) => !c.socket.destroyed && c.socket.writable && (sessionFile ? c.hello.sessionFile === sessionFile : paneId && c.hello.paneId === paneId)); }
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
    }); }
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
    this.session = session;
    this.gateway = session.gateway;
    this.onEvent = onEvent;
    this.onClose = onClose;
    this.proc = null;
    this.connection = null;
    this.pending = new Map();
    this.starting = null;
    this.herdrEnv = {};
    this.stopping = false; }
  async ensureStarted() {
    if (this.proc && !this.proc.destroyed) return;
    this.starting ??= this.start().finally(() => { this.starting = null; });
    return this.starting; }
  async start() {
    this.stopping = false;
    await this.gateway.ensurePaneSession(this); }
  bind(connection) {
    this.stopping = false;
    this.connection?.clients.delete(this);
    this.connection = connection;
    connection.clients.add(this);
    this.proc = connection.socket;
    this.herdrEnv = { ...this.gateway.herdrEnvironment, HERDR_PANE_ID: connection.hello.paneId };
    this.session.binding = { ...this.session.binding, paneId: connection.hello.paneId, sessionFile: connection.hello.sessionFile, cwd: connection.hello.cwd };
    this.session.cwd = connection.hello.cwd;
    for (const [id, pending] of this.pending) {
      if (pending.replacing && pending.from === connection.hello.previousSessionFile && ["new", "resume", "fork"].includes(connection.hello.reason)) {
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.done({ cancelled: false, ...(pending.text !== undefined ? { text: pending.text } : {}) });
      }
    }
  }

  receive(record) {
    if (record.type === "session_replacing") {
      const pending = this.pending.get(record.id);
      if (pending && pending.type === record.command) { pending.replacing = true; pending.text = record.text; }
    } else if (record.type === "response") {
      const pending = this.pending.get(record.id);
      if (!pending || record.command !== pending.type) return;
      clearTimeout(pending.timer);
      this.pending.delete(record.id);
      if (record.success) pending.done(record.data || {});
      else pending.reject(new Error(record.error || "Pi bridge request failed"));
    } else {
      this.onEvent(record);
    }
  }

  disconnected(connection) {
    if (this.connection !== connection) return;
    this.proc = null;
    this.connection = null;
    connection.clients.delete(this);
    let replacing = false;
    for (const [id, pending] of this.pending) {
      if (pending.replacing) { replacing = true; continue; }
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(new Error("Pi bridge disconnected; command delivery may be incomplete"));
    }
    if (!replacing) this.onClose?.({ expected: this.stopping || this.gateway.bridge.closed }); }
  async request(type, fields = {}, timeout = 600_000) {
    await this.ensureStarted();
    const id = `pane-${randomBytes(12).toString("hex")}`;
    return new Promise((done, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Pi bridge ${type} timed out; not retried`)); }, timeout);
      this.pending.set(id, { type, done, reject, timer, from: this.session.binding.sessionFile });
      try { this.write({ id, type, ...fields }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    }); }
  write(record) {
    if (!writeJsonLine(this.proc, record)) throw new Error("Pi bridge is not connected"); }
  stop() {
    this.stopping = true;
    this.connection?.clients.delete(this);
    this.connection = null;
    this.proc = null;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("Pi view detached")); }
    this.pending.clear();
  }
}

// A Telegram view of a native interactive Pi; multiple views may share the same PaneRpc connection.
class ChatSession {
  constructor(gateway, { threadId = null, cwd }) {
    this.gateway = gateway;
    this.threadId = threadId;
    this.key = threadId ? `t:${threadId}` : "main";
    this.cwd = cwd;
    const stored = gateway.state.herdrPanes?.[this.key];
    this.binding = typeof stored === "string" ? { paneId: stored, cwd, owned: true } : { cwd, ...stored };
    this.chatId = gateway.chatId;

    this.draft = null;
    this.toolPanel = null;
    this.queue = { steering: [], followUp: [] };
    this.isStreaming = false;
    this.abortedRun = false;
    this.repliedInRun = false;
    this.typingTimer = null;
    this.lastModel = null;
    this.lastPrompt = null;
    this.mediaGroups = new Map();
    this.eventChain = Promise.resolve();
    this.updateChain = Promise.resolve();
    this.runOrigin = "telegram";
    this.lastTopicName = null;

    this.pi = this.createPi(); }
  createPi() {
    return new PaneRpc(this, (event) => this.queueEvent(event), (exit) => {
      this.handlePiExit(exit).catch((error) => console.warn(`[bridge] disconnect: ${error.message}`));
    }); }
  threadExtra(extra = {}) { return this.threadId ? { message_thread_id: this.threadId, ...extra } : extra; }
  send(text, extra = {}) { return this.gateway.telegram.send(this.chatId, text, this.threadExtra(extra)); }
  sendOne(text, extra = {}) { return this.gateway.telegram.sendOne(this.chatId, text, this.threadExtra(extra)); }
  sendDocument(path, extra = {}) { return this.gateway.queueUpload(() => this.gateway.telegram.sendDocument(this.chatId, path, this.threadExtra(extra))); }
  action(payload, ttl = 10 * 60_000) { return this.gateway.action({ ...payload, sessionKey: this.key }, ttl); }
  keyboard(items, ttl) { return { reply_markup: { inline_keyboard: items.map(({ label, action }) => [{ text: label.slice(0, 60), callback_data: this.action(action, ttl) }]) } }; }
  queueEvent(event) {
    this.eventChain = this.eventChain.then(() => this.handleEvent(event)).catch((error) => console.error(`Pi event [${this.key}]:`, error)); }
  startTyping() {
    if (this.typingTimer) return;
    this.gateway.telegram.sendChatAction(this.chatId, "typing", this.threadExtra());
    this.typingTimer = setInterval(() => { this.gateway.telegram.sendChatAction(this.chatId, "typing", this.threadExtra()); }, 4500);
    this.typingTimer.unref(); }
  stopTyping() {
    if (this.typingTimer) { clearInterval(this.typingTimer); this.typingTimer = null; }
  }

  async onSessionSwitched(sessionPath = null) {
    const state = await this.pi.request("get_state");
    this.binding = { ...this.binding, sessionFile: sessionPath || state.sessionFile };
    await this.gateway.persistPaneSession(this); }
  async handlePiExit({ expected }) {
    if (expected) return;
    this.stopTyping();
    this.isStreaming = false; }
  resetSessionState() {
    this.isStreaming = false;
    this.stopTyping();
    for (const group of this.mediaGroups.values()) {
      if (typeof group === "object" && group !== null) {
        if (group.timer) clearTimeout(group.timer);
        group.cancelled = true;
        if (group.resolveReady) group.resolveReady();
      }
    }
    this.mediaGroups.clear();
    for (const [key, action] of this.gateway.actions) {
      if (action.type === "ui" && action.sessionKey === this.key) this.gateway.actions.delete(key);
    }
    if (this.toolPanel?.timer) clearTimeout(this.toolPanel.timer);
    this.toolPanel = null;
    if (this.draft) {
      if (this.draft.timer) clearTimeout(this.draft.timer);
      this.draft.closed = true;
      if (this.draft.messageId) this.gateway.telegram.deleteMessage(this.chatId, this.draft.messageId).catch(() => {});
    }
    this.draft = null;
    this.queue = { steering: [], followUp: [] }; }
  async prompt(message, images, streamingBehavior) {
    this.runOrigin = "telegram";
    this.startTyping();
    if (!streamingBehavior && !this.isStreaming) this.lastPrompt = { message, images };
    try {
      const fields = { message };
      if (images) fields.images = images;
      const behavior = streamingBehavior || (this.isStreaming ? "steer" : undefined);
      if (behavior) fields.streamingBehavior = behavior;
      console.log(`${new Date().toISOString()} [prompt${this.threadId ? `:${this.threadId}` : ""}] sending to Pi (behavior=${behavior || "initial"}, chars=${message.length})`);
      try {
        await this.pi.request("prompt", fields);
      } catch (error) {
        if (!behavior && /streaming/i.test(error.message)) {
          fields.streamingBehavior = "steer";
          await this.pi.request("prompt", fields);
          this.isStreaming = true;
        } else throw error;
      }
      console.log(`${new Date().toISOString()} [prompt${this.threadId ? `:${this.threadId}` : ""}] accepted by Pi`);
      if (fields.streamingBehavior === "followUp") await this.send("↪ Queued as follow-up", { disable_notification: true });
    } catch (error) {
      this.stopTyping();
      throw error;
    }
  }

  async handleCommand({ name, argument }, original, updateId = null) {
    switch (name) {
      case "start":
      case "help":
        await this.send(HELP);
        return this.showCommands();
      case "topic": return this.gateway.handleTopicCommand(this, argument);
      case "close": return this.gateway.handleCloseCommand(this);
      case "model": return this.showModels(argument);
      case "thinking": return this.showThinking(argument);
      case "resume": return this.showSessions();
      case "new": {
        this.abortedRun = true;
        if (this.pi.proc) {
          await this.pi.request("clear_queue").catch(() => {});
          await this.pi.request("abort").catch(() => {});
        }
        const stateBefore = this.pi.proc ? await this.pi.request("get_state").catch(() => null) : null;
        const targetModel = (stateBefore?.model?.provider && stateBefore?.model?.id)
          ? { provider: stateBefore.model.provider, modelId: stateBefore.model.id }
          : (this.lastModel || null);
        this.resetSessionState();
        if (this.pi.proc) {
          const result = await this.pi.request("new_session");
          if (result.cancelled) return this.send("New session cancelled");
          await this.onSessionSwitched();
        }
        if (targetModel) {
          await this.pi.request("set_model", targetModel).catch((err) => {
            console.warn(`[new] failed to restore model ${targetModel.provider}/${targetModel.modelId}: ${err.message}`);
          });
          this.lastModel = targetModel;
        }
        const state = await this.pi.request("get_state").catch(() => null);
        const modelStr = state?.model ? `${state.model.provider}/${state.model.id}` : "";
        const modelNote = modelStr ? ` · ${modelStr}` : "";
        return this.send(`✅ New session started${modelNote}`);
      }
      case "name": {
        if (!argument) return this.send("Usage: /name <session-name>");
        await this.pi.request("set_session_name", { name: argument });
        return this.send(`✅ Session name set to: ${argument}`);
      }
      case "status": return this.showSession();
      case "agents": return this.gateway.showHerdrAgents();
      case "compact": {
        this.startTyping();
        try {
          const res = await this.pi.request("compact", argument ? { customInstructions: argument } : {});
          return this.send(res?.tokensBefore ? `Context compacted: ${res.tokensBefore} → ~${res.estimatedTokensAfter} tokens` : "Context compacted.");
        } finally { this.stopTyping(); }
      }
      case "followup": {
        if (!argument) return this.send("Usage: /followup <message>");
        return this.prompt(argument, undefined, "followUp");
      }
      case "abort": {
        this.abortedRun = true;
        if (this.pi.proc) await this.pi.request("abort").catch(() => {});
        const kept = this.queue;
        this.resetSessionState();
        this.queue = kept;
        return this.send("⏹ Stopped (queued messages kept)");
      }
      case "restart": {
        const message = await this.send("🔄 Restarting gateway…");
        await this.gateway.saveState({ pendingRestartMessageId: message.message_id });
        if (updateId) {
          const tmp = `${this.gateway.telegram.offsetPath}.tmp`;
          await writeFile(tmp, String(updateId + 1), { mode: 0o600 });
          await rename(tmp, this.gateway.telegram.offsetPath);
        }
        this.gateway.stop();
        setTimeout(() => process.exit(0), 100);
        return;
      }
      case "sh": {
        if (!argument) return this.send("Usage: /sh <command>");
        if (/install\.sh\s+(restart|stop|uninstall)|launchctl\s+(bootout|kickstart)/i.test(argument)) {
          return this.send("❌ Service restart/stop commands are blocked here. Send /restart to restart the gateway.");
        }
        this.startTyping();
        try {
          const res = await this.pi.request("bash", { command: argument });
          const output = res.output ? res.output.trim() : "(no output)";
          return this.send(output.split("\n").length > 3 ? expandableBlockquote(output) : output);
        } catch (error) {
          if (!/abort/i.test(error.message)) return this.send(`❌ ${error.message}`);
        } finally { this.stopTyping(); }
        return;
      }
      default: {
        const data = await this.pi.request("get_commands");
        const targets = commandRoutes(data.commands).get(name);
        if (targets?.size > 1) return this.send(`Ambiguous command: /${name}\nMatches: ${[...targets].map((target) => `/${target}`).join(", ")}\nUse an unambiguous native name from /help, or run it in the Pi terminal.`);
        if (targets?.size === 1) return this.prompt(`/${[...targets][0]}${argument ? ` ${argument}` : ""}`);
        return this.send(`Unknown command: /${name}\nUse /help`);
      }
    }
  }

  async handleMediaGroup(messages) {
    const mediaList = await Promise.all(messages.map((m) => this.gateway.extractMedia(m)));
    const files = [], images = [];
    let caption = "";
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].caption) caption = messages[i].caption;
      const media = mediaList[i];
      if (!media) continue;
      files.push(media.saved);
      if (media.image) images.push(media.image);
    }
    if (files.length) await this.prompt(attachmentPrompt(caption || "Please review these files.", files), images.length ? images : undefined);
    else if (caption) await this.prompt(caption); }
  async showCommands() {
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
    await this.send(text); }
  async retryLastPrompt() {
    const { message, images } = this.lastPrompt;
    await this.send(`🔁 Retrying last prompt (${message.length} chars)…`);
    await this.prompt(message, images); }
  async showModels(query) {
    const data = await this.pi.request("get_available_models");
    const models = data.models || [];
    if (query) {
      const exact = models.find((m) => `${m.provider}/${m.id}` === query || m.id === query);
      if (exact) {
        await this.pi.request("set_model", { provider: exact.provider, modelId: exact.id });
        this.lastModel = { provider: exact.provider, modelId: exact.id };
        return this.send(`✅ ${exact.provider}/${exact.id}`);
      }
    }
    const filtered = models.filter((m) => !query || `${m.provider}/${m.id} ${m.name}`.toLowerCase().includes(query.toLowerCase()));
    if (!filtered.length) return this.send(`No matching model: ${query}`);
    const display = filtered.slice(0, 18);
    const suffix = filtered.length > 18 ? `\n\n(${filtered.length} models; showing first 18 — use /model <query> to filter)` : "";
    return this.send(`Pick a model:${suffix}`, this.keyboard(display.map((m) => ({ label: `${m.provider}/${m.id}`, action: { type: "model", provider: m.provider, modelId: m.id } })))); }
  async showThinking(argument) {
    const data = await this.pi.request("get_available_thinking_levels");
    if (argument) {
      if (!data.levels.includes(argument)) return this.send(`Available levels: ${data.levels.join(", ")}`);
      await this.pi.request("set_thinking_level", { level: argument });
      return this.send(`✅ thinking: ${argument}`);
    }
    return this.send("Pick a thinking level:", this.keyboard(data.levels.map((l) => ({ label: l, action: { type: "thinking", level: l } })))); }
  async sessionFiles() {
    const root = process.env.PI_CODING_AGENT_SESSION_DIR || join(resolvePath(process.env.PI_CODING_AGENT_DIR || "~/.pi/agent", this.cwd), "sessions");
    return scanDesktopSessions(resolvePath(root, this.cwd), this.cwd, 15); }
  async showSessions() {
    const sessions = (await this.sessionFiles()).slice(0, 12);
    if (!sessions.length) return this.send("No past sessions for this directory yet.");
    return this.send("Pick a session:", this.keyboard(sessions.map((s) => ({ label: s.title, action: { type: "resume", path: s.path } })))); }
  async showSession() {
    const [state, stats] = await Promise.all([this.pi.request("get_state"), this.pi.request("get_session_stats")]);
    const model = state.model ? `${state.model.provider}/${state.model.id}` : "none";
    const context = stats.contextUsage ? `${stats.contextUsage.tokens ?? "?"}/${stats.contextUsage.contextWindow} (${stats.contextUsage.percent ?? "?"}%)` : "n/a";
    const lines = [
      `Name: ${state.sessionName || "(unnamed)"}`, `Model: ${model}`, `Thinking: ${state.thinkingLevel}`,
      `State: ${state.isStreaming ? "working" : "idle"}`, `Messages: ${stats.totalMessages}`, `Context: ${context}`,
      `Cost: $${Number(stats.cost || 0).toFixed(4)}`, `Session: ${state.sessionId}`, `File: ${state.sessionFile || "not persisted"}`,
    ];
    await this.send(lines.join("\n")); }
  async handleCallbackAction(action, callback) {
    if (action.type === "jump_pane") {
      const connection = this.gateway.bridge.connections.get(action.paneId);
      if (!connection) return this.send("That Pi is not connected. Enable /remote-control in its pane first.");
      const old = this.binding;
      this.pi.stop();
      this.resetSessionState();
      this.cwd = connection.hello.cwd;
      this.binding = { paneId: action.paneId, sessionFile: connection.hello.sessionFile, cwd: this.cwd, owned: false };
      this.pi.bind(connection);
      await this.gateway.persistPaneSession(this);
      await this.send(`✅ This topic now views Pi in ${action.paneId}. Previous session ${old.paneId || ""} was not stopped.`);
      return;
    }
    if (action.type === "model") {
      await this.pi.request("set_model", { provider: action.provider, modelId: action.modelId });
      this.lastModel = { provider: action.provider, modelId: action.modelId };
      await this.send(`✅ ${action.provider}/${action.modelId}`);
    } else if (action.type === "retry") {
      if (!this.lastPrompt) return this.send("No prompt to retry");
      if (this.isStreaming) return this.send("⚠️ Still streaming; /abort first");
      await this.retryLastPrompt();
    } else if (action.type === "thinking") {
      await this.pi.request("set_thinking_level", { level: action.level });
      await this.send(`✅ thinking: ${action.level}`);
    } else if (action.type === "resume") {
      const paneId = await this.gateway.liveSessionPane(action.path);
      if (paneId && paneId !== this.binding.paneId) {
        return this.send(`This session is already open in ${paneId}; no second Pi was started.`, this.keyboard([
          { label: "View that Pi here", action: { type: "jump_pane", paneId } },
        ]));
      }
      if (this.isStreaming) await this.pi.request("abort").catch(() => {});
      this.resetSessionState();
      const result = await this.pi.request("switch_session", { sessionPath: action.path });
      if (!result.cancelled) {
        const state = await this.pi.request("get_state").catch(() => null);
        if (state?.model?.provider && state?.model?.id) this.lastModel = { provider: state.model.provider, modelId: state.model.id };
        await this.onSessionSwitched(action.path);
      }
      await this.send(result.cancelled ? "Resume cancelled" : "✅ Session resumed");
    } else if (action.type === "ui") {
      for (const [k, v] of this.gateway.actions) {
        if (v.type === "ui" && v.requestId === action.requestId) this.gateway.actions.delete(k);
      }
      this.pi.write({ type: "extension_ui_response", id: action.requestId, ...action.response });
      if (callback.message) {
        const chosen = action.response?.value ?? (action.response?.confirmed ? "Confirm" : "Cancel");
        await this.gateway.telegram.edit(callback.message.chat.id, callback.message.message_id, `${callback.message.text}\n\n✅ ${chosen}`).catch(() => {});
      }
    }
  }

  async handleEvent(event) {
    if (event.type === "remote_user_input") {
      this.runOrigin = "terminal";
      await this.send(`🖥 ${event.text}`, { disable_notification: true });
      return;
    }
    if (event.type === "session_info_changed") {
      if (this.threadId) {
        const prefix = this.binding?.owned === false ? "📡 " : "";
        const base = (event.name || basename(this.cwd) || "topic").trim();
        const newName = `${prefix}${base}`.slice(0, 128);
        if (this.lastTopicName !== newName) {
          this.lastTopicName = newName;
          // ref: Telegram Bot API editForumTopic works in private chats with topics enabled (https://core.telegram.org/bots/api#editforumtopic)
          await this.gateway.telegram.call("editForumTopic", {
            chat_id: this.chatId,
            message_thread_id: this.threadId,
            name: newName,
          }).catch((err) => {
            console.warn(`[topic] failed to rename topic ${this.threadId}: ${err.message}`);
          });
        }
      }
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
    if (event.type === "agent_start") {
      this.isStreaming = true;
      this.repliedInRun = false;
      this.abortedRun = false;
      this.startTyping();
      if (this.toolPanel?.timer) clearTimeout(this.toolPanel.timer);
      this.toolPanel = null;
      console.log(`${new Date().toISOString()} [run${this.threadId ? `:${this.threadId}` : ""}] agent_start`);
    }
    if (event.type === "agent_settled") {
      this.isStreaming = false;
      this.stopTyping();
      console.log(`${new Date().toISOString()} [run${this.threadId ? `:${this.threadId}` : ""}] agent_settled`);
      if (this.toolPanel && this.toolPanel.tools.length) {
        for (const tool of this.toolPanel.tools) {
          if (tool.status === "running") tool.status = "done";
        }
        this.scheduleToolPanelUpdate(true, true);
      }
      if (this.draft?.text) {
        this.repliedInRun = true;
        const draft = this.draft;
        this.draft = null;
        if (draft.timer) clearTimeout(draft.timer);
        draft.closed = true;
        this.gateway.queueTelegram(() => this.finishDraft(draft));
      }
      this.abortedRun = false;
      this.runOrigin = "telegram";
    }
    if (event.type === "queue_update") {
      this.queue = { steering: event.steering, followUp: event.followUp };
    }
    if (!this.gateway.chatReady) return;

    if (event.type === "compaction_end" && event.errorMessage) {
      const extra = this.gateway.isUserPresent() ? { disable_notification: true } : {};
      await this.send(`⚠️ Context compaction failed: ${event.errorMessage}`, extra); }
    if (event.type === "message_start" && event.message?.role === "assistant") {
      this.draft = { text: "", messageId: null, timer: null, closed: false };
    }
    if (event.type === "message_update") {
      const update = event.assistantMessageEvent;
      if (update?.type === "text_delta" && this.draft) {
        this.draft.text += update.delta;
        if (!this.draft.timer) {
          const draft = this.draft;
          draft.timer = setTimeout(() => {
            draft.timer = null;
            if (draft.flushQueued) return;
            draft.flushQueued = true;
            this.gateway.queueTelegram(() => {
              draft.flushQueued = false;
              return this.flushDraft(draft);
            });
          }, 1200);
        }
      }
    }
    if (event.type === "message_end" && event.message?.role === "assistant") {
      if (event.message.stopReason === "aborted") this.abortedRun = true;
      const draft = this.draft || { text: "", messageId: null, timer: null };
      this.draft = null;
      if (draft.timer) clearTimeout(draft.timer);
      draft.closed = true;
      const content = extractText(event.message.content);
      if (content) draft.text = content;
      if (event.message.stopReason === "error" || event.message.errorMessage) {
        const errText = formatAssistantError(event.message.errorMessage);
        draft.text = draft.text ? `${draft.text}\n\n${errText}` : errText;
        draft.isError = true;
      }
      const outTok = event.message.usage?.output;
      console.log(`${new Date().toISOString()} [run${this.threadId ? `:${this.threadId}` : ""}] message_end (${outTok ? `${outTok} tokens` : "assistant"}${event.message.stopReason ? `, reason: ${event.message.stopReason}` : ""})`);
      if (draft.text) {
        this.repliedInRun = true;
        this.gateway.queueTelegram(() => this.finishDraft(draft));
      }
    }

    if (event.type === "tool_execution_start") {
      if (!this.toolPanel) this.toolPanel = { messageId: null, tools: [], timer: null, sending: false };
      const summary = toolSummary(event.toolName, event.args);
      console.log(`${new Date().toISOString()} [tool${this.threadId ? `:${this.threadId}` : ""}] start: ${event.toolName}`);
      this.toolPanel.tools.push({
        id: event.toolCallId,
        summary,
        status: "running",
        startedAt: Date.now(),
      });
      this.scheduleToolPanelUpdate(false, false);
    }
    if (event.type === "tool_execution_end") {
      if (this.toolPanel) {
        const tool = this.toolPanel.tools.find((item) => item.id === event.toolCallId);
        if (tool) tool.status = event.isError ? "error" : "done";
        const dur = tool ? `${Date.now() - tool.startedAt}ms` : "?";
        console.log(`${new Date().toISOString()} [tool${this.threadId ? `:${this.threadId}` : ""}] end: ${event.toolName} (${event.isError ? "error" : "done"}, took ${dur})`);
        this.scheduleToolPanelUpdate(false, false);
      }
      if (event.toolName === "remote_attach" && !event.isError) {
        const rawPaths = event.result?.details?.paths || event.args?.paths || [];
        const paths = event.result?.details?.paths ? rawPaths : rawPaths.map((p) => resolve(this.cwd, p));
        for (const path of paths) {
          this.gateway.queueUpload(async () => {
            try { await this.gateway.telegram.sendDocument(this.chatId, path, this.threadExtra()); }
            catch (error) { await this.send(`❌ Failed to send attachment ${basename(path)}: ${error.message}`); }
          });
        }
      }
    }
    if (event.type === "extension_ui_request") await this.handleUiRequest(event);
    if (event.type === "extension_error") await this.send(`❌ Extension ${event.extensionPath}: ${event.error}`); }
  scheduleToolPanelUpdate(force = false, isSettled = false) {
    if (!this.toolPanel) return;
    if (force) {
      if (this.toolPanel.timer) {
        clearTimeout(this.toolPanel.timer);
        this.toolPanel.timer = null;
      }
      this.gateway.queueTelegram(() => this.flushToolPanel(isSettled));
      return;
    }
    if (!this.toolPanel.messageId && !this.toolPanel.sending) {
      this.toolPanel.sending = true;
      this.gateway.queueTelegram(() => this.flushToolPanel(false));
      return;
    }
    if (!this.toolPanel.timer) {
      this.toolPanel.timer = setTimeout(() => {
        if (this.toolPanel) {
          this.toolPanel.timer = null;
          this.gateway.queueTelegram(() => this.flushToolPanel(false));
        }
      }, 1200);
    }
  }

  async flushToolPanel(isSettled = false) {
    if (!this.toolPanel || !this.toolPanel.tools.length) return;
    const text = renderToolPanel(this.toolPanel.tools, isSettled);
    if (!text) return;
    try {
      if (this.toolPanel.messageId) {
        await this.gateway.telegram.edit(this.chatId, this.toolPanel.messageId, text);
      } else {
        const sent = await this.sendOne(text, { disable_notification: true });
        if (this.toolPanel) this.toolPanel.messageId = sent.message_id;
      }
    } finally {
      if (this.toolPanel) this.toolPanel.sending = false;
    }
  }

  async flushDraft(draft) {
    if (!draft.text || draft.flushing || draft.closed) return;
    if (this.gateway.telegram.retryNotBefore > Date.now()) return;
    draft.flushing = true;
    try {
      const text = previewText(draft.text);
      if (text === draft.sentPreview) return;
      if (draft.messageId) {
        await this.gateway.telegram.edit(this.chatId, draft.messageId, text, true);
      } else {
        const sent = await this.sendOne(text, { disable_notification: true });
        draft.messageId = sent.message_id;
      }
      draft.sentPreview = text;
    } catch (error) {
      console.error(`${new Date().toISOString()} [ui${this.threadId ? `:${this.threadId}` : ""}] preview update failed:`, error.message);
    } finally {
      draft.flushing = false;
    }
  }

  async finishDraft(draft) {
    if (!draft.text) return;
    draft.closed = true;
    try {
      const parts = chunks(draft.text);
      const retryMarkup = (draft.isError && this.lastPrompt) ? {
        reply_markup: {
          inline_keyboard: [[{ text: "🔁 Retry", callback_data: this.action({ type: "retry" }, 60 * 60_000) }]],
        },
      } : {};
      if (draft.messageId) {
        const extra0 = parts.length === 1 ? retryMarkup : {};
        await this.gateway.telegram.edit(this.chatId, draft.messageId, parts[0], false, extra0);
        for (let i = 1; i < parts.length; i++) {
          const extra = i === parts.length - 1 ? retryMarkup : {};
          await this.sendOne(parts[i], extra);
        }
      } else {
        for (let i = 0; i < parts.length; i++) {
          const extra = i === parts.length - 1 ? retryMarkup : {};
          await this.sendOne(parts[i], extra);
        }
      }
      console.log(`${new Date().toISOString()} [ui${this.threadId ? `:${this.threadId}` : ""}] final reply sent (${parts.length} parts)`);
    } catch (error) {
      console.error(`${new Date().toISOString()} [ui${this.threadId ? `:${this.threadId}` : ""}] final reply delivery failed:`, error.message);
      await this.send(`❌ Reply delivery failed: ${error.message}`).catch(() => {});
    }
  }

  async handleUiRequest(request) {
    if (request.method === "select") {
      const options = request.options.map((value) => ({ label: value, response: { value } }));
      const sent = await this.send([request.title, request.message].filter(Boolean).join("\n"), this.keyboard(options.map((option) => ({
        label: option.label, action: { type: "ui", requestId: request.id, response: option.response },
      }))));
      this.uiMessages ||= new Map();
      if (sent?.message_id) this.uiMessages.set(request.id, sent.message_id);
    }
  }

  stop() {
    this.resetSessionState();
    this.pi?.stop?.();
  }
}

class Gateway {
  constructor(config) {
    this.config = config;
    this.chatId = config.allowedUserId;
    this.chatReady = false;
    this.state = loadState(config.stateDir);
    this.telegram = new Telegram(config.botToken, join(config.stateDir, "telegram-offset"));
    this.actions = new Map();
    this.als = new AsyncLocalStorage();
    this.telegramChain = Promise.resolve();
    this.uploadChain = Promise.resolve();
    this.stateWriteChain = Promise.resolve();
    this.downloadCleanupTimer = null;
    this.herdrWatcher = null;
    this.herdrMessages = new Map();
    this.bridge = new PaneServer(join(config.stateDir, "bridge.sock"), (connection) => this.onPaneHello(connection));
    this.paneStartChain = Promise.resolve();
    this.herdrEnvironment = null;

    const origSend = this.telegram.send.bind(this.telegram);
    this.telegram.send = (chatId, text, extra = {}) =>
      this.queueTelegram(() => origSend(chatId, text, extra));

    const origSendOne = this.telegram.sendOne.bind(this.telegram);
    this.telegram.sendOne = (chatId, text, extra = {}) =>
      this.queueTelegram(() => origSendOne(chatId, text, extra));

    const origEdit = this.telegram.edit.bind(this.telegram);
    this.telegram.edit = (chatId, messageId, text, ephemeral = false) =>
      this.queueTelegram(() => origEdit(chatId, messageId, text, ephemeral));

    this.sessions = new Map();
    this.mainSession = new ChatSession(this, { threadId: null, cwd: config.cwd });
    this.sessions.set("main", this.mainSession);

    // 延迟初始化 state.json 中持久化的有效 topic 会话
    for (const [threadId, info] of Object.entries(this.state.topics || {})) {
      if (info?.cwd && existsSync(info.cwd)) {
        const tid = Number(threadId);
        this.sessions.set(`t:${tid}`, new ChatSession(this, { threadId: tid, cwd: info.cwd }));
      }
    }
  }

  // ref: Claude Code Remote Control CLAUDE_CLIENT_PRESENCE_FILE skips phone pushes while present (https://code.claude.com/docs/en/remote-control)
  isUserPresent() {
    if (!this.config?.presenceFile) return false;
    try {
      return Boolean(statSync(this.config.presenceFile, { throwIfNoEntry: false }));
    } catch {
      return false;
    }
  }

  async persistPaneSession(session) {
    this.state.herdrPanes = { ...this.state.herdrPanes, [session.key]: { ...session.binding, cwd: session.cwd } };
    if (session.threadId !== null) this.state.topics[session.threadId] = { ...this.state.topics[session.threadId], cwd: session.cwd };
    await this.saveState({ herdrPanes: this.state.herdrPanes, topics: this.state.topics }); }
  async onPaneHello(connection) {
    const hello = connection.hello;
    let targets = [...this.sessions.values()].filter((s) => s.binding.paneId === hello.paneId || s.binding.sessionFile === hello.sessionFile);
    if (!targets.length) {
      if (!this.chatReady) return;
      const me = this.me || await this.telegram.call("getMe");
      if (!me?.has_topics_enabled) {
        console.warn(`[bridge] Topics must be enabled to attach desktop pane ${hello.paneId}`);
        return;
      }
      const topicName = hello.sessionName || hello.recent?.firstUserText || basename(hello.cwd) || "Pi";
      const topicTitle = `📡 ${topicName}`.slice(0, 128);
      const created = await this.telegram.call("createForumTopic", { chat_id: this.chatId, name: topicTitle });
      const threadId = created.message_thread_id;
      const session = new ChatSession(this, { threadId, cwd: hello.cwd });
      session.lastTopicName = topicTitle;
      session.binding = { paneId: hello.paneId, sessionFile: hello.sessionFile, cwd: hello.cwd, owned: false };
      this.sessions.set(session.key, session);
      targets = [session];
      await session.send(`📡 Remote control on — ${hello.paneId}\n${hello.cwd}\nThe terminal and this topic share one Pi session.`);
      if (hello.recent && (hello.recent.lastUserText || hello.recent.lastAssistantText)) {
        const parts = [];
        if (hello.recent.lastUserText) parts.push(`👤 ${hello.recent.lastUserText}`);
        if (hello.recent.lastAssistantText) parts.push(`🤖 ${hello.recent.lastAssistantText}`);
        if (parts.length) {
          await session.send(parts.join("\n\n"), { disable_notification: true });
        }
      }
    }
    for (const session of targets) {
      if (session.threadId && !session.lastTopicName) {
        const prefix = session.binding?.owned === false ? "📡 " : "";
        session.lastTopicName = `${prefix}${hello.sessionName || hello.recent?.firstUserText || basename(hello.cwd) || "Pi"}`.slice(0, 128);
      }
      const wasUnbound = !session.pi.proc;
      session.pi.bind(connection);
      const state = hello.state;
      if (state) {
        session.isStreaming = state.isStreaming;
        if (state.model) session.lastModel = { provider: state.model.provider, modelId: state.model.id };
      }
      await this.persistPaneSession(session);
      // Startup may register bot commands before Pi attached; refresh native aliases once the main view binds.
      if (wasUnbound && session.threadId === null) this.registerBotCommands().catch(() => {});
    }
  }

  async liveSessionPane(sessionFile) {
    const connected = this.bridge.find({ sessionFile });
    if (connected) return connected.hello.paneId;
    const env = this.herdrEnvironment;
    if (!env?.HERDR_BIN_PATH) return null;
    const raw = await runCommand(env.HERDR_BIN_PATH, ["agent", "list"], { env: { ...process.env, ...env }, timeout: 5000 });
    const data = JSON.parse(raw);
    return (data.result?.agents || data.agents || []).find((a) => a.agent === "pi" && resolveAgentSessionFile(a) === sessionFile)?.pane_id || null; }
  ensurePaneSession(rpc, options = {}) {
    // Serialize starts, including sessions arriving concurrently from different topics.
    const work = this.paneStartChain.then(() => this.startPaneSession(rpc, options));
    this.paneStartChain = work.catch(() => {});
    return work;
  }

  // Returns true when rpc ends up bound to a live Pi pane. spawn:false attaches only —
  // a gateway (re)start must never create workspaces or launch Pi processes by itself.
  async startPaneSession(rpc, { spawn = true } = {}) {
    const session = rpc.session;
    if (HERDR_DISABLED_FOR_TEST && !this.bridge.server) throw new Error("Self-test must provide a fake connected pane");
    await this.bridge.start();
    const existing = this.bridge.find(session.binding);
    if (existing) {
      rpc.bind(existing);
      await this.persistPaneSession(session);
      return true;
    }
    const file = session.binding.sessionFile;
    const livePane = file ? await this.liveSessionPane(file) : null;
    if (livePane) {
      const nativeEnv = this.herdrEnvironment;
      const raw = await runCommand(nativeEnv.HERDR_BIN_PATH, ["pane", "process-info", "--pane", livePane], { env: { ...process.env, ...nativeEnv }, timeout: 5000 });
      if (!paneHasForegroundShell(JSON.parse(raw).result?.process_info)) {
        // A running Pi without hello is not permission to create another writer (or another workspace).
        rpc.bind(await this.bridge.waitFor((c) => c.hello.sessionFile === file && c.hello.paneId === livePane));
        await this.persistPaneSession(session);
        return true;
      }
    }
    if (!spawn) return false;
    if (HERDR_DISABLED_FOR_TEST) throw new Error("Self-test must provide a fake connected pane");
    const env = await resolveHerdrEnvironment(session.cwd, {
      persistedPaneId: session.binding.paneId,
      excludePaneIds: this.getOwnedPaneIds(session), threadId: session.threadId,
      paneEnv: { REMOTE_PI_ATTACH: "1", REMOTE_PI_BRIDGE_SOCKET: this.bridge.path },
    });
    if (!env.HERDR_PANE_ID) throw new Error("Herdr is required: install herdr and ensure its server is reachable");
    this.herdrEnvironment = env;
    rpc.herdrEnv = env;
    const bin = env.HERDR_BIN_PATH;
    const options = { env: { ...process.env, ...env }, timeout: 5000 };
    const paneId = env.HERDR_PANE_ID;
    session.binding = { ...session.binding, paneId, workspaceId: env.HERDR_WORKSPACE_ID, cwd: session.cwd, owned: env.REMOTE_PI_CREATED_PANE === "1" || session.binding.owned === true };
    await this.persistPaneSession(session);
    const raw = await runCommand(bin, ["pane", "get", paneId], options);
    const pane = JSON.parse(raw).result?.pane;
    let shell = false;
    for (let i = 0; i < 10; i++) {
      const info = JSON.parse(await runCommand(bin, ["pane", "process-info", "--pane", paneId], options)).result?.process_info;
      if (paneHasForegroundShell(info)) { shell = true; break; }
      if (env.REMOTE_PI_CREATED_PANE !== "1") break;
      await sleep(100);
    }
    if (!shell) {
      if (pane?.agent !== "pi") throw new Error(`Pane ${paneId} is busy; no terminal input was sent`);
      const connection = await this.bridge.waitFor((c) => c.hello.paneId === paneId);
      rpc.bind(connection);
      await this.persistPaneSession(session);
      return true;
    }
    this.startHerdrWatcher();
    // ref: Herdr CLI agent start requires a foreground shell; never send an export into another application.
    if (env.REMOTE_PI_CREATED_PANE !== "1") {
      await runCommand(bin, ["pane", "run", paneId, `export REMOTE_PI_ATTACH=1 REMOTE_PI_BRIDGE_SOCKET=${shellQuote(this.bridge.path)}`], options);
    }
    const waiting = this.bridge.waitFor((c) => c.hello.paneId === paneId);
    // Attach a rejection handler immediately; agent start can take longer than the hello deadline.
    waiting.catch(() => {});
    await runCommand(bin, ["agent", "start", `remote-${randomBytes(6).toString("hex")}`, "--kind", "pi", "--pane", paneId, "--", ...(file ? ["--session", file] : [])], { ...options, timeout: 45_000 });
    rpc.bind(await waiting);
    await this.persistPaneSession(session);
    return true; }
  async closePaneSession(session) {
    const otherViews = [...this.sessions.values()].filter((s) => s !== session && s.binding.paneId === session.binding.paneId);
    for (const other of otherViews) {
      other.binding.owned ||= session.binding.owned;
      await this.persistPaneSession(other);
    }
    if (!otherViews.length && session.pi.proc) {
      await session.pi.request(session.binding.owned ? "quit" : "remote_off", {}, 10_000);
    }
    if (session.binding.owned && !otherViews.length && session.binding.paneId) {
      const env = session.pi.herdrEnv;
      const bin = env.HERDR_BIN_PATH;
      if (bin) {
        const options = { env: { ...process.env, ...env }, timeout: 3000 };
        let shell = false;
        for (let i = 0; i < 30; i++) {
          const raw = await runCommand(bin, ["pane", "process-info", "--pane", session.binding.paneId], options);
          const info = JSON.parse(raw).result?.process_info;
          if (paneHasForegroundShell(info)) { shell = true; break; }
          await sleep(100);
        }
        if (!shell) throw new Error("Pi has not exited; pane and topic were kept");
        await runCommand(bin, ["pane", "close", session.binding.paneId], options);
      }
    }
    session.stop(); }
  getSession(key) {
    return this.sessions.get(key); }
  getOrCreateSession(message) {
    const key = sessionKeyOf(message);
    let session = this.sessions.get(key);
    if (!session) {
      if (key.startsWith("t:")) {
        const threadId = Number(key.slice(2));
        const mainCwd = this.mainSession.cwd;
        session = new ChatSession(this, { threadId, cwd: mainCwd });
        this.sessions.set(key, session);
        this.state.topics[threadId] = { cwd: mainCwd };
        this.saveState({ topics: this.state.topics }).catch((err) => {
          console.warn(`[state] failed to persist new topic ${threadId}: ${err.message}`);
        });
        session.send(`Topic session started with workspace:\n${mainCwd}\n\nUse /cwd to switch to another project.`);
      } else {
        session = this.mainSession;
      }
    }
    return session; }
  getOwnedPaneIds(excludingSession = null) {
    const panes = new Set();
    for (const [key, session] of this.sessions.entries()) {
      if (session !== excludingSession && (!excludingSession?.binding.paneId || session.binding.paneId !== excludingSession.binding.paneId)) {
        if (session.pi?.herdrEnv?.HERDR_PANE_ID) panes.add(session.pi.herdrEnv.HERDR_PANE_ID);
        if (this.state.herdrPanes?.[key]) panes.add(this.state.herdrPanes[key].paneId || this.state.herdrPanes[key]);
      }
    }
    return [...panes]; }
  async start() {
    // launchd 以 O_APPEND 持有日志 fd，newsyslog 处理不了这种 fd；启动时截断 + 每小时巡检（服务极少重启，只靠启动截断等于没截）
    const trimLog = () => stat(this.config.logFile).then((s) => s.size > MAX_LOG_SIZE ? truncate(this.config.logFile, 0) : null).catch(() => {});
    await trimLog();
    setInterval(trimLog, 60 * 60_000).unref();
    // ref: https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html — protect log and state permissions
    await chmod(this.config.logFile, 0o600).catch(() => {});
    await Promise.all([
      mkdir(this.config.stateDir, { recursive: true, mode: 0o700 }),
      mkdir(this.config.downloadsDir, { recursive: true, mode: 0o700 }),
    ]);
    await Promise.all([
      chmod(this.config.stateDir, 0o700).catch(() => {}),
      chmod(this.config.downloadsDir, 0o700).catch(() => {}),
    ]);
    await this.acquireLock();
    if (HERDR_DISABLED_FOR_TEST) throw new Error("Self-test cannot start the gateway");
    try {
      const bin = await runCommand("which", ["herdr"], { timeout: 2000 });
      const status = JSON.parse(await runCommand(bin, ["status", "server", "--json"], { timeout: 5000 }));
      if (status.socket) this.herdrEnvironment = { HERDR_BIN_PATH: bin, HERDR_SOCKET_PATH: status.socket };
    } catch { throw new Error("Herdr is required: install herdr and ensure its server is reachable"); }
    await this.bridge.start();
    await this.telegram.call("deleteWebhook", { drop_pending_updates: false }).catch(() => {});
    const me = await this.telegram.call("getMe");
    this.me = me;
    try { await this.telegram.call("getChat", { chat_id: this.chatId }); this.chatReady = true; }
    catch (error) { if (!error.message.includes("chat not found")) throw error; }
    let state;
    let attached = false;
    {
      // Startup only re-attaches to a Pi pane that is still running; if none is, the first message
      // spawns one via the lazy path (PaneRpc.ensureStarted → startPaneSession). Never spawn here.
      attached = await this.ensurePaneSession(this.mainSession.pi, { spawn: false }).catch(() => false);
      if (attached) {
        state = await this.mainSession.pi.request("get_state").catch(() => null);
        if (state?.model?.provider && state?.model?.id) {
          this.mainSession.lastModel = { provider: state.model.provider, modelId: state.model.id };
        }
      }
    }
    await this.registerBotCommands();
    this.startHerdrWatcher();
    for (const connection of this.bridge.connections.values()) await this.onPaneHello(connection);
    this.cleanupDownloads();
    this.downloadCleanupTimer = setInterval(() => this.cleanupDownloads(), 24 * 60 * 60_000);
    this.downloadCleanupTimer.unref?.();
    const sessionInfo = state?.sessionId ? `session ${state.sessionId}` : (attached ? "attached" : "not attached (starts on first message)");
    console.log(`${new Date().toISOString()} @${me.username} ready; Pi ${sessionInfo}`);
    await this.completeRestart();
    await this.telegram.poll((update) => this.dispatchUpdate(update)); }
  async completeRestart() {
    const messageId = this.state.pendingRestartMessageId;
    if (!messageId) return;
    try {
      await this.telegram.edit(this.chatId, messageId, "✅ Gateway restarted");
      await this.saveState({ pendingRestartMessageId: null });
    } catch (error) {
      console.warn(`[restart] failed to update restart notice: ${error.message}`);
    }
  }

  async saveDownload(fileId, name, needsBase64 = false) {
    const file = await this.telegram.call("getFile", { file_id: fileId });
    const response = await fetch(`${this.telegram.fileBase}/${file.file_path}`, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`Telegram download: ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    const safe = name.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80) || "file";
    const path = join(this.config.downloadsDir, `${Date.now()}-${safe}`);
    await writeFile(path, buffer);
    console.log(`${new Date().toISOString()} [download] ${name} (${buffer.length} bytes)`);
    return { path, data: needsBase64 ? buffer.toString("base64") : null }; }
  queueTelegram(work) {
    if (this.als.getStore()) return work();
    const next = this.telegramChain.then(() => this.als.run(true, work));
    this.telegramChain = next.catch((error) => console.error("Telegram output:", error));
    return next; }
  queueUpload(work) {
    const next = this.uploadChain.then(work);
    this.uploadChain = next.catch((error) => console.error("Upload output:", error));
    return next;
  }

  // Downloads expire after a fixed 30 days.
  async cleanupDownloads() {
    const cutoff = Date.now() - 30 * 24 * 60 * 60_000;
    let removed = 0;
    try {
      const entries = await readdir(this.config.downloadsDir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const path = join(this.config.downloadsDir, entry.name);
        try {
          const s = await stat(path);
          if (s.mtimeMs < cutoff) {
            await unlink(path).catch(() => {});
            removed++;
          }
        } catch {}
      }
      if (removed > 0) console.log(`${new Date().toISOString()} [cleanup] removed ${removed} expired download(s)`);
    } catch (err) {
      console.warn(`[cleanup] download retention failed: ${err.message}`);
    }
  }

  isAllowed(from, chat) {
    return String(from?.id) === this.config.allowedUserId && (!chat || chat.type === "private"); }
  dispatchUpdate(update) {
    if (parseCommand(update.message?.text?.trim() || "")?.name === "abort") {
      const m = update.message;
      if (!this.isAllowed(m.from, m.chat)) return Promise.resolve();
      this.chatReady = true;
      this.telegram.setReaction(this.chatId, m.message_id, "👀");
      const session = this.getOrCreateSession(m);
      return session.handleCommand({ name: "abort", argument: "" }, m.text, update.update_id);
    }
    if (update.message?.media_group_id && this.isAllowed(update.message.from, update.message.chat)) {
      const m = update.message;
      this.chatReady = true;
      const session = this.getOrCreateSession(m);
      this.telegram.setReaction(this.chatId, m.message_id, "👀");
      const key = `${this.chatId}:${m.media_group_id}`;
      let group = session.mediaGroups.get(key);
      if (!group) {
        let resolveReady;
        const ready = new Promise((r) => { resolveReady = r; });
        group = { messages: [], timer: null, ready, resolveReady, cancelled: false };
        session.mediaGroups.set(key, group);
        const next = session.updateChain.then(async () => {
          await group.ready;
          if (!group.cancelled && group.messages.length) await session.handleMediaGroup(group.messages);
        }).catch((err) => {
          console.error("Media group error:", err);
          session.send(`❌ Failed to process media group: ${err.message}`);
        });
        session.updateChain = next;
        group.done = next;
      }
      group.messages.push(m);
      if (group.timer) clearTimeout(group.timer);
      group.timer = setTimeout(() => { session.mediaGroups.delete(key); group.resolveReady(); }, 1200);
      return group.done;
    }
    if (update.message) {
      if (!this.isAllowed(update.message.from, update.message.chat)) return Promise.resolve();
      const session = this.getOrCreateSession(update.message);
      const next = session.updateChain.then(() => this.handleUpdate(update, session));
      session.updateChain = next.catch((err) => console.error("Telegram update error:", err));
      return next;
    }
    if (update.callback_query) {
      if (!this.isAllowed(update.callback_query.from, update.callback_query.message?.chat)) return Promise.resolve();
      const token = update.callback_query.data?.startsWith("a:") ? update.callback_query.data.slice(2) : "";
      const action = token ? this.actions.get(token) : null;
      const sessionKey = (!action?.type?.startsWith("herdr_") && action?.sessionKey) ? action.sessionKey : null;
      const session = sessionKey ? (this.sessions.get(sessionKey) || this.mainSession) : this.mainSession;
      const next = session.updateChain.then(() => this.handleUpdate(update, session));
      session.updateChain = next.catch((err) => console.error("Telegram update error:", err));
      return next;
    }
    return Promise.resolve(); }
  async handleUpdate(update, session = this.mainSession) {
    try {
      if (update.message) {
        if (!this.isAllowed(update.message.from, update.message.chat)) return;
        this.chatReady = true;
        const m = update.message;
        const kind = m.text ? "text" : m.photo ? "photo" : m.voice ? "voice" : m.document ? "document" : m.video ? "video" : m.video_note ? "video_note" : m.audio ? "audio" : "other";
        const textLen = (m.text || m.caption || "").length;
        console.log(`${new Date().toISOString()} [update] msg #${m.message_id}: ${textLen ? `${kind}, ${textLen} chars` : kind}`);
        await this.handleMessage(update.message, session, update.update_id);
      } else if (update.callback_query) {
        const callback = update.callback_query;
        if (!this.isAllowed(callback.from, callback.message?.chat)) return;
        this.chatReady = true;
        console.log(`${new Date().toISOString()} [update] callback #${callback.id}`);
        await this.handleCallback(callback, session);
      }
    } catch (error) {
      console.error("Telegram input:", error);
      await session.send(`❌ ${error.message}`);
    }
  }

  async extractMedia(m) {
    if (m.photo?.length) {
      const saved = await this.saveDownload(m.photo.at(-1).file_id, `photo-${m.message_id}.jpg`, true);
      return { saved, image: { type: "image", data: saved.data, mimeType: "image/jpeg" }, label: "photo" };
    }
    const file = m.document || m.voice || m.video || m.video_note || m.audio || m.animation;
    if (!file) return null;
    const isImage = file.mime_type?.startsWith("image/");
    const kind = m.voice ? "voice" : m.video_note ? "video_note" : m.audio ? "audio" : "file";
    const saved = await this.saveDownload(file.file_id, file.file_name || `${kind}-${m.message_id}${extensionFromMime(file.mime_type)}`, isImage);
    const image = isImage ? { type: "image", data: saved.data, mimeType: file.mime_type || "image/jpeg" } : null;
    const label = m.voice ? "voice message" : file.file_name ? `file ${file.file_name}` : kind;
    return { saved, image, label };
  }

  async handleMessage(message, session = this.getOrCreateSession(message), updateId = null) {
    const herdrPane = this.herdrWatcher && this.herdrMessages.get(message.reply_to_message?.message_id);
    if (herdrPane && message.text && !message.text.startsWith("/")) return this.replyToHerdrAgent(herdrPane, message);

    const media = await this.extractMedia(message);
    if (media) {
      this.telegram.setReaction(this.chatId, message.message_id, "👀");
      if (message.voice && this.config.sttCommand) {
        try {
          const transcript = await runStt(this.config.sttCommand, media.saved.path);
          await session.prompt(`${transcript}${message.caption ? `\n\n${message.caption}` : ""}`);
          return;
        } catch (error) { return session.send(`❌ ${error.message}`); }
      }
      await session.prompt(attachmentPrompt(message.caption || `User sent a ${media.label}.`, [media.saved]), media.image ? [media.image] : undefined);
      return;
    }
    const text = message.text?.trim();
    if (!text) return;
    this.telegram.setReaction(this.chatId, message.message_id, "👀");
    const command = parseCommand(text);
    if (command) await session.handleCommand(command, text, updateId);
    else await session.prompt(text); }
  async registerBotCommands() {
    let rpcCommands = [];
    if (this.mainSession.pi.proc) {
      const data = await this.mainSession.pi.request("get_commands").catch(() => null);
      rpcCommands = data?.commands || [];
    }
    const commands = [...BOT_COMMANDS];
    const routes = commandRoutes(rpcCommands);
    for (const command of rpcCommands) {
      const telegramName = telegramCommandName(command);
      if (RESERVED_COMMANDS.has(telegramName) || routes.get(telegramName)?.size !== 1) continue;
      if (!/^[a-z0-9_]{1,32}$/.test(telegramName) || commands.some((item) => item.command === telegramName)) continue;
      commands.push({ command: telegramName, description: (command.description || command.name).replace(/\s+/g, " ").slice(0, 200) });
    }
    const finalCommands = commands.slice(0, 100);
    await Promise.all([
      this.telegram.call("setMyCommands", { commands: finalCommands }),
      this.telegram.call("setMyCommands", { commands: finalCommands, scope: { type: "all_private_chats" } }),
    ]);
    console.log(`${new Date().toISOString()} [gateway] bot commands registered (${finalCommands.length})`); }
  async saveState(patch) {
    this.state = { ...this.state, ...patch };
    const statePath = join(this.config.stateDir, "state.json");
    // 串行化写入：并发 saveState 共享 tmp 路径会 ENOENT，且可能乱序完成
    const write = async () => {
      const tempPath = `${statePath}.${process.pid}.${++stateWriteCounter}.tmp`;
      try {
        await writeFile(tempPath, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
        await rename(tempPath, statePath);
      } catch (err) {
        console.warn(`[state] failed to persist state to ${statePath}: ${err.message}`);
      }
    };
    const next = this.stateWriteChain.then(write, write);
    this.stateWriteChain = next;
    return next; }
  action(payload, ttl = 10 * 60_000) {
    const now = Date.now();
    for (const [key, value] of this.actions) if (value.expires < now) this.actions.delete(key);
    const token = randomBytes(6).toString("base64url");
    this.actions.set(token, { ...payload, expires: now + ttl });
    return `a:${token}`; }
  startHerdrWatcher() {
    if (this.herdrWatcher) return;
    const env = [...this.sessions.values()].find((s) => s.pi?.herdrEnv?.HERDR_BIN_PATH)?.pi?.herdrEnv
      || this.herdrEnvironment;
    if (!env?.HERDR_BIN_PATH || !env?.HERDR_SOCKET_PATH) return;
    this.herdrWatcher = new HerdrWatcher({
      bin: env.HERDR_BIN_PATH,
      socketPath: env.HERDR_SOCKET_PATH,
      // Own remote_ask dialogs already have buttons; other TUI dialogs only get Enter/Esc.
      isExcluded: (paneId) => [...this.sessions.values()].some((s) => s.binding.paneId === paneId && s.uiMessages?.size),
      onTransition: ({ paneId, status, agent }) => status === "blocked" ? this.sendHerdrAgent(paneId, status, agent) : undefined,
    });
    this.herdrWatcher.start(); }
  async sendHerdrAgent(paneId, status, agent) {
    const watcher = this.herdrWatcher;
    const blocked = status === "blocked";
    const screen = await watcher.cli(["agent", "read", paneId, "--source", blocked ? "visible" : "recent-unwrapped", "--lines", "60"]).catch(() => "");
    const tail = herdrTail(screen);
    const label = watcher.label(paneId);
    const head = blocked ? `✋ ${label} needs your confirmation`
      : status === "done" ? `✅ ${label} finished`
      : `${HERDR_STATUS_ICON[status] || "❔"} ${label} — ${status}`;
    const text = [
      head,
      agent?.terminal_title_stripped ? `\`${agent.terminal_title_stripped.replace(/`/g, "'")}\`` : "",
      tail ? expandableBlockquote(tail) : "",
      blocked ? "Use Enter or Esc below, or answer in the terminal." : "Enable /remote-control in the pane to chat with this agent.",
    ].filter(Boolean).join("\n\n");

    const ttl = 24 * 60 * 60_000;
    const group = randomBytes(4).toString("hex");
    const keyButton = (label, keys) => ({ text: label.slice(0, 60), callback_data: this.action({ type: "herdr_keys", paneId, keys, label, group }, ttl) });
    const rows = [];
    if (blocked) {
      rows.push([keyButton("⏎ Enter", ["enter"]), keyButton("⎋ Esc", ["esc"])]);
    }
    rows.push([{ text: "🔄 Refresh", callback_data: this.action({ type: "herdr_peek", paneId }, ttl) }]);
    const bridge = [...this.sessions.values()].find((s) => s.binding.paneId === paneId);
    const userPresent = this.isUserPresent();
    const disableNotification = userPresent || (bridge?.threadId ? !blocked : false);
    const extra = {
      reply_markup: { inline_keyboard: rows },
      ...(bridge?.threadId ? { message_thread_id: bridge.threadId } : {}),
      ...(disableNotification ? { disable_notification: true } : {}),
    };
    const sent = await this.telegram.send(this.chatId, text, extra);
    if (sent?.message_id) {
      this.herdrMessages.set(sent.message_id, paneId);
      if (this.herdrMessages.size > 200) this.herdrMessages.delete(this.herdrMessages.keys().next().value);
    }
  }

  async showHerdrAgents() {
    if (!this.herdrWatcher) return this.telegram.send(this.chatId, "Herdr is not available; ensure its server is running.");
    await this.herdrWatcher.sync();
    const ownPanes = new Set(this.getOwnedPaneIds());
    const agents = [...this.herdrWatcher.agents.values()];
    if (!agents.length) return this.telegram.send(this.chatId, "No agents running in Herdr.");
    const byWorkspace = new Map();
    for (const agent of agents) {
      const ws = this.herdrWatcher.workspaces.get(agent.workspace_id) || agent.workspace_id;
      if (!byWorkspace.has(ws)) byWorkspace.set(ws, []);
      byWorkspace.get(ws).push(agent);
    }
    const lines = [];
    for (const [ws, list] of byWorkspace) {
      lines.push(`**${ws}**`);
      for (const agent of list) {
        const isOwn = ownPanes.has(agent.pane_id);
        const badge = isOwn ? " 📱" : (herdrOptedIn(agent) ? " 📡" : "");
        const title = agent.terminal_title_stripped ? ` — ${agent.terminal_title_stripped.replace(/[`*_\[\]]/g, "")}` : "";
        lines.push(`${HERDR_STATUS_ICON[agent.agent_status] || "❔"} ${agent.name || agent.agent} \`${agent.pane_id}\` ${agent.agent_status}${badge}${title}`);
      }
      lines.push("");
    }
    lines.push("📱 = Telegram session. 📡 = pushed to Telegram. Tap an agent to see its screen.");
    return this.telegram.send(this.chatId, lines.join("\n"), this.keyboard(agents.map((agent) => ({
      label: `${HERDR_STATUS_ICON[agent.agent_status] || "❔"} ${agent.name || agent.agent} · ${this.herdrWatcher.workspaces.get(agent.workspace_id) || agent.pane_id}`,
      action: { type: "herdr_peek", paneId: agent.pane_id },
    })))); }
  async replyToHerdrAgent(paneId, message) {
    this.telegram.setReaction(this.chatId, message.message_id, "👀");
    const target = [...this.sessions.values()].find((s) => s.binding.paneId === paneId && s.pi.proc);
    if (!target) return this.telegram.send(this.chatId, "Enable /remote-control in that Pi pane first. Prompts are never sent with terminal keystrokes.");
    return target.prompt(message.text.trim()); }
  keyboard(items) {
    return { reply_markup: { inline_keyboard: items.map(({ label, action }) => [{ text: label.slice(0, 60), callback_data: this.action(action) }]) } }; }
  async handleCallback(callback, session = this.mainSession) {
    const token = callback.data?.startsWith("a:") ? callback.data.slice(2) : "";
    const action = this.actions.get(token);
    this.actions.delete(token);
    // ref: Telegram Bot API answerCallbackQuery — 收到即应答，客户端转圈等待且过晚会 "query is too old"；每个 callback 只 answer 一次
    if (!action || action.expires < Date.now()) return this.telegram.answer(callback.id, "Expired");
    this.telegram.answer(callback.id).catch(() => {});
    try {
      console.log(`${new Date().toISOString()} [callback] handling ${action.type}`);
      if (action.type === "herdr_peek") {
        const agent = (await this.herdrWatcher.cliJson(["agent", "get", action.paneId]))?.agent;
        if (!agent) return this.telegram.send(this.chatId, "Agent is gone");
        await this.sendHerdrAgent(action.paneId, agent.agent_status, agent);
      } else if (action.type === "herdr_keys") {
        for (const [k, v] of this.actions) {
          if (v.group === action.group) this.actions.delete(k);
        }
        const removeButtons = () => callback.message && this.telegram.call("editMessageReplyMarkup", {
          chat_id: callback.message.chat.id, message_id: callback.message.message_id, reply_markup: { inline_keyboard: [] },
        }).catch(() => {});
        const agent = (await this.herdrWatcher.cliJson(["agent", "get", action.paneId]))?.agent;
        if (agent?.agent_status !== "blocked") {
          await removeButtons();
          await this.telegram.send(this.chatId, `⚠️ ${this.herdrWatcher.label(action.paneId)} is no longer waiting (${agent?.agent_status || "gone"}); nothing sent.`);
          return;
        }
        await this.herdrWatcher.cli(["agent", "send-keys", action.paneId, ...action.keys]);
        await removeButtons();
        await sleep(1500);
        const after = (await this.herdrWatcher.cliJson(["agent", "get", action.paneId]).catch(() => null))?.agent?.agent_status || "unknown";
        await this.telegram.send(this.chatId, `➡️ ${action.label} → ${this.herdrWatcher.label(action.paneId)} · now ${HERDR_STATUS_ICON[after] || ""} ${after}`, { disable_notification: true });
      } else if (action.type === "close_topic") {
        if (action.confirmed) {
          const threadId = action.threadId;
          const sessionKey = `t:${threadId}`;
          const targetSession = this.sessions.get(sessionKey);
          if (targetSession) {
            await this.closePaneSession(targetSession);
            this.sessions.delete(sessionKey);
          }
          delete this.state.topics[threadId];
          if (this.state.herdrPanes) {
            delete this.state.herdrPanes[sessionKey];
          }
          await this.saveState({ topics: this.state.topics, herdrPanes: this.state.herdrPanes });
          await this.telegram.call("deleteForumTopic", {
            chat_id: this.chatId,
            message_thread_id: threadId,
          }).catch(() => {});
          if (callback.message) {
            await this.telegram.edit(callback.message.chat.id, callback.message.message_id, "Topic closed.").catch(() => {});
          }
          return;
        } else {
          if (callback.message) {
            await this.telegram.edit(callback.message.chat.id, callback.message.message_id, "Close cancelled.").catch(() => {});
          }
          return;
        }
      } else {
        const sessionKey = action.sessionKey || sessionKeyOf(callback);
        const targetSession = sessionKey ? (this.sessions.get(sessionKey) || this.mainSession) : (session || this.mainSession);
        await targetSession.handleCallbackAction(action, callback);
      }
    } catch (error) {
      const targetSession = this.sessions.get(action?.sessionKey) || session || this.mainSession;
      await targetSession.send(`❌ ${error.message}`);
    }
  }

  // ref: Telegram Bot API 9.3 & 9.4 (2026-02-09): createForumTopic in private chats
  async handleTopicCommand(session, argument) {
    const me = await this.telegram.call("getMe");
    if (!me?.has_topics_enabled) {
      return session.send("Topics are not enabled for this bot. Enable Threaded Mode in the @BotFather Mini App:\nopen @BotFather → tap Open → select your bot → Bot Settings → Threads Settings → Threaded Mode.");
    }
    const target = argument ? resolvePath(argument.trim(), session.cwd) : session.cwd;
    let realTarget, targetStat;
    try {
      realTarget = await realpath(target);
      targetStat = await stat(realTarget);
    } catch {
      return session.send(`Directory missing or inaccessible: ${target}`);
    }
    if (!targetStat.isDirectory()) {
      return session.send(`Not a valid directory: ${target}`);
    }
    const name = (basename(realTarget) || "topic").slice(0, 128);
    const created = await this.telegram.call("createForumTopic", {
      chat_id: this.chatId,
      name,
    });
    const threadId = created.message_thread_id;
    const newSession = new ChatSession(this, { threadId, cwd: realTarget });
    newSession.lastTopicName = name;
    this.sessions.set(`t:${threadId}`, newSession);
    this.state.topics[threadId] = { cwd: realTarget };
    await this.saveState({ topics: this.state.topics });

    await newSession.pi.start();
    const state = await newSession.pi.request("get_state");
    const text = formatSessionReset({ model: state.model, cwd: realTarget });
    await newSession.send(text);
    if (session.threadId !== threadId) {
      await session.send(`✅ Created topic "${name}" (thread #${threadId})`);
    }
  }

  // ref: Telegram Bot API 9.3 deleteForumTopic in private chats
  async handleCloseCommand(session) {
    if (session.threadId === null) {
      return session.send("/close only works inside a topic.");
    }
    const keyboard = {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "Confirm", callback_data: this.action({ type: "close_topic", threadId: session.threadId, confirmed: true }) },
            { text: "Cancel", callback_data: this.action({ type: "close_topic", threadId: session.threadId, confirmed: false }) },
          ],
        ],
      },
    };
    return session.send(`Close topic "${basename(session.cwd)}"? ${session.binding.owned ? "This will quit its Pi and close its pane." : "This only detaches Telegram; your desktop Pi keeps running."} The topic will be removed.`, keyboard); }
  async acquireLock() {
    const sockPath = join(this.config.stateDir, "gateway.sock");
    const pidFile = join(this.config.stateDir, "gateway.pid");
    await new Promise((resolveLock, reject) => {
      const client = net.connect({ path: sockPath }, () => {
        client.end();
        const pid = existsSync(pidFile) ? readFileSync(pidFile, "utf8").trim() : "";
        reject(new Error(`Another gateway is already running${pid ? ` (pid ${pid})` : ""}. Run ./install.sh stop first`));
      });
      client.on("error", (err) => {
        if (["ECONNREFUSED", "ENOENT", "ENOTSOCK"].includes(err.code)) {
          try { unlinkSync(sockPath); } catch {}
          const server = net.createServer();
          server.unref();
          server.listen(sockPath, () => {
            this.lockServer = server;
            this.sockPath = sockPath;
            writeFileSync(pidFile, String(process.pid), { mode: 0o600 });
            this.pidFile = pidFile;
            resolveLock();
          });
          server.on("error", reject);
        } else {
          reject(err);
        }
      });
    }); }
  stop() {
    if (this.downloadCleanupTimer) {
      clearInterval(this.downloadCleanupTimer);
      this.downloadCleanupTimer = null;
    }
    this.telegram?.stopPolling?.();
    this.herdrWatcher?.stop();
    this.bridge?.stop().catch((error) => console.error(`[bridge] stop: ${error.message}`));
    if (this.lockServer) {
      try { this.lockServer.close(); } catch {}
      this.lockServer = null;
    }
    try {
      if (this.sockPath && existsSync(this.sockPath)) unlinkSync(this.sockPath);
    } catch {}
    try {
      if (this.pidFile && existsSync(this.pidFile) && readFileSync(this.pidFile, "utf8").trim() === String(process.pid)) {
        unlinkSync(this.pidFile);
      }
    } catch {}
    if (this.sessions) {
      for (const session of this.sessions.values()) {
        session.stop();
      }
    } else {
      this.pi?.stop?.();
    }
  }
}

async function main() {
  if (process.argv.includes("--self-test")) {
    const { selfTest } = await import("./self-test.mjs");
    await selfTest();
  } else {
    const gateway = new Gateway(loadConfig());
    for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { gateway.stop(); process.exit(0); });
    gateway.start().catch((error) => { console.error(error); gateway.stop(); process.exit(1); });
  }
}

if (import.meta.main) {
  main().catch((error) => { console.error(error); process.exit(1); });
}

export {
  BOT_COMMANDS, RESERVED_COMMANDS, HELP, MAX_MESSAGE,
  ChatSession, Gateway, HerdrWatcher, PaneRpc, Telegram,
  attachmentPrompt, buildDevPath, chunks, encodeCwdSessionDir,
  expandableBlockquote, extensionFromMime, extractText,
  formatAssistantError, formatContextTokens, formatSessionReset,
  herdrOptedIn, herdrTail, isConnectPhaseError, loadConfig, loadState,
  paneHasForegroundShell, parseCommand, pollBackoffMs, previewText,
  renderToolPanel, resolveAgentSessionFile, resolveHerdrEnvironment,
  resolvePath, retryableTelegramStatus, runCommand, runStt,
  scanDesktopSessions, sessionKeyOf, setTestMode, shellQuote,
  shouldRetryTelegram, telegramCommandName, telegramHtml, toolSummary,
};
