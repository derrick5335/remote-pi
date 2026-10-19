#!/usr/bin/env node

import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, openAsBlob, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdir, open, readFile, readdir, realpath, rename, stat, truncate, writeFile } from "node:fs/promises";
import net from "node:net";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import MarkdownIt from "markdown-it";

const MAX_MESSAGE = 4000;
const MAX_LOG_SIZE = 5 * 1024 * 1024;
const HELP = `Remote Pi

Just send text to chat with Pi; messages sent while it is working act as steering.

/help               Show this help
/commands           Extension, prompt & skill commands
/cwd [path]         Switch workspace; no argument shows recent projects
/sh <command>       Run a shell command directly
/get <path>         Download a file from the workspace
/model [query|provider/model]
/thinking [level]
/resume             Pick a past session
/new                New session
/name <name>        Name the session
/session            Current model, session, tokens & cost
/agents             Status of all Herdr agents (📡 = pushed here)
/fork               Branch from a past user message
/clone              Clone the current branch
/compact [focus]    Compact the context
/export             Export as HTML
/abort              Stop current task (queue kept)
/abort clear        Stop and clear the queue
/restart            Restart the gateway
/upgrade            Upgrade gateway to latest (git pull + self-test + restart)
/queue [clear]      View or clear the message queue
/followup <text>    Queue a follow-up prompt`;

const BOT_COMMANDS = [
  ["help", "Help"], ["commands", "Extension, prompt & skill commands"],
  ["cwd", "Switch workspace or show history"], ["sh", "Run a shell command"], ["get", "Download a file"],
  ["model", "View or switch model"], ["thinking", "View or set thinking level"],
  ["resume", "Resume a past session"], ["new", "New session"], ["name", "Set session name"],
  ["session", "Session & cost"], ["agents", "Herdr agent status"],
  ["fork", "Branch from history"], ["clone", "Clone current branch"],
  ["compact", "Compact context"], ["export", "Export session"], ["abort", "Stop task (queue kept)"],
  ["restart", "Restart gateway"],
  ["upgrade", "Upgrade gateway to latest"],
  ["queue", "View or clear queue"],
  ["followup", "Queue a follow-up"],
].map(([command, description]) => ({ command, description }));

function parseCommand(text) {
  const match = text.match(/^\/([\w:-]+)(?:@\w+)?(?:\s+([\s\S]*))?$/);
  return match ? { name: match[1].toLowerCase(), argument: match[2]?.trim() ?? "" } : null;
}

function getUpdatePriority(update) {
  if (update?.stopped_message_generation) return "p0";
  const text = update?.message?.text?.trim();
  if (!text) return "p2";
  const cmd = parseCommand(text);
  if (!cmd) return "p2";
  if (["abort", "restart", "new", "reset"].includes(cmd.name)) return "p0";
  if (["status", "session", "queue", "help", "start", "commands"].includes(cmd.name)) return "p1";
  return "p2";
}

function buildDevPath(basePath = process.env.PATH) {
  const home = homedir();
  const extra = [
    join(home, ".local", "bin"),
    join(home, ".bun", "bin"),
    join(home, ".cargo", "bin"),
    join(home, ".opencode", "bin"),
    join(home, ".antigravity", "antigravity", "bin"),
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    dirname(process.execPath),
  ];
  const existing = (basePath || "/usr/bin:/bin:/usr/sbin:/sbin").split(":");
  return [...new Set([...extra, ...existing].filter(Boolean))].join(":");
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

const NON_IDEMPOTENT_METHODS = new Set([
  "sendMessage",
  "sendDocument",
  "sendPhoto",
  "sendMediaGroup",
  "copyMessage",
  "forwardMessage",
]);

const CONNECT_PHASE_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
]);

function isConnectPhaseError(error) {
  const code = error?.cause?.code || error?.code;
  return Boolean(code && CONNECT_PHASE_CODES.has(code));
}

// ref: Telegram Bot API — Making requests (https://core.telegram.org/bots/api#making-requests)
function shouldRetryTelegram(method, { status, error } = {}) {
  const isNonIdempotent = NON_IDEMPOTENT_METHODS.has(method);
  if (typeof status === "number") {
    return isNonIdempotent ? status === 429 : retryableTelegramStatus(status);
  }
  if (error !== undefined && error !== null) {
    return isNonIdempotent ? isConnectPhaseError(error) : true;
  }
  return false;
}

function telegramCommandName(command) {
  const name = command.source === "skill" ? `skill_${command.name.slice("skill:".length)}` : command.name;
  return name.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 32);
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
  listStack = [];
  return out.replace(/\n{3,}/g, "\n\n").trim();
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

function loadState(stateDir) {
  const statePath = join(stateDir, "state.json");
  if (!existsSync(statePath)) return { cwd: null, recentProjects: [] };
  try {
    const raw = JSON.parse(readFileSync(statePath, "utf8"));
    return {
      cwd: typeof raw.cwd === "string" ? raw.cwd : null,
      recentProjects: Array.isArray(raw.recentProjects)
        ? raw.recentProjects.filter((p) => typeof p === "string" && existsSync(p))
        : [],
    };
  } catch {
    return { cwd: null, recentProjects: [] };
  }
}

function resolveSessionDir(stateDir, cwd) {
  const legacy = join(stateDir, "sessions", cwd.replace(/^\//, "").replaceAll("/", "-"));
  if (existsSync(legacy)) {
    return legacy;
  }
  const hash = createHash("sha256").update(cwd).digest("hex").slice(0, 8);
  const safeSlug = cwd.replace(/^[/\\]+/, "").replace(/[^a-zA-Z0-9_-]/g, "-");
  return join(stateDir, "sessions", `${safeSlug}_${hash}`);
}

function resolvePiBin(configured) {
  if (configured) return configured;
  if (process.env.PI_BIN) return process.env.PI_BIN;
  const candidates = [
    "/opt/homebrew/bin/pi",
    "/usr/local/bin/pi",
    join(homedir(), ".npm-global", "bin", "pi"),
    join(homedir(), ".local", "bin", "pi"),
  ];
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch {}
  }
  return "pi";
}

function loadConfig() {
  const path = process.env.REMOTE_PI_CONFIG || join(homedir(), ".config", "remote-pi", "config.json");
  const configDir = dirname(path);
  let file = {};
  if (existsSync(path)) {
    try {
      file = JSON.parse(readFileSync(path, "utf8"));
    } catch (err) {
      throw new Error(`Failed to parse config file ${path}: ${err.message}`);
    }
  }

  let rawExtensions = [];
  if (process.env.REMOTE_PI_EXTENSIONS !== undefined) {
    const envExt = process.env.REMOTE_PI_EXTENSIONS.trim();
    if (envExt.startsWith("[")) {
      try {
        rawExtensions = JSON.parse(envExt);
      } catch (err) {
        throw new Error(`Invalid JSON in REMOTE_PI_EXTENSIONS: ${err.message}`);
      }
    } else if (envExt) {
      rawExtensions = envExt.split(",").map((s) => s.trim()).filter(Boolean);
    }
  } else if (file.extensions !== undefined) {
    if (!Array.isArray(file.extensions)) {
      throw new Error(`Invalid extensions configuration in ${path}: expected an array of strings`);
    }
    rawExtensions = file.extensions;
  }

  const extensions = [];
  for (const item of rawExtensions) {
    if (typeof item !== "string" || !item.trim()) {
      throw new Error("Invalid extension path in configuration: expected non-empty string");
    }
    const resolvedExt = resolvePath(item.trim(), configDir);
    if (!existsSync(resolvedExt)) {
      throw new Error(`Configured extension not found: ${item} (resolved to ${resolvedExt})`);
    }
    if (!extensions.includes(resolvedExt)) {
      extensions.push(resolvedExt);
    }
  }

  const enableCompanionExtension = process.env.REMOTE_PI_COMPANION_EXTENSION !== undefined
    ? process.env.REMOTE_PI_COMPANION_EXTENSION !== "false" && process.env.REMOTE_PI_COMPANION_EXTENSION !== "0"
    : file.enableCompanionExtension !== false;

  const herdr = process.env.REMOTE_PI_HERDR !== undefined
    ? process.env.REMOTE_PI_HERDR !== "false" && process.env.REMOTE_PI_HERDR !== "0"
    : file.herdr !== false;

  const stateDir = resolvePath(file.stateDir || join(homedir(), ".local", "var", "remote-pi"), configDir);
  const savedState = loadState(stateDir);

  let targetCwd = process.env.PI_CWD
    ? resolvePath(process.env.PI_CWD, configDir)
    : savedState.cwd || (file.cwd ? resolvePath(file.cwd, configDir) : null);
  if (!targetCwd) throw new Error(`"cwd" is required: set "cwd" in ${path} or export PI_CWD`);

  const telegram = typeof file.telegram === "object" && file.telegram !== null ? file.telegram : {};
  const config = {
    botToken: process.env.TELEGRAM_BOT_TOKEN || telegram.botToken,
    allowedUserId: String(process.env.TELEGRAM_ALLOWED_USER_ID || telegram.allowedUserId || ""),
    cwd: targetCwd,
    configPath: path,
    piBin: resolvePiBin(process.env.PI_BIN || file.piBin),
    stateDir,
    logFile: resolvePath(process.env.REMOTE_PI_LOG_FILE || file.logFile || join(homedir(), ".local", "var", "log", "remote-pi.log"), configDir),
    approve: file.approve !== false,
    enableCompanionExtension,
    herdr,
    extensions,
    sttCommand: file.sttCommand || "",
    ackEmoji: process.env.TELEGRAM_ACK_EMOJI || telegram.ackEmoji || "\u{1F440}",
    doneEmoji: process.env.TELEGRAM_DONE_EMOJI || telegram.doneEmoji || "\u{1FAE1}",
  };
  config.sessionDir = resolveSessionDir(config.stateDir, config.cwd);
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
    this.wakeTimer = null;
    this.wakePromise = null;
    this.currentPollAc = null;
    this.pollSleepAc = null;
    this.polling = false;
    this.pollFailures = 0;
    this.outageStart = 0;
    this.inConflict = false;
  }

  async call(method, body = {}, timeout = 35_000, maxAttempts = 3, signal = null, quiet = false) {
    let lastError;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      let response;
      let data;
      const t0 = performance.now();
      try {
        const reqSignal = signal ? AbortSignal.any([AbortSignal.timeout(timeout), signal]) : AbortSignal.timeout(timeout);
        response = await fetch(`${this.base}/${method}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: reqSignal,
        });
        data = await response.json();
      } catch (error) {
        if (signal?.aborted) throw error; // 外部主动 abort（如唤醒重置），不再内部重试死等
        const ms = Math.round(performance.now() - t0);
        if (!quiet) console.error(`${new Date().toISOString()} [tg:call] ${method} attempt ${attempt + 1}/${maxAttempts} failed in ${ms}ms:`, error.message);
        lastError = error;
        const retryable = shouldRetryTelegram(method, { error });
        if (!retryable || attempt === maxAttempts - 1) throw error;
        await sleep((attempt + 1) * 1000);
        continue;
      }
      const ms = Math.round(performance.now() - t0);
      if (response.ok && data.ok) {
        const shouldLog = method === "getUpdates"
          ? (Array.isArray(data.result) && data.result.length > 0)
          : true;
        if (shouldLog) {
          console.log(`${new Date().toISOString()} [tg:call] ${method} ok in ${ms}ms${method === "getUpdates" ? ` (updates: ${data.result.length})` : ""}`);
        }
        return data.result;
      }
      if (response.status === 429) {
        const retrySec = data?.parameters?.retry_after || attempt + 1;
        this.retryNotBefore = Math.max(this.retryNotBefore, Date.now() + retrySec * 1000);
      }
      lastError = new Error(`Telegram ${method}: ${data.description || response.status}`);
      if (!quiet) console.error(`${new Date().toISOString()} [tg:call] ${method} HTTP ${response.status} in ${ms}ms: ${data.description || ""}`);
      const retryable = shouldRetryTelegram(method, { status: response.status });
      if (!retryable || attempt === maxAttempts - 1) throw lastError;
      await sleep((data.parameters?.retry_after || attempt + 1) * 1000);
    }
    throw lastError;
  }

  async sendOne(chatId, text, extra = {}) {
    const plain = String(text || "(empty)");
    try {
      return await this.call("sendMessage", { chat_id: chatId, text: telegramHtml(plain), parse_mode: "HTML", ...extra });
    } catch (error) {
      const msg = String(error.message || "");
      // ref: Telegram Bot API sendMessage parse error & length limits (https://core.telegram.org/bots/api#sendmessage)
      if (!msg.includes("can't parse entities") && !msg.includes("message is too long")) throw error;
      console.error("HTML parse/length fallback:", error.message);
      if (plain.length > 4000) {
        const slices = [];
        for (let i = 0; i < plain.length; i += 4000) slices.push(plain.slice(i, i + 4000));
        let lastMsg;
        for (let i = 0; i < slices.length; i++) {
          lastMsg = await this.call("sendMessage", { chat_id: chatId, text: slices[i], ...(i === slices.length - 1 ? extra : {}) });
        }
        return lastMsg;
      }
      return this.call("sendMessage", { chat_id: chatId, text: plain, ...extra });
    }
  }

  async send(chatId, text, extra = {}) {
    let last;
    const parts = chunks(text);
    for (let i = 0; i < parts.length; i++) last = await this.sendOne(chatId, parts[i], i === parts.length - 1 ? extra : {});
    return last;
  }

  async edit(chatId, messageId, text, ephemeral = false) {
    const plain = String(text || "(empty)");
    const timeout = ephemeral ? 10_000 : 35_000;
    const maxAttempts = ephemeral ? 1 : 3;
    try {
      return await this.call("editMessageText", { chat_id: chatId, message_id: messageId, text: telegramHtml(plain), parse_mode: "HTML" }, timeout, maxAttempts);
    } catch (error) {
      const msg = String(error.message || "");
      if (msg.includes("can't parse entities") || msg.includes("message is too long")) {
        console.error("HTML parse/length fallback:", error.message);
        return this.call("editMessageText", { chat_id: chatId, message_id: messageId, text: plain.slice(0, 4000) }, timeout, maxAttempts);
      }
      if (!error.message.includes("message is not modified")) throw error;
    }
  }

  answer(callbackQueryId, text = "") {
    return this.call("answerCallbackQuery", { callback_query_id: callbackQueryId, text }).catch(console.error);
  }

  async sendChatAction(chatId, action = "typing") {
    try {
      await fetch(`${this.base}/sendChatAction`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, action }),
        signal: AbortSignal.timeout(4_000),
      });
    } catch {
      // Best-effort UI hint
    }
  }

  async sendDocument(chatId, path) {
    const t0 = performance.now();
    const form = new FormData();
    form.set("chat_id", String(chatId));
    form.set("document", await openAsBlob(path), basename(path));
    const response = await fetch(`${this.base}/sendDocument`, { method: "POST", body: form, signal: AbortSignal.timeout(60_000) });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(`Telegram sendDocument: ${data.description || response.status}`);
    console.log(`${new Date().toISOString()} [tg:call] sendDocument ok in ${Math.round(performance.now() - t0)}ms`);
  }

  async sendDraft(chatId, draftId, text) {
    const plain = String(text || "");
    try {
      return await this.call("sendMessageDraft", { chat_id: chatId, draft_id: draftId, text: telegramHtml(plain), parse_mode: "HTML", can_stop: true }, 10_000, 2);
    } catch (error) {
      if (!error.message.includes("can't parse entities")) throw error;
      console.error("Draft HTML parse fallback:", error.message);
      return this.call("sendMessageDraft", { chat_id: chatId, draft_id: draftId, text: plain, can_stop: true }, 10_000, 2);
    }
  }

  async deleteMessage(chatId, messageId) {
    await this.call("deleteMessage", { chat_id: chatId, message_id: messageId }, 10_000, 1);
  }

  async setReaction(chatId, messageId, emoji) {
    if (!messageId) return null;
    // ponytail: 单 emoji——Bot 对每条消息多 emoji 会稳定 400 REACTIONS_TOO_MANY
    const reaction = emoji ? [{ type: "emoji", emoji: String(emoji) }] : [];
    try {
      return await this.call("setMessageReaction", { chat_id: chatId, message_id: messageId, reaction }, 5000, 1);
    } catch {
      return null;
    }
  }

  // ref: Alex MacCaw heartbeat drift technique for OS sleep/wake detection (http://blog.alexmaccaw.com/javascript-wake-event)
  startWakeMonitor() {
    if (this.wakeTimer) return;
    let lastTick = Date.now();
    this.wakeTimer = setInterval(() => {
      const now = Date.now();
      const elapsed = now - lastTick;
      lastTick = now;
      // 正常每 1000ms 一跳；若间隔超过 3500ms 说明系统经历合盖休眠与唤醒
      if (elapsed > 3500) {
        this.handleWake(Math.round(elapsed / 1000));
      }
    }, 1000);
    this.wakeTimer.unref?.();
  }

  pollSleep(ms, signal) {
    return sleep(ms, undefined, { signal });
  }

  stopPolling() {
    this.polling = false;
    if (this.currentPollAc) {
      try { this.currentPollAc.abort("stop"); } catch {}
      this.currentPollAc = null;
    }
    if (this.pollSleepAc) {
      try { this.pollSleepAc.abort("stop"); } catch {}
      this.pollSleepAc = null;
    }
  }

  stopWakeMonitor() {
    if (this.wakeTimer) {
      clearInterval(this.wakeTimer);
      this.wakeTimer = null;
    }
  }

  handleWake(sleepSec = 0) {
    this.pollFailures = 0;
    this.outageStart = 0;
    this.inConflict = false;
    if (this.currentPollAc) {
      try { this.currentPollAc.abort("system_wake"); } catch {}
      this.currentPollAc = null;
    }
    if (this.pollSleepAc) {
      try { this.pollSleepAc.abort("system_wake"); } catch {}
      this.pollSleepAc = null;
    }
    if (this.wakePromise) return this.wakePromise;
    console.log(`${new Date().toISOString()} [tg:wake] System wake detected (slept ~${sleepSec}s). Aborting stale poll...`);
    this.wakePromise = (async () => {
      const t0 = performance.now();
      let online = false;
      // 快速探测网络连通性（短超时 2s，最多探测 8 次，每次间隔 500ms）
      for (let probe = 0; probe < 8; probe++) {
        try {
          const res = await fetch(`${this.base}/getMe`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            signal: AbortSignal.timeout(2000),
          });
          const data = await res.json().catch(() => null);
          if (res.ok && data?.ok) {
            online = true;
            break;
          }
        } catch {
          await sleep(500);
        }
      }
      const probeMs = Math.round(performance.now() - t0);
      console.log(`${new Date().toISOString()} [tg:wake] Network probe ${online ? "succeeded" : "timeout"} in ${probeMs}ms. Resuming instant poll.`);
    })().finally(() => {
      this.wakePromise = null;
    });
    return this.wakePromise;
  }

  async poll(handler) {
    let offset = Number(await readFile(this.offsetPath, "utf8").catch(() => "0")) || 0;
    // at-least-once：普通消息处理完才落盘 offset，崩溃后由 Telegram 重投（重复优于丢失）；p0/p1 只推进内存 offset
    let persistChain = Promise.resolve();
    this.startWakeMonitor();
    this.polling = true;
    while (this.polling) {
      if (this.wakePromise) await this.wakePromise;
      if (!this.polling) break;
      try {
        this.currentPollAc = new AbortController();
        const updates = await this.call("getUpdates", {
          offset, timeout: 50, allowed_updates: ["message", "callback_query", "stopped_message_generation"],
        }, 60_000, 1, this.currentPollAc.signal, true);
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
            persistChain = persistChain
              .then(() => done)
              .then(async () => {
                const tmp = `${this.offsetPath}.tmp`;
                await writeFile(tmp, String(mark), { mode: 0o600 });
                await rename(tmp, this.offsetPath);
              })
              .catch((error) => console.error(`${new Date().toISOString()} [tg:poll] offset persist:`, error.message));
          }
        }
      } catch (error) {
        this.currentPollAc = null;
        if (!this.polling) break;
        if (this.wakePromise) {
          await this.wakePromise;
          continue;
        }
        if (error.message?.includes("Conflict")) {
          if (!this.inConflict) {
            this.inConflict = true;
            console.error(`${new Date().toISOString()} [tg:poll] conflict: ${error.message}`);
          }
          try {
            this.pollSleepAc = new AbortController();
            await this.pollSleep(15_000, this.pollSleepAc.signal);
          } catch {} finally {
            this.pollSleepAc = null;
          }
          continue;
        }
        this.inConflict = false;
        this.pollFailures++;
        if (this.pollFailures === 1) {
          this.outageStart = Date.now();
          console.error(`${new Date().toISOString()} [tg:poll] offline: ${error.message}; retrying with backoff`);
        }
        const backoffMs = pollBackoffMs(this.pollFailures);
        try {
          this.pollSleepAc = new AbortController();
          await this.pollSleep(backoffMs, this.pollSleepAc.signal);
        } catch {} finally {
          this.pollSleepAc = null;
        }
      }
    }
  }
}

function runCommand(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    const cp = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...options });
    let stdout = "";
    let stderr = "";
    cp.stdout?.on("data", (d) => { stdout += d; });
    cp.stderr?.on("data", (d) => { stderr += d; });
    const timer = options.timeout ? setTimeout(() => {
      cp.kill("SIGKILL");
      reject(new Error(`Command timed out: ${cmd} ${args.join(" ")}`));
    }, options.timeout) : null;
    cp.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    cp.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`Command failed (${code}): ${stderr.trim() || stdout.trim()}`));
    });
  });
}

// ref: Herdr Official Docs - CLI Reference & Integrations (https://herdr.dev/docs/cli-reference/ & https://herdr.dev/docs/integrations/)
async function resolveHerdrEnvironment(cwd, { piBin, disabled } = {}) {
  if (disabled || piBin === "echo" || process.env.NODE_ENV === "test") return {};

  let herdrBin;
  try {
    herdrBin = (await runCommand("which", ["herdr"], { timeout: 2000 })).trim();
  } catch {
    const fallback = join(homedir(), ".local", "bin", "herdr");
    if (existsSync(fallback)) herdrBin = fallback;
    else return {};
  }

  // 1. 检查 Herdr Server 是否运行；若未运行，启动 headless server（有则进，无则建）
  let status = null;
  try {
    const raw = await runCommand(herdrBin, ["status", "server", "--json"], { timeout: 3000 });
    const parsed = JSON.parse(raw);
    if (parsed.running) status = parsed;
  } catch {
    status = null;
  }

  if (!status) {
    try {
      const serverProc = spawn(herdrBin, ["server"], { detached: true, stdio: "ignore" });
      serverProc.unref();
      const start = Date.now();
      while (Date.now() - start < 3000) {
        await sleep(100);
        try {
          const raw = await runCommand(herdrBin, ["status", "server", "--json"], { timeout: 1000 });
          const parsed = JSON.parse(raw);
          if (parsed.running) {
            status = parsed;
            break;
          }
        } catch {}
      }
    } catch (err) {
      console.warn(`${new Date().toISOString()} [herdr] failed to start herdr server: ${err.message}`);
      return {};
    }
  }

  if (!status?.socket) return {};
  const socketPath = status.socket;

  // 2. 查找或创建对应 cwd 的 Workspace 与 Pane
  let workspaceId;
  let tabId;
  let paneId;
  try {
    const panesRaw = await runCommand(herdrBin, ["pane", "list"], { timeout: 3000 });
    const panesData = JSON.parse(panesRaw);
    const existingPane = panesData.result?.panes?.find((p) => p.cwd === cwd);
    if (existingPane) {
      workspaceId = existingPane.workspace_id;
      tabId = existingPane.tab_id;
      paneId = existingPane.pane_id;
    }
  } catch {}

  if (!paneId) {
    try {
      const label = basename(cwd) || "remote-pi";
      const createdRaw = await runCommand(herdrBin, ["workspace", "create", "--cwd", cwd, "--label", label, "--no-focus"], { timeout: 5000 });
      const created = JSON.parse(createdRaw);
      workspaceId = created.result?.workspace?.workspace_id;
      tabId = created.result?.tab?.tab_id;
      paneId = created.result?.root_pane?.pane_id;
    } catch (err) {
      console.warn(`${new Date().toISOString()} [herdr] failed to create workspace for ${cwd}: ${err.message}`);
    }
  }

  if (!paneId) return {};

  return {
    HERDR_ENV: "1",
    HERDR_SOCKET_PATH: socketPath,
    HERDR_BIN_PATH: herdrBin,
    HERDR_WORKSPACE_ID: workspaceId,
    HERDR_TAB_ID: tabId,
    HERDR_PANE_ID: paneId,
  };
}

const HERDR_STATUS_ICON = { working: "⏳", blocked: "✋", done: "✅", idle: "💤", unknown: "❔" };

// 审批/提问 UI 的编号选项（Claude Code「❯ 1. Yes」、Codex「› 1. Yes, proceed」等）；只取屏幕上最后一组连续编号
function herdrChoices(screen) {
  const choices = [];
  for (const line of String(screen || "").split("\n").slice(-30)) {
    const match = line.match(/^[\s│┃|]*(?:[❯›>▶➜]\s*)?(\d)[.)]\s+(\S.*?)\s*[│┃|]?\s*$/);
    if (!match) continue;
    if (match[1] === "1") choices.length = 0;
    if (choices.length && Number(match[1]) !== Number(choices.at(-1).key) + 1) continue;
    choices.push({ key: match[1], label: match[2].slice(0, 40) });
  }
  return choices.length >= 2 ? choices : [];
}

// /remote-pi（herdr-remote-extension.ts）通过 herdr 原生 pane metadata token 标记订阅
const HERDR_OPT_IN_TOKEN = "remote_pi";

function herdrOptedIn(agent) {
  return agent?.agent === "pi" && agent?.tokens?.[HERDR_OPT_IN_TOKEN] === "on";
}

function herdrTail(screen, maxLines = 30, maxChars = 2500) {
  const lines = String(screen || "").replace(/\s+$/, "").split("\n");
  return lines.slice(-maxLines).join("\n").slice(-maxChars).trim();
}

// ref: Herdr socket API events.subscribe（`herdr api schema --json`；订阅后连接变为单向事件流，订阅集合变化需重连）
// 推送负责实时性，每分钟 agent list 全量对账兜底（漏事件、herdr 重启、合盖睡眠）
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
    this.stopped = false;
  }

  async cli(args, timeout = 5000) {
    return runCommand(this.bin, args, { timeout });
  }

  async cliJson(args, timeout = 5000) {
    return JSON.parse(await this.cli(args, timeout)).result;
  }

  start() {
    this.stopped = false;
    this.sync();
    this.reconcileTimer = setInterval(() => this.sync(), 60_000);
    this.reconcileTimer.unref?.();
  }

  stop() {
    this.stopped = true;
    clearInterval(this.reconcileTimer);
    clearTimeout(this.syncTimer);
    const socket = this.socket;
    this.socket = null;
    socket?.destroy();
  }

  scheduleSync(delay) {
    clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => this.sync(), delay);
    this.syncTimer.unref?.();
  }

  sync() {
    this.syncChain = this.syncChain.then(() => this.doSync()).catch((error) => {
      console.warn(`${new Date().toISOString()} [herdr] sync failed: ${error.message}`);
      if (!this.stopped) this.scheduleSync(15_000);
    });
    return this.syncChain;
  }

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

  // 首次见到某 pane 只记录不通知；聚焦 pane 完成后直接是 idle 而非 done，因此 working→idle 也算完成
  observe(paneId, status) {
    const prev = this.statuses.get(paneId);
    this.statuses.set(paneId, status);
    if (prev === undefined || prev === status || this.isExcluded(paneId)) return;
    const finished = (status === "done" || status === "idle") && (prev === "working" || prev === "blocked");
    if (status === "blocked" || finished) this.notify(paneId, status === "blocked" ? "blocked" : "done");
  }

  // 只推送在 Pi 里执行过 /remote-pi 的 pane：现取 agent get，以 pane 上的 remote_pi token 为准（默认不推送）
  async notify(paneId, status) {
    try {
      const agent = (await this.cliJson(["agent", "get", paneId]))?.agent;
      if (!agent) return;
      this.agents.set(paneId, agent);
      if (!herdrOptedIn(agent)) return;
      await this.onTransition({ paneId, status, agent });
    } catch (error) {
      console.warn(`${new Date().toISOString()} [herdr] notify ${paneId} failed: ${error.message}`);
    }
  }

  subscribe(paneIds) {
    this.socket?.destroy();
    this.subscribedKey = paneIds.join(",");
    const socket = net.connect(this.socketPath);
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
    });
  }

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

class PiRpc {
  constructor(config, onEvent, onClose) {
    this.config = config;
    this.onEvent = onEvent;
    this.onClose = onClose;
    this.pending = new Map();
    this.sequence = 0;
    this.proc = null;
    this.starting = null;
    this.pingTimer = null;
    this.missedPings = 0;
    this.stopping = false;
  }

  async ensureStarted() {
    if (this.proc) return;
    this.starting ??= this.start().finally(() => { this.starting = null; });
    await this.starting;
  }

  async start() {
    this.stopping = false;
    this.missedPings = 0; // 新进程从零计失联，避免上个进程被杀后的余数误杀新进程
    const args = ["--mode", "rpc", "--continue", "--session-dir", this.config.sessionDir];
    if (this.config.approve) args.push("--approve");
    const companionPath = existsSync(join(dirname(fileURLToPath(import.meta.url)), "remote-extension.mjs"))
      ? join(dirname(fileURLToPath(import.meta.url)), "remote-extension.mjs")
      : join(dirname(fileURLToPath(import.meta.url)), "telegram-extension.mjs");
    const extensionsToLoad = [];
    if (this.config.enableCompanionExtension && existsSync(companionPath)) {
      extensionsToLoad.push(companionPath);
    }
    if (Array.isArray(this.config.extensions)) {
      for (const ext of this.config.extensions) {
        if (!extensionsToLoad.includes(ext)) {
          extensionsToLoad.push(ext);
        }
      }
    }
    for (const ext of extensionsToLoad) {
      args.push("-e", ext);
    }
    let herdrEnv = {};
    if (this.config.herdr !== false) {
      try {
        herdrEnv = await resolveHerdrEnvironment(this.config.cwd, { piBin: this.config.piBin });
        if (herdrEnv.HERDR_PANE_ID) {
          console.log(`${new Date().toISOString()} [herdr] attached to pane ${herdrEnv.HERDR_PANE_ID} (workspace ${herdrEnv.HERDR_WORKSPACE_ID})`);
        }
      } catch (err) {
        console.warn(`${new Date().toISOString()} [herdr] resolveHerdrEnvironment failed: ${err.message}`);
      }
    }
    this.herdrEnv = herdrEnv;
    const env = {
      ...process.env,
      REMOTE_PI_GATEWAY: "1",
      PATH: buildDevPath(process.env.PATH),
      ...herdrEnv,
    };
    this.proc = spawn(this.config.piBin, args, { cwd: this.config.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    this.proc.stderr.pipe(process.stderr);
    await new Promise((resolveSpawn, reject) => {
      this.proc.once("spawn", resolveSpawn);
      this.proc.once("error", reject);
    });
    this.proc.stdin.on("error", () => {}); // EPIPE 竞态（kill 时在途写入）；pending 由 close 路径 reject

    let buffer = "";
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk) => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        let line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line) this.handleLine(line);
      }
    });
    this.proc.on("close", (code, signal) => {
      const wasStopping = this.stopping;
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = null;
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(new Error(`Pi exited (${code ?? signal})`));
      }
      this.pending.clear();
      this.proc = null;
      // ref: Node.js child_process close lifecycle (https://nodejs.org/api/child_process.html#event-close)
      if (this.onClose) this.onClose({ code, signal, expected: wasStopping });
    });

    // MCP 式 ping（spec: utilities/ping）：挂而不死的 Pi 连续 2 次失联后强杀，走 close→respawn 路径
    const pingMs = this.config.pingIntervalMs ?? 30_000;
    const pongMs = this.config.pingTimeoutMs ?? 10_000;
    this.pingTimer = setInterval(() => {
      this.request("get_state", {}, pongMs, true)
        .then(() => { this.missedPings = 0; })
        .catch(() => {
          if (++this.missedPings >= 2) {
            console.error(`${new Date().toISOString()} [pi:ping] 2 consecutive pings lost, killing Pi`);
            this.proc?.kill("SIGKILL");
          }
        });
    }, pingMs);
    this.pingTimer.unref();
  }

  handleLine(line) {
    let value;
    try { value = JSON.parse(line); }
    catch { console.error("Invalid Pi RPC line:", line.slice(0, 500)); return; }
    if (value.type === "response" && value.id && this.pending.has(value.id)) {
      const pending = this.pending.get(value.id);
      this.pending.delete(value.id);
      clearTimeout(pending.timer);
      value.success ? pending.resolve(value.data) : pending.reject(new Error(value.error || `${value.command} failed`));
    } else {
      this.onEvent(value);
    }
  }

  async request(type, fields = {}, timeout = 600_000, quiet = false) {
    await this.ensureStarted();
    const id = `rpc-${++this.sequence}`;
    const t0 = performance.now();
    return new Promise((resolveRequest, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const ms = Math.round(performance.now() - t0);
        if (!quiet) console.error(`${new Date().toISOString()} [pi:rpc] ${type} #${id} timed out after ${ms}ms`);
        reject(new Error(`Pi RPC ${type} timed out`));
      }, timeout);
      this.pending.set(id, {
        resolve: (data) => {
          const ms = Math.round(performance.now() - t0);
          if (!quiet) console.log(`${new Date().toISOString()} [pi:rpc] ${type} #${id} ok in ${ms}ms`);
          resolveRequest(data);
        },
        reject: (err) => {
          const ms = Math.round(performance.now() - t0);
          console.error(`${new Date().toISOString()} [pi:rpc] ${type} #${id} failed in ${ms}ms: ${err.message}`);
          reject(err);
        },
        timer,
      });
      try {
        this.write({ id, type, ...fields });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  write(value) {
    if (!this.proc?.stdin?.writable) throw new Error("Pi RPC is not running");
    this.proc.stdin.write(`${JSON.stringify(value)}\n`);
  }

  stop() {
    this.stopping = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.proc) {
      const proc = this.proc;
      this.proc = null;
      proc.kill("SIGTERM");
    }
  }
}

class Gateway {
  constructor(config) {
    this.config = config;
    this.chatId = config.allowedUserId;
    this.chatReady = false;
    this.state = loadState(config.stateDir);
    if (config.cwd && !this.state.recentProjects.includes(config.cwd)) {
      this.state.recentProjects.unshift(config.cwd);
    }
    this.telegram = new Telegram(config.botToken, join(config.stateDir, "telegram-offset"));
    this.pi = new PiRpc(config, (event) => this.queueEvent(event), (exit) => this.handlePiExit(exit));
    this.actions = new Map();
    this.commandAliases = new Map();
    this.toolPanel = null;
    this.mediaGroups = new Map();
    this.queue = { steering: [], followUp: [] };
    this.isStreaming = false;
    this.abortedRun = false;
    this.typingTimer = null;
    this.als = new AsyncLocalStorage();
    this.updateChain = Promise.resolve();
    this.eventChain = Promise.resolve();
    this.telegramChain = Promise.resolve();
    this.uploadChain = Promise.resolve();
    this.activeMessageIds = [];
    this.runStartedAt = null;
    this.runFirstTokenAt = null;
    this.runFirstUiAt = null;
    this.lastModel = null;
    this.herdrWatcher = null;
    this.herdrMessages = new Map();

    const origSend = this.telegram.send.bind(this.telegram);
    this.telegram.send = (chatId, text, extra = {}) =>
      this.queueTelegram(() => origSend(chatId, text, extra));

    const origEdit = this.telegram.edit.bind(this.telegram);
    this.telegram.edit = (chatId, messageId, text, ephemeral = false) =>
      this.queueTelegram(() => origEdit(chatId, messageId, text, ephemeral));
  }

  async start() {
    const t0 = performance.now();
    // launchd 以 O_APPEND 持有日志 fd，newsyslog 处理不了这种 fd；启动时截断 + 每小时巡检（服务极少重启，只靠启动截断等于没截）
    const trimLog = () => stat(this.config.logFile).then((s) => s.size > MAX_LOG_SIZE ? truncate(this.config.logFile, 0) : null).catch(() => {});
    await trimLog();
    setInterval(trimLog, 60 * 60_000).unref();
    await Promise.all([
      mkdir(this.config.stateDir, { recursive: true, mode: 0o700 }),
      mkdir(this.config.sessionDir, { recursive: true, mode: 0o700 }),
      mkdir(this.config.downloadsDir, { recursive: true, mode: 0o700 }),
    ]);
    await this.acquireLock();
    await this.telegram.call("deleteWebhook", { drop_pending_updates: false }).catch(() => {});
    const me = await this.telegram.call("getMe");
    try { await this.telegram.call("getChat", { chat_id: this.chatId }); this.chatReady = true; }
    catch (error) { if (!error.message.includes("chat not found")) throw error; }
    await this.pi.start();
    const state = await this.pi.request("get_state");
    if (state?.model?.provider && state?.model?.id) {
      this.lastModel = { provider: state.model.provider, modelId: state.model.id };
    }
    await this.registerBotCommands();
    this.startHerdrWatcher();
    console.log(`${new Date().toISOString()} @${me.username} ready in ${Math.round(performance.now() - t0)}ms; Pi session ${state.sessionId}`);
    await this.telegram.poll((update) => this.dispatchUpdate(update));
  }

  async saveDownload(fileId, name, needsBase64 = false) {
    const t0 = performance.now();
    const file = await this.telegram.call("getFile", { file_id: fileId });
    const response = await fetch(`${this.telegram.fileBase}/${file.file_path}`, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`Telegram download: ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    const safe = name.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80) || "file";
    const path = join(this.config.downloadsDir, `${Date.now()}-${safe}`);
    await writeFile(path, buffer);
    console.log(`${new Date().toISOString()} [download] ${name} (${buffer.length} bytes) in ${Math.round(performance.now() - t0)}ms`);
    return { path, data: needsBase64 ? buffer.toString("base64") : null };
  }

  queueEvent(event) {
    this.eventChain = this.eventChain.then(() => this.handleEvent(event)).catch((error) => console.error("Pi event:", error));
  }

  queueTelegram(work) {
    if (this.als.getStore()) return work();
    const next = this.telegramChain.then(() => this.als.run(true, work));
    this.telegramChain = next.catch((error) => console.error("Telegram output:", error));
    return next;
  }

  queueUpload(work) {
    const next = this.uploadChain.then(work);
    this.uploadChain = next.catch((error) => console.error("Upload output:", error));
    return next;
  }

  handlePiExit({ code, signal, expected }) {
    if (expected) return;
    const wasStreaming = this.isStreaming;
    const pendingUi = this.pendingUi;
    this.resetSessionState();
    this.settleActiveReactions();
    if (wasStreaming || pendingUi) {
      console.error(`${new Date().toISOString()} [pi] process exited unexpectedly (${code ?? signal})`);
      this.queueTelegram(() => this.telegram.send(this.chatId, `⚠️ Pi process exited unexpectedly (${code ?? signal}); recovered and ready.`));
    }
  }

  isAllowed(from, chat) {
    return String(from?.id) === this.config.allowedUserId && (!chat || chat.type === "private");
  }

  settleActiveReactions() {
    for (const id of this.activeMessageIds.splice(0)) {
      this.queueTelegram(() => this.telegram.setReaction(this.chatId, id, this.config.doneEmoji));
    }
  }

  dispatchUpdate(update) {
    const priority = getUpdatePriority(update);
    if (priority === "p0" || priority === "p1") {
      const p = this.handlePriorityUpdate(update, priority).catch((err) => console.error(`[${priority}] error:`, err));
      return p;
    }
    // 相册入站聚合：首条出现时立即在 updateChain 占位，保证后续普通消息排在相册之后 (ref: python-telegram-bot media_group)
    if (update.message?.media_group_id && this.isAllowed(update.message.from, update.message.chat) && !this.pendingUi) {
      const m = update.message;
      this.chatReady = true;
      this.telegram.setReaction(this.chatId, m.message_id, this.config.ackEmoji);
      const key = `${this.chatId}:${m.media_group_id}`;
      let group = this.mediaGroups.get(key);
      if (!group) {
        let resolveReady;
        const ready = new Promise((r) => { resolveReady = r; });
        group = { messages: [], timer: null, ready, resolveReady, cancelled: false };
        this.mediaGroups.set(key, group);
        const groupTask = async () => {
          await group.ready;
          if (group.cancelled || !group.messages.length) return;
          await this.handleMediaGroup(group.messages);
        };
        const next = this.updateChain.then(groupTask).catch((err) => {
          console.error("Media group error:", err);
          this.telegram.send(this.chatId, `❌ Failed to process media group: ${err.message}`);
        });
        this.updateChain = next;
        group.done = next;
      }
      group.messages.push(m);
      if (group.timer) clearTimeout(group.timer);
      group.timer = setTimeout(() => {
        this.mediaGroups.delete(key);
        group.resolveReady();
      }, 1200);
      return group.done;
    }
    const next = this.updateChain.then(() => this.handleUpdate(update));
    this.updateChain = next.catch((err) => console.error("Telegram update error:", err));
    return next;
  }

  async handlePriorityUpdate(update, priority) {
    const t0 = performance.now();
    try {
      if (update.stopped_message_generation) {
        console.log(`${new Date().toISOString()} [p0] stopped_message_generation`);
        await this.handleCommand({ name: "abort", argument: "" }, "/abort", update.update_id);
        return;
      }
      const m = update.message;
      if (!m || !this.isAllowed(m.from, m.chat)) return;
      this.chatReady = true;
      const cmd = parseCommand(m.text?.trim() || "");
      if (!cmd) return;
      if (cmd.name === "restart") {
        const receiptPath = join(this.config.stateDir, "last-restart-update");
        const lastRestart = await readFile(receiptPath, "utf8").catch(() => "");
        if (lastRestart && String(update.update_id) === lastRestart.trim()) {
          console.log(`${new Date().toISOString()} [p0] ignoring duplicate restart update #${update.update_id}`);
          return;
        }
      }
      this.telegram.setReaction(this.chatId, m.message_id, this.config.ackEmoji);
      console.log(`${new Date().toISOString()} [${priority}] handling /${cmd.name}`);
      await this.handleCommand(cmd, m.text, update.update_id);
      await this.telegram.setReaction(this.chatId, m.message_id, this.config.doneEmoji);
    } catch (error) {
      console.error(`[${priority}] error:`, error);
      await this.telegram.send(this.chatId, `❌ ${error.message}`);
    } finally {
      console.log(`${new Date().toISOString()} [${priority}] finished in ${Math.round(performance.now() - t0)}ms`);
    }
  }

  async handleUpdate(update) {
    const t0 = performance.now();
    try {
      if (update.message) {
        if (!this.isAllowed(update.message.from, update.message.chat)) return;
        this.chatReady = true;
        const m = update.message;
        const lag = m.date ? `${Date.now() - m.date * 1000}ms` : "0ms";
        const preview = (m.text || m.caption || (m.photo ? "[photo]" : m.voice ? "[voice]" : "[file]")).slice(0, 50).replace(/\n/g, " ");
        console.log(`${new Date().toISOString()} [update] msg #${m.message_id} (tg lag: ${lag}): ${preview}`);
        await this.handleMessage(update.message);
      } else if (update.callback_query) {
        const callback = update.callback_query;
        if (!this.isAllowed(callback.from, callback.message?.chat)) return;
        this.chatReady = true;
        console.log(`${new Date().toISOString()} [update] callback #${callback.id}: ${callback.data}`);
        await this.handleCallback(callback);
      }
      // stopped_message_generation 由 getUpdatePriority 判为 p0，永远走 handlePriorityUpdate，此处不可达
    } catch (error) {
      console.error("Telegram input:", error);
      this.settleActiveReactions();
      await this.telegram.send(this.chatId, `❌ ${error.message}`);
    } finally {
      console.log(`${new Date().toISOString()} [update] #${update.update_id} finished in ${Math.round(performance.now() - t0)}ms`);
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

  async handleMessage(message) {
    if (this.pendingUi && !message.text?.startsWith("/")) {
      const pending = this.pendingUi;
      this.pendingUi = null;
      this.telegram.setReaction(this.chatId, message.message_id, this.config.ackEmoji);
      this.pi.write({ type: "extension_ui_response", id: pending.id, value: message.text || message.caption || "" });
      await this.telegram.send(this.chatId, "Submitted.");
      await this.telegram.setReaction(this.chatId, message.message_id, this.config.doneEmoji);
      return;
    }

    const herdrPane = this.herdrWatcher && this.herdrMessages.get(message.reply_to_message?.message_id);
    if (herdrPane && message.text && !message.text.startsWith("/")) return this.replyToHerdrAgent(herdrPane, message);

    const media = await this.extractMedia(message);
    if (media) {
      this.telegram.setReaction(this.chatId, message.message_id, this.config.ackEmoji);
      if (message.voice && this.config.sttCommand) {
        try {
          const tStt = performance.now();
          const transcript = await runStt(this.config.sttCommand, media.saved.path);
          console.log(`${new Date().toISOString()} [stt] transcribed voice in ${Math.round(performance.now() - tStt)}ms`);
          this.activeMessageIds.push(message.message_id);
          this.runStartedAt = performance.now();
          this.runFirstTokenAt = null;
          this.runFirstUiAt = null;
          await this.prompt(`${transcript}${message.caption ? `\n\n${message.caption}` : ""}`);
          return;
        } catch (error) {
          return this.telegram.send(this.chatId, `❌ ${error.message}`);
        }
      }
      this.activeMessageIds.push(message.message_id);
      this.runStartedAt = performance.now();
      this.runFirstTokenAt = null;
      this.runFirstUiAt = null;
      await this.prompt(attachmentPrompt(message.caption || `User sent a ${media.label}.`, [media.saved]), media.image ? [media.image] : undefined);
      return;
    }

    const text = message.text?.trim();
    if (!text) return;

    this.telegram.setReaction(this.chatId, message.message_id, this.config.ackEmoji);

    const command = parseCommand(text);
    if (command) {
      if (command.name === "followup") this.activeMessageIds.push(message.message_id);
      await this.handleCommand(command, text);
      if (command.name !== "followup") {
        await this.telegram.setReaction(this.chatId, message.message_id, this.config.doneEmoji);
      }
    } else {
      this.activeMessageIds.push(message.message_id);
      this.runStartedAt = performance.now();
      this.runFirstTokenAt = null;
      this.runFirstUiAt = null;
      await this.prompt(text);
    }
  }

  async handleMediaGroup(messages) {
    const mediaList = await Promise.all(messages.map((m) => this.extractMedia(m)));
    const files = [];
    const images = [];
    let caption = "";
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].caption) caption = messages[i].caption;
      const media = mediaList[i];
      if (!media) continue;
      files.push(media.saved);
      if (media.image) images.push(media.image);
    }
    for (const m of messages) this.activeMessageIds.push(m.message_id);
    this.runStartedAt = performance.now();
    this.runFirstTokenAt = null;
    this.runFirstUiAt = null;
    if (files.length) {
      await this.prompt(attachmentPrompt(caption || "Please review these files.", files), images.length ? images : undefined);
    } else if (caption) {
      await this.prompt(caption);
    }
  }

  startTyping() {
    if (this.typingTimer) return;
    this.telegram.sendChatAction(this.chatId, "typing");
    this.typingTimer = setInterval(() => {
      this.telegram.sendChatAction(this.chatId, "typing");
    }, 4500);
    this.typingTimer.unref();
  }

  stopTyping() {
    if (this.typingTimer) {
      clearInterval(this.typingTimer);
      this.typingTimer = null;
    }
  }

  resetSessionState() {
    this.isStreaming = false;
    this.stopTyping();
    if (this.pendingUi && this.pi.proc) {
      this.pi.write({ type: "extension_ui_response", id: this.pendingUi.id, cancelled: true });
    }
    this.pendingUi = null;
    this.runStartedAt = null;
    this.runFirstTokenAt = null;
    this.runFirstUiAt = null;
    for (const group of this.mediaGroups.values()) {
      if (group.timer) clearTimeout(group.timer);
      group.cancelled = true;
      if (group.resolveReady) group.resolveReady();
    }
    this.mediaGroups.clear();
    for (const [key, action] of this.actions) {
      if (action.type === "ui") this.actions.delete(key);
    }
    if (this.toolPanel?.timer) clearTimeout(this.toolPanel.timer);
    this.toolPanel = null;
    if (this.draft) {
      if (this.draft.timer) clearTimeout(this.draft.timer);
      // ponytail: 不发空文本“清除”（协议里是 Thinking 占位）；停止更新让 30s 预览自然过期
      this.draft.closed = true;
      if (this.draft.messageId) this.telegram.deleteMessage(this.chatId, this.draft.messageId).catch(() => {});
    }
    this.draft = null;
    this.queue = { steering: [], followUp: [] };
  }

  async prompt(message, images, streamingBehavior) {
    const t0 = performance.now();
    this.startTyping();
    try {
      const fields = { message };
      if (images) fields.images = images;
      const behavior = streamingBehavior || (this.isStreaming ? "steer" : undefined);
      if (behavior) fields.streamingBehavior = behavior;
      console.log(`${new Date().toISOString()} [prompt] sending to Pi (behavior=${behavior || "initial"}, chars=${message.length})`);
      try {
        await this.pi.request("prompt", fields);
      } catch (error) {
        if (!behavior && /streaming/i.test(error.message)) {
          fields.streamingBehavior = "steer";
          await this.pi.request("prompt", fields);
          this.isStreaming = true;
        } else {
          throw error;
        }
      }
      console.log(`${new Date().toISOString()} [prompt] accepted by Pi in ${Math.round(performance.now() - t0)}ms`);
      if (fields.streamingBehavior === "followUp") await this.telegram.send(this.chatId, "↪ Queued as follow-up", { disable_notification: true });
    } catch (error) {
      this.stopTyping();
      throw error;
    }
  }

  async handleCommand({ name, argument }, original, updateId = null) {
    const t0 = performance.now();
    try {
      switch (name) {
      case "start": case "help": return this.telegram.send(this.chatId, HELP);
      case "commands": return this.showCommands();
      case "cwd": return argument ? this.switchCwd(resolvePath(argument.trim(), this.config.cwd), null) : this.showCwds();
      case "model": return this.showModels(argument);
      case "thinking": return this.showThinking(argument);
      case "resume": return this.showSessions();
      case "reset":
      case "new": {
        this.abortedRun = true;
        if (this.pi.proc) {
          await this.pi.request("clear_queue").catch(() => {});
          await this.pi.request("abort").catch(() => {});
        }
        const stateBefore = this.pi.proc ? await this.pi.request("get_state").catch(() => null) : null;
        const targetModel = (stateBefore?.model?.provider && stateBefore?.model?.id)
          ? { provider: stateBefore.model.provider, modelId: stateBefore.model.id }
          : this.lastModel;
        this.resetSessionState();
        this.settleActiveReactions();
        const result = await this.pi.request("new_session");
        if (result.cancelled) {
          return this.telegram.send(this.chatId, "New session cancelled");
        }
        if (targetModel) {
          await this.pi.request("set_model", targetModel).catch((err) => {
            console.error("Failed to restore last model after new_session:", err.message);
          });
          this.lastModel = targetModel;
        }
        const state = await this.pi.request("get_state").catch(() => null);
        const text = formatSessionReset({ model: state?.model, cwd: this.config.cwd });
        return this.telegram.send(this.chatId, text);
      }
      case "name": {
        if (!argument) return this.telegram.send(this.chatId, "Usage: /name <name>");
        await this.pi.request("set_session_name", { name: argument });
        return this.telegram.send(this.chatId, `✅ Session name: ${argument}`);
      }
      case "session": case "status": return this.showSession();
      case "agents": return this.showHerdrAgents();
      case "fork": return this.showForks();
      case "clone": {
        const result = await this.pi.request("clone");
        return this.telegram.send(this.chatId, result.cancelled ? "Clone cancelled" : "✅ Current branch cloned");
      }
      case "compact": {
        this.startTyping();
        try {
          const result = await this.pi.request("compact", argument ? { customInstructions: argument } : {});
          return this.telegram.send(this.chatId, `✅ Compacted: ${result.tokensBefore} → ~${result.estimatedTokensAfter} tokens`);
        } catch (error) {
          if (!/abort/i.test(error.message)) {
            return this.telegram.send(this.chatId, `❌ ${error.message}`);
          }
        } finally {
          this.stopTyping();
        }
      }
      case "export": {
        const result = await this.pi.request("export_html");
        await this.telegram.sendDocument(this.chatId, result.path);
        return;
      }
      case "sh": case "bash": {
        if (!argument) return this.telegram.send(this.chatId, "Usage: /sh <command>");
        if (/install\.sh\s+(restart|stop|uninstall)|launchctl\s+(bootout|kickstart)/i.test(argument)) {
          return this.telegram.send(this.chatId, "❌ Service restart/stop commands are blocked here. Send /restart to restart the gateway.");
        }
        this.startTyping();
        try {
          const res = await this.pi.request("bash", { command: argument });
          const output = res.output ? res.output.trim() : "(no output)";
          if (output.split("\n").length > 3) {
            return this.telegram.send(this.chatId, expandableBlockquote(output));
          }
          return this.telegram.send(this.chatId, output);
        } catch (error) {
          if (!/abort/i.test(error.message)) {
            return this.telegram.send(this.chatId, `❌ ${error.message}`);
          }
        } finally {
          this.stopTyping();
        }
      }
      case "get": {
        if (!argument) return this.telegram.send(this.chatId, "Usage: /get <path>");
        const filePath = resolve(this.config.cwd, argument);
        try {
          const s = await stat(filePath);
          if (!s.isFile()) return this.telegram.send(this.chatId, "❌ Not a regular file");
          if (s.size > 20 * 1024 * 1024) return this.telegram.send(this.chatId, "❌ File exceeds the 20MB limit");
          await this.telegram.sendDocument(this.chatId, filePath);
        } catch (error) {
          return this.telegram.send(this.chatId, `❌ File missing or inaccessible: ${error.message}`);
        }
        return;
      }
      case "followup": {
        if (!argument) return this.telegram.send(this.chatId, "Usage: /followup <message>");
        return this.prompt(argument, undefined, "followUp");
      }
      case "abort": {
        this.abortedRun = true;
        const clear = argument === "clear";
        if (this.pendingUi && this.pi.proc) {
          this.pi.write({ type: "extension_ui_response", id: this.pendingUi.id, cancelled: true });
        }
        if (this.pi.proc) {
          if (clear) await this.pi.request("clear_queue").catch(() => {});
          await this.pi.request("abort").catch(() => {});
        }
        const kept = this.queue;
        this.resetSessionState();
        if (!clear) this.queue = kept;
        this.settleActiveReactions();
        return this.telegram.send(this.chatId, clear ? "⏹ Stopped; queue cleared" : "⏹ Stopped (queued messages kept; /abort clear to clear)");
      }
      case "upgrade": {
        // 复用 install.sh upgrade（dirty check / ff-only pull / npm install / self-test / 自动回滚），
        // --no-restart 防止脚本 kickstart 杀掉自身导致回复发不出去；重启复用 /restart。
        // ref: staged self-update best practice — verify before swap, restart via supervisor
        // (https://docs.rs/update-rs/latest/update_rs/index.html)
        this.startTyping();
        const script = join(dirname(fileURLToPath(import.meta.url)), "install.sh");
        const res = await new Promise((done) => {
          const child = spawn("bash", [script, "upgrade", "--no-restart"], { timeout: 300_000 });
          let buf = "";
          child.stdout.on("data", (c) => { buf += c; });
          child.stderr.on("data", (c) => { buf += c; });
          child.on("close", (code) => done({ code, buf }));
          child.on("error", (err) => done({ code: 1, buf: String(err) }));
        });
        this.stopTyping();
        const text = res.buf.trim() || "(no output)";
        if (res.code !== 0) return this.telegram.send(this.chatId, `❌ Upgrade failed\n${text}`);
        if (text.includes("Already up to date")) return this.telegram.send(this.chatId, text);
        await this.telegram.send(this.chatId, text);
        return this.handleCommand({ name: "restart", argument: "" }, "/restart", updateId); // graceful restart: 回执落盘 → exit → launchd 拉起新版
      }
      case "restart": {
        await this.telegram.send(this.chatId, "🔄 Restarting gateway…");
        // ref: Node.js process.exit & restart receipt (https://nodejs.org/api/process.html#processexitcode)
        if (updateId) {
          const receiptPath = join(this.config.stateDir, "last-restart-update");
          await writeFile(receiptPath, String(updateId), { mode: 0o600 }).catch(() => {});
          const tmp = `${this.telegram.offsetPath}.tmp`;
          await writeFile(tmp, String(updateId + 1), { mode: 0o600 }).catch(() => {});
          await rename(tmp, this.telegram.offsetPath).catch(() => {});
        }
        this.stop();
        setTimeout(() => process.exit(0), 100);
        return;
      }
      case "queue": {
        if (argument === "clear") {
          const removed = this.pi.proc ? await this.pi.request("clear_queue").catch(() => ({ steering: [], followUp: [] })) : { steering: [], followUp: [] };
          this.queue = { steering: [], followUp: [] };
          return this.telegram.send(this.chatId, `Cleared\nsteering: ${removed.steering.length}\nfollow-up: ${removed.followUp.length}`);
        }
        return this.telegram.send(this.chatId, `steering:\n${this.queue.steering.join("\n") || "(empty)"}\n\nfollow-up:\n${this.queue.followUp.join("\n") || "(empty)"}`);
      }
      default: {
        const alias = this.commandAliases.get(name);
        if (alias) return this.prompt(`/${alias}${argument ? ` ${argument}` : ""}`);
        const commands = await this.pi.request("get_commands");
        if (commands.commands.some((item) => item.name.toLowerCase() === name)) return this.prompt(original);
        return this.telegram.send(this.chatId, `Unknown command: /${name}\nUse /help or /commands`);
      }
    }
    } finally {
      console.log(`${new Date().toISOString()} [cmd] /${name} finished in ${Math.round(performance.now() - t0)}ms`);
    }
  }

  async registerBotCommands() {
    const t0 = performance.now();
    const data = await this.pi.request("get_commands");
    const commands = [...BOT_COMMANDS];
    for (const command of data.commands) {
      const telegramName = telegramCommandName(command);
      if (!telegramName || commands.some((item) => item.command === telegramName)) continue;
      if (!/^[a-z0-9_]{1,32}$/.test(telegramName)) continue;
      commands.push({ command: telegramName, description: (command.description || command.name).replace(/\s+/g, " ").slice(0, 200) });
      this.commandAliases.set(telegramName, command.name);
      if (command.source === "skill") {
        this.commandAliases.set(`skill-${command.name.slice("skill:".length).toLowerCase()}`, command.name);
      }
    }
    const finalCommands = commands.slice(0, 100);
    await Promise.all([
      this.telegram.call("setMyCommands", { commands: finalCommands }),
      this.telegram.call("setMyCommands", { commands: finalCommands, scope: { type: "all_private_chats" } }),
    ]);
    console.log(`${new Date().toISOString()} [gateway] bot commands registered (${finalCommands.length}) in ${Math.round(performance.now() - t0)}ms`);
  }

  async showCommands() {
    const data = await this.pi.request("get_commands");
    const text = data.commands.length
      ? data.commands.map((item) => `/${item.name}${item.description ? ` — ${item.description}` : ""}`).join("\n")
      : "No extension commands, prompt templates, or skills loaded.";
    await this.telegram.send(this.chatId, text);
  }

  async saveState(patch) {
    this.state = { ...this.state, ...patch };
    const statePath = join(this.config.stateDir, "state.json");
    const tempPath = `${statePath}.tmp.${Date.now()}`;
    try {
      await writeFile(tempPath, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
      await rename(tempPath, statePath);
    } catch (err) {
      console.warn(`[state] failed to persist state to ${statePath}: ${err.message}`);
    }
  }

  async showCwds() {
    const items = new Map();

    if (Array.isArray(this.state.recentProjects)) {
      for (const p of this.state.recentProjects) {
        if (!items.has(p) && existsSync(p)) {
          items.set(p, basename(p));
        }
      }
    }

    if (!items.has(this.config.cwd)) {
      items.set(this.config.cwd, basename(this.config.cwd));
    }

    if (items.size <= 1) {
      await this.telegram.send(
        this.chatId,
        `Current directory: ${this.config.cwd}\n\nNo recent projects yet. Use /cwd <absolute-path> to switch to another project.`,
      );
      return;
    }

    const keyboardItems = Array.from(items.entries()).map(([path, name]) => ({
      label: `${path === this.config.cwd ? "●" : "○"} ${name}`,
      action: { type: "cwd", path },
    }));

    await this.telegram.send(this.chatId, `Current directory: ${this.config.cwd}\n\nPick a workspace project:`, this.keyboard(keyboardItems));
  }

  action(payload, ttl = 10 * 60_000) {
    const now = Date.now();
    for (const [key, value] of this.actions) if (value.expires < now) this.actions.delete(key);
    const token = randomBytes(6).toString("base64url");
    this.actions.set(token, { ...payload, expires: now + ttl });
    return `a:${token}`;
  }

  startHerdrWatcher() {
    const env = this.pi.herdrEnv;
    if (this.config.herdr === false || !env?.HERDR_BIN_PATH || !env?.HERDR_SOCKET_PATH) return;
    this.herdrWatcher = new HerdrWatcher({
      bin: env.HERDR_BIN_PATH,
      socketPath: env.HERDR_SOCKET_PATH,
      // 网关自己的 Pi 已在本对话里流式输出，不再重复推送
      isExcluded: (paneId) => paneId === this.pi.herdrEnv?.HERDR_PANE_ID,
      onTransition: ({ paneId, status, agent }) => this.sendHerdrAgent(paneId, status, agent),
    });
    this.herdrWatcher.start();
  }

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
      blocked ? "Tap a button, or reply to this message to type an answer." : "Reply to this message to send this agent a prompt.",
    ].filter(Boolean).join("\n\n");

    // 审批按钮 24h 有效（手机上可能晚些才看到）；同一条通知的按钮按 group 一次性消费
    const ttl = 24 * 60 * 60_000;
    const group = randomBytes(4).toString("hex");
    const keyButton = (label, keys) => ({ text: label.slice(0, 60), callback_data: this.action({ type: "herdr_keys", paneId, keys, label, group }, ttl) });
    const rows = [];
    if (blocked) {
      for (const choice of herdrChoices(tail)) rows.push([keyButton(`${choice.key}. ${choice.label}`, [choice.key])]);
      rows.push([keyButton("⏎ Enter", ["enter"]), keyButton("⎋ Esc", ["esc"])]);
    }
    rows.push([{ text: "🔄 Refresh", callback_data: this.action({ type: "herdr_peek", paneId }, ttl) }]);
    const sent = await this.telegram.send(this.chatId, text, { reply_markup: { inline_keyboard: rows } });
    if (sent?.message_id) {
      this.herdrMessages.set(sent.message_id, paneId);
      if (this.herdrMessages.size > 200) this.herdrMessages.delete(this.herdrMessages.keys().next().value);
    }
  }

  async showHerdrAgents() {
    if (!this.herdrWatcher) return this.telegram.send(this.chatId, "Herdr is not available (disabled in config, or its server is not running).");
    await this.herdrWatcher.sync();
    const ownPane = this.pi.herdrEnv?.HERDR_PANE_ID;
    const agents = [...this.herdrWatcher.agents.values()].filter((agent) => agent.pane_id !== ownPane);
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
        const title = agent.terminal_title_stripped ? ` — ${agent.terminal_title_stripped.replace(/[`*_[\]]/g, "")}` : "";
        lines.push(`${HERDR_STATUS_ICON[agent.agent_status] || "❔"} ${agent.name || agent.agent} \`${agent.pane_id}\` ${agent.agent_status}${herdrOptedIn(agent) ? " 📡" : ""}${title}`);
      }
      lines.push("");
    }
    lines.push("📡 = pushed to Telegram (run /remote-pi inside that Pi to toggle). Tap an agent to see its screen.");
    return this.telegram.send(this.chatId, lines.join("\n"), this.keyboard(agents.map((agent) => ({
      label: `${HERDR_STATUS_ICON[agent.agent_status] || "❔"} ${agent.name || agent.agent} · ${this.herdrWatcher.workspaces.get(agent.workspace_id) || agent.pane_id}`,
      action: { type: "herdr_peek", paneId: agent.pane_id },
    }))));
  }

  async replyToHerdrAgent(paneId, message) {
    const watcher = this.herdrWatcher;
    const text = message.text.trim();
    this.telegram.setReaction(this.chatId, message.message_id, this.config.ackEmoji);
    try {
      const agent = (await watcher.cliJson(["agent", "get", paneId]))?.agent;
      if (!agent) return this.telegram.send(this.chatId, `❌ ${paneId} no longer hosts an agent`);
      // agent prompt 会拒绝 blocked 状态（agent_blocked）；此时把文本打进提问 UI 再回车
      if (agent.agent_status === "blocked") {
        await watcher.cli(["pane", "send-text", paneId, text]);
        await watcher.cli(["agent", "send-keys", paneId, "enter"]);
      } else {
        await watcher.cli(["agent", "prompt", paneId, text]);
      }
      await this.telegram.setReaction(this.chatId, message.message_id, this.config.doneEmoji);
      return this.telegram.send(this.chatId, `📨 Sent to ${watcher.label(paneId)}`, { disable_notification: true });
    } catch (error) {
      return this.telegram.send(this.chatId, `❌ ${error.message}`);
    }
  }

  keyboard(items) {
    return { reply_markup: { inline_keyboard: items.map(({ label, action }) => [{ text: label.slice(0, 60), callback_data: this.action(action) }]) } };
  }

  async showModels(query) {
    const data = await this.pi.request("get_available_models");
    const models = data.models;
    if (query) {
      const exact = models.find((model) => `${model.provider}/${model.id}` === query || model.id === query);
      if (exact) {
        await this.pi.request("set_model", { provider: exact.provider, modelId: exact.id });
        this.lastModel = { provider: exact.provider, modelId: exact.id };
        return this.telegram.send(this.chatId, `✅ ${exact.provider}/${exact.id}`);
      }
    }
    const filtered = models.filter((model) => !query || `${model.provider}/${model.id} ${model.name}`.toLowerCase().includes(query.toLowerCase()));
    if (!filtered.length) return this.telegram.send(this.chatId, `No matching model: ${query}`);
    const display = filtered.slice(0, 18);
    const suffix = filtered.length > 18 ? `\n\n(${filtered.length} models; showing first 18 — use /model <query> to filter)` : "";
    return this.telegram.send(this.chatId, `Pick a model:${suffix}`, this.keyboard(display.map((model) => ({
      label: `${model.provider}/${model.id}`,
      action: { type: "model", provider: model.provider, modelId: model.id },
    }))));
  }

  async showThinking(argument) {
    const data = await this.pi.request("get_available_thinking_levels");
    if (argument) {
      if (!data.levels.includes(argument)) return this.telegram.send(this.chatId, `Available levels: ${data.levels.join(", ")}`);
      await this.pi.request("set_thinking_level", { level: argument });
      return this.telegram.send(this.chatId, `✅ thinking: ${argument}`);
    }
    return this.telegram.send(this.chatId, "Pick a thinking level:", this.keyboard(data.levels.map((level) => ({
      label: level, action: { type: "thinking", level },
    }))));
  }

  async sessionFiles() {
    if (!existsSync(this.config.sessionDir)) return [];
    const names = (await readdir(this.config.sessionDir)).filter((name) => name.endsWith(".jsonl"));
    const files = await Promise.all(names.map(async (name) => {
      const path = join(this.config.sessionDir, name);
      const info = await stat(path).catch(() => null);
      return info ? { path, name, mtime: info.mtimeMs } : null;
    }));
    const sorted = files.filter(Boolean).sort((a, b) => b.mtime - a.mtime).slice(0, 15);
    const parseHead = async ({ path, name, mtime }) => {
      try {
        const fh = await open(path, "r");
        const buf = Buffer.alloc(16384);
        const { bytesRead } = await fh.read(buf, 0, 16384, 0);
        await fh.close();
        const raw = buf.toString("utf8", 0, bytesRead);
        let header;
        let title = "";
        for (const line of raw.split("\n", 20)) {
          if (!line) continue;
          let entry;
          try { entry = JSON.parse(line); } catch {
            const m = line.match(/"role"\s*:\s*"user"[\s\S]*?"text"\s*:\s*"([^"\\]{1,60})/);
            if (m) title = m[1];
            continue;
          }
          if (entry.type === "session") header = entry;
          if (entry.type === "session_info" && entry.name) title = entry.name;
          if (!title && entry.type === "message" && entry.message?.role === "user") title = extractText(entry.message.content).slice(0, 60);
          if (header && title) break;
        }
        if (header?.cwd === this.config.cwd) return { path, id: header.id, title: title || name, mtime };
      } catch (error) {
        console.error(`Skipping session ${path}:`, error.message);
      }
      return null;
    };
    return (await Promise.all(sorted.map(parseHead))).filter(Boolean);
  }

  async showSessions() {
    const sessions = (await this.sessionFiles()).slice(0, 12);
    if (!sessions.length) return this.telegram.send(this.chatId, "No past sessions for this directory yet.");
    return this.telegram.send(this.chatId, "Pick a session:", this.keyboard(sessions.map((session) => ({
      label: session.title,
      action: { type: "resume", path: session.path },
    }))));
  }

  async showSession() {
    const [state, stats] = await Promise.all([this.pi.request("get_state"), this.pi.request("get_session_stats")]);
    const model = state.model ? `${state.model.provider}/${state.model.id}` : "none";
    const context = stats.contextUsage ? `${stats.contextUsage.tokens ?? "?"}/${stats.contextUsage.contextWindow} (${stats.contextUsage.percent ?? "?"}%)` : "n/a";
    await this.telegram.send(this.chatId, [
      `Name: ${state.sessionName || "(unnamed)"}`, `Model: ${model}`, `Thinking: ${state.thinkingLevel}`,
      `State: ${state.isStreaming ? "working" : "idle"}`, `Messages: ${stats.totalMessages}`, `Context: ${context}`,
      `Cost: $${Number(stats.cost || 0).toFixed(4)}`, `Session: ${state.sessionId}`, `File: ${state.sessionFile || "not persisted"}`,
    ].join("\n"));
  }

  async showForks() {
    const data = await this.pi.request("get_fork_messages");
    const messages = data.messages.slice(-12).reverse();
    if (!messages.length) return this.telegram.send(this.chatId, "No user messages to fork from.");
    return this.telegram.send(this.chatId, "Fork from which message?", this.keyboard(messages.map((message) => ({
      label: message.text.replaceAll("\n", " ").slice(0, 60),
      action: { type: "fork", entryId: message.entryId },
    }))));
  }

  async handleCallback(callback) {
    const t0 = performance.now();
    const token = callback.data?.startsWith("a:") ? callback.data.slice(2) : "";
    const action = this.actions.get(token);
    this.actions.delete(token);
    if (!action || action.expires < Date.now()) return this.telegram.answer(callback.id, "Expired");
    try {
      console.log(`${new Date().toISOString()} [callback] handling ${action.type}`);
      if (action.type === "model") {
        await this.pi.request("set_model", { provider: action.provider, modelId: action.modelId });
        this.lastModel = { provider: action.provider, modelId: action.modelId };
        await this.telegram.send(this.chatId, `✅ ${action.provider}/${action.modelId}`);
      } else if (action.type === "thinking") {
        await this.pi.request("set_thinking_level", { level: action.level });
        await this.telegram.send(this.chatId, `✅ thinking: ${action.level}`);
      } else if (action.type === "resume") {
        if (this.isStreaming) await this.pi.request("abort").catch(() => {});
        this.resetSessionState();
        const result = await this.pi.request("switch_session", { sessionPath: action.path });
        if (!result.cancelled) {
          const state = await this.pi.request("get_state").catch(() => null);
          if (state?.model?.provider && state?.model?.id) {
            this.lastModel = { provider: state.model.provider, modelId: state.model.id };
          }
        }
        await this.telegram.send(this.chatId, result.cancelled ? "Resume cancelled" : "✅ Session resumed");
      } else if (action.type === "fork") {
        if (this.isStreaming) await this.pi.request("abort").catch(() => {});
        this.resetSessionState();
        const result = await this.pi.request("fork", { entryId: action.entryId });
        await this.telegram.send(this.chatId, result.cancelled ? "Fork cancelled" : `✅ Forked from "${result.text.slice(0, 80)}"`);
      } else if (action.type === "cwd") {
        await this.switchCwd(action.path, callback.id);
        return;
      } else if (action.type === "herdr_peek") {
        const agent = (await this.herdrWatcher.cliJson(["agent", "get", action.paneId]))?.agent;
        if (!agent) return this.telegram.answer(callback.id, "Agent is gone");
        await this.sendHerdrAgent(action.paneId, agent.agent_status, agent);
      } else if (action.type === "herdr_keys") {
        for (const [k, v] of this.actions) {
          if (v.group === action.group) this.actions.delete(k);
        }
        const removeButtons = () => callback.message && this.telegram.call("editMessageReplyMarkup", {
          chat_id: callback.message.chat.id, message_id: callback.message.message_id, reply_markup: { inline_keyboard: [] },
        }).catch(() => {});
        // 只在仍处于 blocked 时发键，避免把「1」误打进已恢复工作的 agent
        const agent = (await this.herdrWatcher.cliJson(["agent", "get", action.paneId]))?.agent;
        if (agent?.agent_status !== "blocked") {
          await removeButtons();
          await this.telegram.send(this.chatId, `⚠️ ${this.herdrWatcher.label(action.paneId)} is no longer waiting (${agent?.agent_status || "gone"}); nothing sent.`);
          return this.telegram.answer(callback.id, "Not waiting");
        }
        await this.herdrWatcher.cli(["agent", "send-keys", action.paneId, ...action.keys]);
        await removeButtons();
        await sleep(1500);
        const after = (await this.herdrWatcher.cliJson(["agent", "get", action.paneId]).catch(() => null))?.agent?.agent_status || "unknown";
        await this.telegram.send(this.chatId, `➡️ ${action.label} → ${this.herdrWatcher.label(action.paneId)} · now ${HERDR_STATUS_ICON[after] || ""} ${after}`, { disable_notification: true });
      } else if (action.type === "ui") {
        // ref: Telegram Bot API callback single consumption (https://core.telegram.org/bots/api#callbackquery)
        for (const [k, v] of this.actions) {
          if (v.type === "ui" && v.requestId === action.requestId) this.actions.delete(k);
        }
        this.pi.write({ type: "extension_ui_response", id: action.requestId, ...action.response });
        if (callback.message) {
          const chosen = action.response?.value ?? (action.response?.confirmed ? "Confirm" : "Cancel");
          await this.telegram.edit(callback.message.chat.id, callback.message.message_id, `${callback.message.text}\n\n✅ ${chosen}`).catch(() => {});
        }
      }
      await this.telegram.answer(callback.id, "Done");
    } catch (error) {
      await this.telegram.answer(callback.id, "Failed");
      await this.telegram.send(this.chatId, `❌ ${error.message}`);
    } finally {
      console.log(`${new Date().toISOString()} [callback] ${action.type} finished in ${Math.round(performance.now() - t0)}ms`);
    }
  }

  async switchCwd(path, callbackId) {
    const reply = callbackId
      ? (text) => this.telegram.answer(callbackId, text)
      : (text) => this.telegram.send(this.chatId, text);
    let target, targetStat;
    try {
      target = await realpath(path);
      targetStat = await stat(target);
    } catch {
      await reply(`Directory missing or inaccessible: ${path}`);
      return;
    }
    if (!targetStat.isDirectory()) {
      await reply(`Not a valid directory: ${path}`);
      return;
    }
    if (target === this.config.cwd) {
      await reply("Already in this directory");
      return;
    }

    await this.saveState({
      cwd: target,
      recentProjects: [target, ...(this.state.recentProjects || []).filter((p) => p !== target)].slice(0, 20),
    });

    await reply("Switching");
    await this.telegram.send(this.chatId, `✅ Working directory switched to:\n${target}\n\nHot-restarting Pi…`);
    this.pi.stop();
    this.config.cwd = target;
    this.config.sessionDir = resolveSessionDir(this.config.stateDir, target);
    await mkdir(this.config.sessionDir, { recursive: true, mode: 0o700 });
    this.resetSessionState();
    this.pi = new PiRpc(this.config, (event) => this.queueEvent(event), (exit) => this.handlePiExit(exit));
    await this.pi.start();
    await this.registerBotCommands();
    const state = await this.pi.request("get_state");
    if (state?.model?.provider && state?.model?.id) {
      this.lastModel = { provider: state.model.provider, modelId: state.model.id };
    }
    await this.telegram.send(this.chatId, `✅ Pi ready; Session: ${state.sessionId}`);
  }

  async handleEvent(event) {
    if (event.type === "agent_start") {
      this.isStreaming = true;
      this.pendingUi = null;
      this.repliedInRun = false;
      this.abortedRun = false;
      this.startTyping();
      if (this.toolPanel?.timer) clearTimeout(this.toolPanel.timer);
      this.toolPanel = null;
      const since = this.runStartedAt ? ` (+${Math.round(performance.now() - this.runStartedAt)}ms)` : "";
      console.log(`${new Date().toISOString()} [run] agent_start${since}`);
    }
    if (event.type === "agent_settled") {
      this.isStreaming = false;
      this.pendingUi = null;
      this.stopTyping();
      const since = this.runStartedAt ? ` (total: ${Math.round(performance.now() - this.runStartedAt)}ms)` : "";
      console.log(`${new Date().toISOString()} [run] agent_settled${since}`);
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
        this.queueTelegram(() => this.finishDraft(draft));
      }
      // ref: Pi RPC settled lifecycle (https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md)
      if (!this.repliedInRun && !this.abortedRun) {
        this.queueTelegram(() => this.telegram.send(this.chatId, "⚠️ The model returned no text reply. Use /model to switch models or retry."));
      }
      this.abortedRun = false;
      this.settleActiveReactions();
      this.runStartedAt = null;
      this.runFirstTokenAt = null;
      this.runFirstUiAt = null;
    }
    if (event.type === "queue_update") this.queue = { steering: event.steering, followUp: event.followUp };
    if (!this.chatReady) return;

    if (event.type === "auto_retry_start") {
      await this.telegram.send(this.chatId, `⏳ Model error; auto-retrying (${event.attempt}/${event.maxAttempts})…`);
    }
    if (event.type === "compaction_end" && event.errorMessage) {
      await this.telegram.send(this.chatId, `⚠️ Context compaction failed: ${event.errorMessage}`);
    }

    if (event.type === "message_start" && event.message?.role === "assistant") {
      this.draft = { text: "", messageId: null, timer: null, closed: false };
    }
    if (event.type === "message_update") {
      const update = event.assistantMessageEvent;
      if (update?.type === "text_delta" && this.draft) {
        if (!this.runFirstTokenAt) {
          this.runFirstTokenAt = performance.now();
          const ttft = this.runStartedAt ? ` (TTFT: ${Math.round(this.runFirstTokenAt - this.runStartedAt)}ms)` : "";
          console.log(`${new Date().toISOString()} [run] first token received${ttft}`);
        }
        this.draft.text += update.delta;
        if (!this.draft.timer) {
          const draft = this.draft;
          draft.timer = setTimeout(() => {
            draft.timer = null;
            // 合并：链上同一草稿最多挂一个待执行刷新，执行时读最新文本，防链阻塞时堆积
            if (draft.flushQueued) return;
            draft.flushQueued = true;
            this.queueTelegram(() => {
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
      }
      const outTok = event.message.usage?.output;
      console.log(`${new Date().toISOString()} [run] message_end (${outTok ? `${outTok} tokens` : "assistant"}${event.message.stopReason ? `, reason: ${event.message.stopReason}` : ""})`);
      if (draft.text) {
        this.repliedInRun = true;
        this.queueTelegram(() => this.finishDraft(draft));
      }
    }

    if (event.type === "tool_execution_start") {
      if (!this.toolPanel) this.toolPanel = { messageId: null, tools: [], timer: null, sending: false };
      const summary = toolSummary(event.toolName, event.args);
      console.log(`${new Date().toISOString()} [tool] start: ${summary}`);
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
        console.log(`${new Date().toISOString()} [tool] end: ${event.toolName} (${event.isError ? "error" : "done"}, took ${dur})`);
        this.scheduleToolPanelUpdate(false, false);
      }
      if ((event.toolName === "remote_attach" || event.toolName === "telegram_attach") && !event.isError) {
        const paths = event.result?.details?.paths || event.args?.paths || [];
        for (const path of paths) {
          this.queueUpload(async () => {
            try { await this.telegram.sendDocument(this.chatId, path); }
            catch (error) { await this.telegram.send(this.chatId, `❌ Failed to send attachment ${basename(path)}: ${error.message}`); }
          });
        }
      }
    }
    if (event.type === "extension_ui_request") await this.handleUiRequest(event);
    if (event.type === "extension_error") await this.telegram.send(this.chatId, `❌ Extension ${event.extensionPath}: ${event.error}`);
  }

  scheduleToolPanelUpdate(force = false, isSettled = false) {
    if (!this.toolPanel) return;
    if (force) {
      if (this.toolPanel.timer) {
        clearTimeout(this.toolPanel.timer);
        this.toolPanel.timer = null;
      }
      this.queueTelegram(() => this.flushToolPanel(isSettled));
      return;
    }
    if (!this.toolPanel.messageId && !this.toolPanel.sending) {
      this.toolPanel.sending = true;
      this.queueTelegram(() => this.flushToolPanel(false));
      return;
    }
    if (!this.toolPanel.timer) {
      this.toolPanel.timer = setTimeout(() => {
        if (this.toolPanel) {
          this.toolPanel.timer = null;
          this.queueTelegram(() => this.flushToolPanel(false));
        }
      }, 1200);
    }
  }

  async flushToolPanel(isSettled = false) {
    if (!this.toolPanel || !this.toolPanel.tools.length) return;
    const text = renderToolPanel(this.toolPanel.tools, isSettled);
    if (!text) return;
    const t0 = performance.now();
    try {
      if (this.toolPanel.messageId) {
        await this.telegram.edit(this.chatId, this.toolPanel.messageId, text);
      } else {
        const sent = await this.telegram.sendOne(this.chatId, text, { disable_notification: true });
        if (this.toolPanel) this.toolPanel.messageId = sent.message_id;
        if (!this.runFirstUiAt && this.runStartedAt) {
          this.runFirstUiAt = performance.now();
          console.log(`${new Date().toISOString()} [ui] first tool panel visible (TTFE: ${Math.round(this.runFirstUiAt - this.runStartedAt)}ms, send took ${Math.round(performance.now() - t0)}ms)`);
        }
      }
    } finally {
      if (this.toolPanel) this.toolPanel.sending = false;
    }
  }

  // ref: OpenClaw PR #40013 - avoid DM duplicate flash by using sendMessage + editMessageText in-place (https://github.com/openclaw/openclaw/pull/40013)
  async flushDraft(draft) {
    if (!draft.text || draft.flushing || draft.closed) return;
    if (this.telegram.retryNotBefore > Date.now()) return; // 429 冷却中
    draft.flushing = true;
    const t0 = performance.now();
    try {
      const text = previewText(draft.text);
      if (text === draft.sentPreview) return; // 去重：内容未变跳过更新
      if (draft.messageId) {
        await this.telegram.edit(this.chatId, draft.messageId, text, true);
      } else {
        const sent = await this.telegram.sendOne(this.chatId, text, { disable_notification: true });
        draft.messageId = sent.message_id;
      }
      draft.sentPreview = text;
      this.logFirstUi(t0, "edit");
    } catch (error) {
      console.error(`${new Date().toISOString()} [ui] preview update failed:`, error.message);
    } finally {
      draft.flushing = false;
    }
  }

  logFirstUi(t0, mode) {
    if (!this.runFirstUiAt && this.runStartedAt) {
      this.runFirstUiAt = performance.now();
      const ttfe = Math.round(this.runFirstUiAt - this.runStartedAt);
      const api = Math.round(performance.now() - t0);
      console.log(`${new Date().toISOString()} [ui] first preview visible (TTFE: ${ttfe}ms, api took ${api}ms, mode: ${mode})`);
    }
  }

  async finishDraft(draft) {
    if (!draft.text) return;
    draft.closed = true;
    const t0 = performance.now();
    try {
      const parts = chunks(draft.text);
      if (draft.messageId) {
        // 原地更新首段为最终内容，重试保证交付；同一条消息无重复对话框与残留
        await this.telegram.edit(this.chatId, draft.messageId, parts[0], false);
        for (let i = 1; i < parts.length; i++) {
          await this.telegram.sendOne(this.chatId, parts[i]);
        }
      } else {
        for (const part of parts) {
          await this.telegram.sendOne(this.chatId, part);
        }
      }
      const apiMs = Math.round(performance.now() - t0);
      const turnMs = this.runStartedAt ? ` (total turn: ${Math.round(performance.now() - this.runStartedAt)}ms)` : "";
      console.log(`${new Date().toISOString()} [ui] final reply sent (${parts.length} parts, took ${apiMs}ms)${turnMs}`);
    } catch (error) {
      console.error(`${new Date().toISOString()} [ui] final reply delivery failed:`, error.message);
      const copy = join(this.config.stateDir, `failed-reply-${Date.now()}.txt`);
      await writeFile(copy, draft.text).catch(() => {});
      await this.telegram.send(this.chatId, `❌ Reply delivery failed: ${error.message}\nContent saved to: ${copy}`).catch(() => {});
    }
  }

  async handleUiRequest(request) {
    if (["select", "confirm"].includes(request.method)) {
      const options = request.method === "confirm" ? [
        { label: "Confirm", response: { confirmed: true } }, { label: "Cancel", response: { confirmed: false } },
      ] : request.options.map((value) => ({ label: value, response: { value } }));
      await this.telegram.send(this.chatId, [request.title, request.message].filter(Boolean).join("\n"), this.keyboard(options.map((option) => ({
        label: option.label, action: { type: "ui", requestId: request.id, response: option.response },
      }))));
    } else if (["input", "editor"].includes(request.method)) {
      this.pendingUi = request;
      await this.telegram.send(this.chatId, [request.title, request.placeholder || request.prefill].filter(Boolean).join("\n"));
    } else if (request.method === "notify") {
      await this.telegram.send(this.chatId, request.message);
    }
  }

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
    });
  }

  stop() {
    this.resetSessionState();
    this.telegram?.stopPolling?.();
    this.telegram?.stopWakeMonitor?.();
    this.herdrWatcher?.stop();
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
    this.pi.stop();
  }
}

async function selfTest() {
  assert.deepEqual(parseCommand("/model openai/gpt-5"), { name: "model", argument: "openai/gpt-5" });
  assert.deepEqual(parseCommand("/help@my_bot"), { name: "help", argument: "" });
  assert.deepEqual(parseCommand("/sh ls -la"), { name: "sh", argument: "ls -la" });
  assert.deepEqual(parseCommand("/get README.md"), { name: "get", argument: "README.md" });
  assert.deepEqual(parseCommand("/followup check tests"), { name: "followup", argument: "check tests" });
  assert.equal(parseCommand("hello"), null);
  assert.ok(buildDevPath("/usr/bin:/bin").includes("/opt/homebrew/bin"));
  assert.ok(buildDevPath("/usr/bin:/bin").includes(join(homedir(), ".local", "bin")));
  assert.equal(await runCommand("echo", ["ok"]), "ok");
  assert.deepEqual(await resolveHerdrEnvironment(tmpdir(), { piBin: "echo" }), {});
  assert.deepEqual(await resolveHerdrEnvironment(tmpdir(), { disabled: true }), {});
  assert.equal(telegramCommandName({ name: "skill:grill-me", source: "skill" }), "skill_grill_me");
  assert.equal(telegramCommandName({ name: `skill:${"a".repeat(40)}`, source: "skill" }).length, 32);
  assert.equal(telegramCommandName({ name: "git-commit-push", source: "extension" }), "git_commit_push");

  // HTML format checks (markdown-it renderer)
  assert.equal(telegramHtml("### Status!\n- **ready** and `a_b`"), "<b>Status!</b>\n\n• <b>ready</b> and <code>a_b</code>");
  assert.equal(telegramHtml("```js\na_b();\n```"), '<pre><code class="language-js">a_b();</code></pre>');
  assert.equal(telegramHtml("| A | B |\n|---|---|\n| 1 | 2 |"), "<b>A · B</b>\n• 1 — 2");
  assert.equal(
    telegramHtml(expandableBlockquote("line 1\nline 2")),
    "<blockquote expandable>line 1\nline 2</blockquote>"
  );
  assert.equal(telegramHtml("> quote 1\n> quote 2"), "<blockquote>quote 1\nquote 2</blockquote>");
  assert.equal(telegramHtml("✨ fresh.\n\n◆ Model: m"), "✨ fresh.\n◆ Model: m");
  assert.equal(telegramHtml("**`code`**"), "<b><code>code</code></b>");
  assert.equal(
    telegramHtml("- a\n  - nested\n\n1. first\n2. second"),
    "• a\n  • nested\n\n1. first\n2. second"
  );
  assert.equal(telegramHtml("nested **bold _inner_ end**"), "nested <b>bold <i>inner</i> end</b>");
  assert.equal(telegramHtml("A & B < C > D"), "A &amp; B &lt; C &gt; D");
  assert.equal(
    telegramHtml("[link](https://example.com) and https://t.me"),
    '<a href="https://example.com">link</a> and <a href="https://t.me">https://t.me</a>'
  );

  assert.ok(formatAssistantError("Codex error: The usage limit has been reached").includes("quota is exhausted"));
  assert.ok(formatAssistantError("Rate limit exceeded").includes("rate limit"));
  assert.equal(formatAssistantError("Network failure"), "❌ Network failure");
  assert.equal(retryableTelegramStatus(429), true);
  assert.equal(retryableTelegramStatus(500), true);
  assert.equal(retryableTelegramStatus(400), false);

  const original = "a".repeat(8000) + "🎉";
  assert.equal(chunks(original).join(""), original);
  assert.ok(chunks(original).every((part) => [...part].length <= MAX_MESSAGE));
  const fenced = "```js\n" + "const a = 1;\n".repeat(10) + "```";
  const fencedChunks = chunks(fenced, 60);
  assert.ok(fencedChunks.length > 1);
  assert.ok(fencedChunks[0].endsWith("```"));
  assert.ok(fencedChunks[1].startsWith("```js\n"));

  assert.equal(extractText([{ type: "text", text: "hi" }, { type: "toolCall", name: "read", arguments: { path: "x" } }]), "hi");
  assert.equal(toolSummary("bash", { command: "git status" }), "bash: git status");
  assert.equal(toolSummary("read", { path: "foo.txt" }), "read: foo.txt");
  assert.ok(renderToolPanel([{ summary: "bash: git status", status: "running" }]).includes("⏳"));
  assert.ok(renderToolPanel([{ summary: "bash: git status", status: "running" }]).includes("```expandable"), "单工具也应使用折叠块，避免中途跳变");
  assert.ok(renderToolPanel([{ summary: "bash: git status", status: "done" }], true).includes("✅ 1 tool call(s) done"));

  assert.equal(formatContextTokens(1048576), "1.0M");
  assert.equal(formatContextTokens(128000), "128K");
  assert.equal(formatContextTokens(8192), "8K");
  assert.equal(formatContextTokens(500), "500");
  assert.equal(extensionFromMime("audio/ogg"), ".ogg");
  assert.equal(extensionFromMime("weird/type"), "");
  assert.ok(attachmentPrompt("check this", [{ path: "/tmp/a b.txt" }]).includes("- /tmp/a b.txt"));
  assert.equal(previewText("ab"), "ab");
  assert.ok(previewText("x".repeat(5000)).endsWith("*(output truncated, still streaming…)*"));
  assert.ok(previewText("x".repeat(5000)).length <= MAX_MESSAGE + 60);
  assert.equal(await runStt("printf %s $1", "/tmp/audio.ogg"), "/tmp/audio.ogg");

  {
    const gw = new Gateway({ allowedUserId: "1", botToken: "1:x", stateDir: tmpdir() });
    const sendOneCalls = [];
    const editCalls = [];
    gw.telegram.sendOne = async (_chat, text, extra = {}) => {
      sendOneCalls.push({ text, extra });
      return { message_id: 123 };
    };
    gw.telegram.edit = async (_chat, messageId, text, ephemeral = false) => {
      editCalls.push({ messageId, text, ephemeral });
      return true;
    };

    // 1. 初次流式刷新发送静音消息
    const draft = { text: "hello", flushing: false, messageId: null, sentPreview: "" };
    await gw.flushDraft(draft);
    assert.equal(draft.messageId, 123);
    assert.equal(sendOneCalls.length, 1);
    assert.equal(sendOneCalls[0].extra.disable_notification, true);
    assert.equal(editCalls.length, 0);

    // 2. 后续流式刷新原地编辑同一消息
    draft.text = "hello world";
    await gw.flushDraft(draft);
    assert.equal(editCalls.length, 1);
    assert.equal(editCalls[0].messageId, 123);
    assert.equal(editCalls[0].text, "hello world");
    assert.equal(editCalls[0].ephemeral, true);

    // 3. 预览内容不变时跳过重复编辑
    await gw.flushDraft(draft);
    assert.equal(editCalls.length, 1);

    // 4. 原地交付最终回复：首段 edit，无多余 sendOne
    await gw.finishDraft(draft);
    assert.equal(editCalls.length, 2);
    assert.equal(editCalls[1].messageId, 123);
    assert.equal(editCalls[1].text, "hello world");
    assert.equal(editCalls[1].ephemeral, false);
    assert.equal(sendOneCalls.length, 1);

    // 5. closed 拦截过期刷新
    await gw.flushDraft({ text: "stale", closed: true });
    assert.equal(editCalls.length, 2);

    // 6. 未曾触发流式（无 messageId），finishDraft 直接 sendOne 交付
    const unstreamed = { text: "direct send", messageId: null };
    await gw.finishDraft(unstreamed);
    assert.equal(sendOneCalls.length, 2);
    assert.equal(sendOneCalls[1].text, "direct send");

    // 回归：最终交付失败时文本落盘为可恢复副本
    {
      const tmpUi = join(tmpdir(), `test-remote-pi-ui-${Date.now()}`);
      await mkdir(tmpUi, { recursive: true, mode: 0o700 });
      const gwFail = new Gateway({ allowedUserId: "1", botToken: "1:x", stateDir: tmpUi });
      gwFail.telegram.sendOne = async () => { throw new Error("network down"); };
      await gwFail.finishDraft({ text: "recover me", messageId: null, draftId: null });
      const copies = (await readdir(tmpUi)).filter((f) => f.startsWith("failed-reply-"));
      assert.equal(copies.length, 1);
      assert.equal(await readFile(join(tmpUi, copies[0]), "utf8"), "recover me");
    }

    // Test remote_attach / telegram_attach auto delivery via tool_execution_end
    gw.chatReady = true;
    const docs = [];
    gw.telegram.sendDocument = async (_chat, path) => docs.push(path);
    await gw.handleEvent({
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "remote_attach",
      isError: false,
      result: { details: { paths: ["/tmp/file1.png", "/tmp/file2.pdf"] } },
    });
    await gw.handleEvent({
      type: "tool_execution_end",
      toolCallId: "call-2",
      toolName: "telegram_attach",
      isError: false,
      result: { details: { paths: ["/tmp/file3.txt"] } },
    });
    await Promise.all([gw.telegramChain, gw.uploadChain]);
    assert.deepEqual(docs, ["/tmp/file1.png", "/tmp/file2.pdf", "/tmp/file3.txt"]);

    // Test priority command classification and preemptive dispatch
    assert.equal(getUpdatePriority({ stopped_message_generation: true }), "p0");
    assert.equal(getUpdatePriority({ message: { text: "/abort" } }), "p0");
    assert.equal(getUpdatePriority({ message: { text: "/abort clear" } }), "p0");
    assert.equal(getUpdatePriority({ message: { text: "/new" } }), "p0");
    assert.equal(getUpdatePriority({ message: { text: "/reset" } }), "p0");
    assert.equal(getUpdatePriority({ message: { text: "/restart" } }), "p0");
    assert.equal(getUpdatePriority({ message: { text: "/status" } }), "p1");
    assert.equal(getUpdatePriority({ message: { text: "/session" } }), "p1");
    assert.equal(getUpdatePriority({ message: { text: "/queue" } }), "p1");
    assert.equal(getUpdatePriority({ message: { text: "/help" } }), "p1");
    assert.equal(getUpdatePriority({ message: { text: "/commands" } }), "p1");
    assert.equal(getUpdatePriority({ message: { text: "/sh cargo build" } }), "p2");
    assert.equal(getUpdatePriority({ message: { text: "hello" } }), "p2");

    let p2Started = false;
    let p2Finished = false;
    let p0Executed = false;
    gw.handleUpdate = async () => {
      p2Started = true;
      await sleep(100);
      p2Finished = true;
    };
    gw.handlePriorityUpdate = async () => {
      p0Executed = true;
    };

    // Dispatch slow P2 update, followed immediately by P0
    gw.dispatchUpdate({ message: { text: "/sh sleep 10" } });
    await sleep(5);
    assert.equal(p2Started, true);
    assert.equal(p2Finished, false);

    // P0 should execute immediately without waiting for P2 to finish
    gw.dispatchUpdate({ message: { text: "/abort" } });
    assert.equal(p0Executed, true);
    assert.equal(p2Finished, false);

    await gw.updateChain;
    assert.equal(p2Finished, true);

    // Test outbound queue re-entrancy and serialization
    const sendOrder = [];
    gw.telegram.sendOne = async (_chat, text) => {
      sendOrder.push(text);
      return { message_id: 1 };
    };
    await gw.queueTelegram(async () => {
      sendOrder.push("outer-start");
      await gw.telegram.send("1", "nested");
      sendOrder.push("outer-end");
    });
    assert.deepEqual(sendOrder, ["outer-start", "nested", "outer-end"]);

    // 回归（审计修复 M1）：missedPings 随 Pi 重启复位，余数不误杀新进程
    {
      const rpc = new PiRpc({ piBin: "echo", sessionDir: tmpdir() }, () => {});
      rpc.missedPings = 2;
      await rpc.start();
      assert.equal(rpc.missedPings, 0);
    }

    // 回归（审计修复 M2）：预览更新失败不再静默，必须留错误日志
    {
      const errs = [];
      const origError = console.error;
      console.error = (...a) => errs.push(a.map(String).join(" "));
      const prevSendOne = gw.telegram.sendOne;
      gw.telegram.sendOne = async () => { throw new Error("preview boom"); };
      await gw.flushDraft({ text: "boom draft", flushing: false, messageId: null });
      console.error = origError;
      gw.telegram.sendOne = prevSendOne;
      assert.ok(errs.some((e) => e.includes("preview update failed")), "flushDraft 失败应留日志");
    }

    // 回归（审计修复 L4）：handleUpdate 不再含 stopped_message_generation 死分支（p0 必然先拦截）
    {
      const calls = [];
      gw.pi.proc = {};
      gw.pi.request = async (type) => { calls.push(type); return {}; };
      await gw.handleUpdate({ stopped_message_generation: true, update_id: 424242 });
      assert.deepEqual(calls, [], "handleUpdate 不应再处理 stopped_message_generation");
      gw.pi.proc = undefined;
    }

    // Test /new preserves last effective model
    let mockModel = { provider: "openai", id: "gpt-4o" };
    const mockRequests = [];
    gw.pi.proc = {};
    gw.pi.request = async (command, params) => {
      mockRequests.push({ command, params });
      if (command === "get_state") return { model: mockModel };
      if (command === "new_session") {
        mockModel = { provider: "anthropic", id: "claude-3-7-sonnet" };
        return { cancelled: false };
      }
      if (command === "set_model") {
        mockModel = { provider: params.provider, id: params.modelId };
        return mockModel;
      }
      return {};
    };
    let newSessionSent = "";
    gw.telegram.send = async (_chat, text) => { newSessionSent = text; };
    await gw.handleCommand({ name: "new", argument: "" });
    assert.deepEqual(mockRequests.find((r) => r.command === "set_model"), {
      command: "set_model",
      params: { provider: "openai", modelId: "gpt-4o" },
    });
    assert.ok(newSessionSent.includes("◆ Model: gpt-4o"));
    assert.deepEqual(gw.lastModel, { provider: "openai", modelId: "gpt-4o" });
  }

  assert.equal(
    formatSessionReset({
      model: {
        id: "gemini-3.8-flash",
        provider: "antigravity",
        contextWindow: 1048576,
        baseUrl: "http://127.0.0.1:51122/v1",
      },
      cwd: "/Users/user/dev/remote-pi",
    }),
    [
      "✨ Session reset! Starting fresh.",
      "",
      "◆ Model: gemini-3.8-flash",
      "◆ Provider: antigravity",
      "◆ Context: 1.0M tokens (detected)",
      "◆ Endpoint: http://127.0.0.1:51122/v1",
      "◆ CWD: /Users/user/dev/remote-pi",
    ].join("\n")
  );

  // Open-source configuration tests
  {
    assert.equal(resolvePath("~/foo"), join(homedir(), "foo"));
    assert.equal(resolvePath("bar", "/tmp"), "/tmp/bar");
    assert.equal(resolvePath("", "/tmp"), "");

    // loadConfig with test configs
    const tmpCfgDir = join(tmpdir(), `test-cfg-${Date.now()}`);
    await mkdir(tmpCfgDir, { recursive: true });
    const dummyExt = join(tmpCfgDir, "my-ext.js");
    writeFileSync(dummyExt, "// dummy extension");

    const validCfgPath = join(tmpCfgDir, "config.json");
    writeFileSync(
      validCfgPath,
      JSON.stringify({
        telegram: { botToken: "123456:abcdef", allowedUserId: "999" },
        cwd: tmpCfgDir,
        stateDir: tmpCfgDir,
        extensions: ["./my-ext.js"],
        enableCompanionExtension: false,
      })
    );

    const prevEnvCfg = process.env.REMOTE_PI_CONFIG;
    process.env.REMOTE_PI_CONFIG = validCfgPath;
    try {
      const cfg = loadConfig();
      assert.equal(cfg.botToken, "123456:abcdef");
      assert.equal(cfg.allowedUserId, "999");
      assert.equal(cfg.cwd, tmpCfgDir);
      assert.deepEqual(cfg.extensions, [dummyExt]);
      assert.equal(cfg.enableCompanionExtension, false);
    } finally {
      if (prevEnvCfg) process.env.REMOTE_PI_CONFIG = prevEnvCfg;
      else delete process.env.REMOTE_PI_CONFIG;
    }

    // verify loadConfig throws when configured extension is missing
    const invalidExtCfgPath = join(tmpCfgDir, "invalid-ext.json");
    writeFileSync(
      invalidExtCfgPath,
      JSON.stringify({
        telegram: { botToken: "123456:abcdef", allowedUserId: "999" },
        cwd: tmpCfgDir,
        extensions: ["./non-existent-ext.js"],
      })
    );
    process.env.REMOTE_PI_CONFIG = invalidExtCfgPath;
    try {
      assert.throws(() => loadConfig(), /Configured extension not found/);
    } finally {
      if (prevEnvCfg) process.env.REMOTE_PI_CONFIG = prevEnvCfg;
      else delete process.env.REMOTE_PI_CONFIG;
    }

    // verify loadConfig throws when cwd is missing (required, no fallback)
    const emptyStateDir = join(tmpCfgDir, `empty-state-${Date.now()}`);
    await mkdir(emptyStateDir, { recursive: true });
    const noCwdCfgPath = join(tmpCfgDir, "no-cwd.json");
    writeFileSync(
      noCwdCfgPath,
      JSON.stringify({
        telegram: { botToken: "123456:abcdef", allowedUserId: "999" },
        stateDir: emptyStateDir,
      })
    );
    process.env.REMOTE_PI_CONFIG = noCwdCfgPath;
    try {
      assert.throws(() => loadConfig(), /"cwd" is required/);
    } finally {
      if (prevEnvCfg) process.env.REMOTE_PI_CONFIG = prevEnvCfg;
      else delete process.env.REMOTE_PI_CONFIG;
    }

    // verify showCwds guides usage when history is empty
    const gwNoHistory = new Gateway({ allowedUserId: "1", botToken: "1:x", stateDir: tmpCfgDir, cwd: tmpCfgDir });
    let sentMsg = "";
    gwNoHistory.telegram.send = async (_chat, text) => { sentMsg = text; };
    await gwNoHistory.showCwds();
    assert.ok(sentMsg.includes("No recent projects yet"), "showCwds should guide usage when history is empty");

    // verify switchCwd reports error for nonexistent dir and keeps cwd
    const gwSwitch = new Gateway({ allowedUserId: "1", botToken: "1:x", stateDir: tmpCfgDir, cwd: tmpCfgDir });
    let switchMsg = "";
    gwSwitch.telegram.send = async (_chat, text) => { switchMsg = text; };
    await gwSwitch.switchCwd(join(tmpCfgDir, "no-such-dir"), null);
    assert.ok(switchMsg.includes("Directory missing"), "switchCwd should report error for missing dir");
    assert.equal(gwSwitch.config.cwd, tmpCfgDir);

    // verify resolveSessionDir collision resistance and legacy fallback
    const dirA = resolveSessionDir(tmpCfgDir, "/a/b-c");
    const dirB = resolveSessionDir(tmpCfgDir, "/a-b/c");
    assert.notEqual(dirA, dirB, "resolveSessionDir must not collide on /a/b-c and /a-b/c");

    const legacyDir = join(tmpCfgDir, "sessions", "legacy-project");
    await mkdir(legacyDir, { recursive: true });
    assert.equal(resolveSessionDir(tmpCfgDir, "/legacy/project"), legacyDir, "resolveSessionDir should preserve legacy dir if it exists");

    // verify state persistence without modifying config.json
    const originalCfgContent = readFileSync(validCfgPath, "utf8");
    const gwState = new Gateway({
      allowedUserId: "999",
      botToken: "123456:abcdef",
      configPath: validCfgPath,
      stateDir: tmpCfgDir,
      cwd: tmpCfgDir,
    });
    await gwState.saveState({ cwd: "/target/path", recentProjects: ["/target/path", tmpCfgDir] });
    assert.equal(readFileSync(validCfgPath, "utf8"), originalCfgContent, "config.json must remain immutable");
    const loaded = loadState(tmpCfgDir);
    assert.equal(loaded.cwd, "/target/path");
    assert.deepEqual(loaded.recentProjects, [tmpCfgDir]); // only existing dirs filtered
  }

  {
    const tg = new Telegram("123456:fake-token", "/tmp/fake-offset");
    const calls = [];
    tg.call = async (method, body) => { calls.push({ method, body }); return true; };
    await tg.setReaction(123, 456, "🫡");
    assert.deepEqual(calls[0], {
      method: "setMessageReaction",
      body: { chat_id: 123, message_id: 456, reaction: [{ type: "emoji", emoji: "🫡" }] },
    });
    assert.equal(await tg.setReaction(123, 0, "🫡"), null);
    assert.equal(calls.length, 1);
  }

  {
    const tmpState = join(tmpdir(), `test-remote-pi-lock-${Date.now()}`);
    await mkdir(tmpState, { recursive: true, mode: 0o700 });

    const gw1 = { config: { stateDir: tmpState }, pidFile: null, lockServer: null, sockPath: null };
    gw1.acquireLock = Gateway.prototype.acquireLock.bind(gw1);
    gw1.stop = Gateway.prototype.stop.bind(gw1);
    gw1.resetSessionState = () => {};
    gw1.pi = { stop: () => {} };

    await gw1.acquireLock();
    assert.equal(existsSync(gw1.sockPath), true);
    assert.equal(readFileSync(gw1.pidFile, "utf8").trim(), String(process.pid));

    const gw2 = { config: { stateDir: tmpState }, pidFile: null, lockServer: null, sockPath: null };
    gw2.acquireLock = Gateway.prototype.acquireLock.bind(gw2);
    gw2.stop = Gateway.prototype.stop.bind(gw2);
    gw2.resetSessionState = () => {};
    gw2.pi = { stop: () => {} };

    await assert.rejects(() => gw2.acquireLock(), /Another gateway is already running/);

    gw1.stop();
    assert.equal(existsSync(gw1.sockPath), false);
    assert.equal(existsSync(gw1.pidFile), false);

    // Stale socket recovery (simulate crashed process leaving file behind)
    writeFileSync(join(tmpState, "gateway.sock"), "stale");
    await gw2.acquireLock();
    assert.equal(existsSync(gw2.sockPath), true);
    gw2.stop();
  }

  {
    // offset at-least-once：handler 返回 promise（p2），处理完才落盘；p0/p1（返回 undefined）不落盘
    const tmpOffset = join(tmpdir(), `test-remote-pi-offset-${Date.now()}`);
    await mkdir(tmpOffset, { recursive: true, mode: 0o700 });
    const tg = new Telegram("123456:fake-token", join(tmpOffset, "offset"));
    let release;
    const gate = new Promise((r) => { release = r; });
    let pollCount = 0;
    tg.call = async (method) => {
      if (method !== "getUpdates") return true;
      if (pollCount++ === 0) return [{ update_id: 7 }];
      return new Promise(() => {}); // 挂起后续轮询，不占用事件循环
    };
    const handled = [];
    tg.poll((update) => {
      handled.push(update.update_id);
      return gate;
    });
    // 回归（架构审查 Issue 1）：/restart 重启收据与防死循环重放
    {
      const tmpState = join(tmpdir(), `test-remote-pi-restart-${Date.now()}`);
      await mkdir(tmpState, { recursive: true, mode: 0o700 });
      const gwRestart = new Gateway({ allowedUserId: "1", botToken: "1:x", stateDir: tmpState });
      gwRestart.stop = () => {};
      gwRestart.telegram.setReaction = async () => {};
      let sentMsg = "";
      gwRestart.telegram.send = async (_c, text) => { sentMsg = text; };
      let origExit = process.exit;
      process.exit = () => {};

      // 首次 /restart：应落盘收据并发送提示
      await gwRestart.handlePriorityUpdate({ message: { message_id: 10, text: "/restart", from: { id: 1 }, chat: { type: "private" } }, update_id: 888 }, "p0");
      assert.ok(sentMsg.includes("Restarting gateway"));
      assert.equal(await readFile(join(tmpState, "last-restart-update"), "utf8"), "888");

      // 重复投递相同的 update_id：应静默忽略，不再重复执行
      sentMsg = "";
      await gwRestart.handlePriorityUpdate({ message: { message_id: 10, text: "/restart", from: { id: 1 }, chat: { type: "private" } }, update_id: 888 }, "p0");
      assert.equal(sentMsg, "");
      await sleep(150); // 等待 restart 的 100ms exit 定时器被空函数消耗
      process.exit = origExit;
    }

    // 回归（架构审查 Issue 2）：PiRpc 进程异常退出通知 Gateway 并重置就绪
    {
      let exitedInfo = null;
      const rpc = new PiRpc({ piBin: "echo", sessionDir: tmpdir() }, () => {}, (info) => { exitedInfo = info; });
      await rpc.start();
      rpc.proc.kill("SIGTERM");
      await sleep(100);
      assert.ok(exitedInfo !== null, "Pi 退出应触发 onClose 回调");
      assert.equal(exitedInfo.expected, false);

      const gwExit = new Gateway({ allowedUserId: "1", botToken: "1:x", stateDir: tmpdir() });
      gwExit.isStreaming = true;
      let exitNotice = "";
      gwExit.telegram.send = async (_c, text) => { exitNotice = text; };
      gwExit.handlePiExit({ code: 1, signal: null, expected: false });
      assert.equal(gwExit.isStreaming, false, "异常退出后 isStreaming 必须重置为 false");
      await gwExit.telegramChain;
      assert.ok(exitNotice.includes("exited unexpectedly"), "异常退出必须向用户告警");
    }

    // 回归（架构审查 Issue 3）：HTML 解析与长度超限时降级为分段纯文本
    {
      const tgLimit = new Telegram("1:x", "/tmp/fake-offset");
      let calls = [];
      tgLimit.call = async (method, body) => {
        calls.push({ method, body });
        if (body.parse_mode === "HTML") throw new Error("Telegram sendMessage: Bad Request: message is too long");
        return { message_id: 99 };
      };
      const longText = "x".repeat(5000);
      const res = await tgLimit.sendOne(1, longText);
      assert.equal(res.message_id, 99);
      // 超长纯文本被切片为 <=4000 的纯文本分段调用
      assert.ok(calls.length >= 2);
      assert.ok(calls.every((c) => !c.body.parse_mode || c.body.parse_mode === "HTML"));
    }

    // 回归（架构审查 Issue 4）：MediaGroup 延迟聚合占位并保证后续文本时序
    {
      const gwMedia = new Gateway({ allowedUserId: "1", botToken: "1:x", stateDir: tmpdir() });
      gwMedia.chatReady = true;
      gwMedia.telegram.setReaction = async () => {};
      gwMedia.saveDownload = async (_id, name) => ({ path: `/tmp/${name}`, data: null });
      const prompts = [];
      gwMedia.prompt = async (text) => { prompts.push(text); };

      // 发送 2 张图片组成 media_group
      gwMedia.dispatchUpdate({
        message: {
          message_id: 101,
          media_group_id: "mg-1",
          photo: [{ file_id: "p1" }],
          from: { id: 1 },
          chat: { type: "private" },
        },
      });
      gwMedia.dispatchUpdate({
        message: {
          message_id: 102,
          media_group_id: "mg-1",
          photo: [{ file_id: "p2" }],
          from: { id: 1 },
          chat: { type: "private" },
        },
      });
      // 紧接着发送文本消息
      gwMedia.dispatchUpdate({
        message: {
          message_id: 103,
          text: "请分析以上两张图",
          from: { id: 1 },
          chat: { type: "private" },
        },
      });

      // 等待 media_group timer 触发并完成排队处理
      await sleep(1300);
      await gwMedia.updateChain;

      assert.equal(prompts.length, 2);
      assert.ok(prompts[0].includes("photo-101.jpg"), "相册应首先被处理并 prompt 给 Pi");
      assert.equal(prompts[1], "请分析以上两张图", "文本消息应严格排在相册之后");
    }

    // 回归（架构审查 Issue 5）：/abort 终止任务后 agent_settled 不得误报空回复
    {
      const gwAbort = new Gateway({ allowedUserId: "1", botToken: "1:x", stateDir: tmpdir() });
      gwAbort.chatReady = true;
      gwAbort.telegram.send = async () => {};
      let sentWarning = false;
      gwAbort.telegram.send = async (_c, text) => {
        if (text.includes("no text reply")) sentWarning = true;
      };

      // 模拟用户触发 abort
      await gwAbort.handleCommand({ name: "abort", argument: "" }, "/abort");
      // Pi RPC 随后响应 agent_settled
      await gwAbort.handleEvent({ type: "agent_settled" });
      await gwAbort.telegramChain;
      assert.equal(sentWarning, false, "/abort 后 agent_settled 不应误报未返回文本回复");
    }

    // 回归（架构审查 Issue 6）：UI 选项点击时同一 requestId 的所有 token 立即作废
    {
      const gwUi = new Gateway({ allowedUserId: "1", botToken: "1:x", stateDir: tmpdir() });
      gwUi.pi.write = () => {};
      gwUi.telegram.answer = async () => {};
      gwUi.telegram.edit = async () => {};

      // 模拟注册两个选项按钮
      const t1 = gwUi.action({ type: "ui", requestId: "req-99", response: { value: "A" } });
      const t2 = gwUi.action({ type: "ui", requestId: "req-99", response: { value: "B" } });

      assert.equal(gwUi.actions.size, 2);
      // 点击选项 A
      await gwUi.handleCallback({ id: "cb-1", data: t1, message: { chat: { id: 1 }, message_id: 1, text: "q" } });

      // 选项 A 与 B 均应从 actions 中删除，防止重复点击 B
      assert.equal(gwUi.actions.size, 0);
      let answeredMsg = "";
      gwUi.telegram.answer = async (_id, text) => { answeredMsg = text; };
      // 再次点击选项 B
      await gwUi.handleCallback({ id: "cb-2", data: t2 });
      assert.equal(answeredMsg, "Expired");
    }

    // 回归（架构审查 Issue 7）：429 触发 retryNotBefore 冷却且 flushDraft 退避
    {
      const gwRate = new Gateway({ allowedUserId: "1", botToken: "1:x", stateDir: tmpdir() });
      gwRate.telegram.retryNotBefore = Date.now() + 5000;
      let editCalled = false;
      let sendCalled = false;
      gwRate.telegram.sendOne = async () => { sendCalled = true; };
      gwRate.telegram.edit = async () => { editCalled = true; };
      await gwRate.flushDraft({ text: "test rate limit", flushing: false, closed: false, messageId: null });
      assert.equal(sendCalled, false, "429 冷却期内 flushDraft 应跳过发送");
      assert.equal(editCalled, false);
    }

    await sleep(80);
    assert.equal(existsSync(join(tmpOffset, "offset")), false, "offset 不应在处理完前落盘");
    release();
    await sleep(80);
    assert.deepEqual(handled, [7]);
    assert.equal(readFileSync(join(tmpOffset, "offset"), "utf8"), "8", "处理完后 offset 应为 update_id+1");
    tg.stopPolling();
    tg.stopWakeMonitor();

    // 回归：macOS 休眠唤醒自愈（秒级中止死轮询 + 快速网络探测重连）
    {
      const tgWake = new Telegram("123456:fake-token", "/tmp/fake-offset");
      let pollAborted = false;
      const ac = new AbortController();
      ac.signal.addEventListener("abort", () => { pollAborted = true; });
      tgWake.currentPollAc = ac;

      const origFetch = globalThis.fetch;
      let probeCalls = 0;
      globalThis.fetch = async (url) => {
        if (String(url).includes("/getMe")) {
          probeCalls++;
          return { ok: true, json: async () => ({ ok: true }) };
        }
        return { ok: false };
      };

      const wakeTask = tgWake.handleWake(15);
      assert.equal(pollAborted, true, "唤醒时应立即 abort 悬挂的长轮询");
      await wakeTask;
      assert.equal(probeCalls, 1, "唤醒后应执行快速网络探测");
      assert.equal(tgWake.wakePromise, null, "探测结束后 wakePromise 应复位");

      globalThis.fetch = origFetch;
      tgWake.stopWakeMonitor();
    }
  }

  {
    const r = spawnSync("bash", ["-n", join(dirname(fileURLToPath(import.meta.url)), "install.sh")]);
    assert.equal(r.status, 0, "install.sh bash syntax check");
  }
  // Herdr agent 推送：选项解析、opt-in 判定、状态迁移去重
  assert.deepEqual(
    herdrChoices("Do you want to proceed?\n❯ 1. Yes\n  2. Yes, and don't ask again\n  3. No, tell Claude what to do"),
    [{ key: "1", label: "Yes" }, { key: "2", label: "Yes, and don't ask again" }, { key: "3", label: "No, tell Claude what to do" }],
  );
  assert.deepEqual(herdrChoices("│ › 1. Yes, proceed │\n│   2. No │").map((c) => c.key), ["1", "2"]);
  assert.deepEqual(herdrChoices("1. only one option"), []);
  assert.deepEqual(herdrChoices("1. old\n2. old\nfoo\n1. new\n2. new\n3. new").map((c) => c.label), ["new", "new", "new"]);
  assert.equal(herdrTail("a\nb\nc\n\n\n", 2), "b\nc");
  assert.equal(herdrOptedIn({ agent: "pi", tokens: { remote_pi: "on" } }), true);
  assert.equal(herdrOptedIn({ agent: "pi" }), false);
  assert.equal(herdrOptedIn({ agent: "claude", tokens: { remote_pi: "on" } }), false);
  {
    const notified = [];
    const watcher = new HerdrWatcher({ bin: "herdr", socketPath: "", isExcluded: (id) => id === "w1:p9", onTransition: () => {} });
    watcher.notify = (paneId, status) => notified.push(`${paneId}:${status}`);
    for (const [pane, status] of [["w1:p1", "done"], ["w1:p1", "working"], ["w1:p1", "blocked"], ["w1:p1", "blocked"], ["w1:p1", "working"],
      ["w1:p1", "idle"], ["w1:p1", "done"], ["w1:p2", "idle"], ["w1:p2", "idle"], ["w1:p9", "working"], ["w1:p9", "done"]]) {
      watcher.observe(pane, status);
    }
    assert.deepEqual(notified, ["w1:p1:blocked", "w1:p1:done"], "首见不推、重复不推、idle→done 不重复、排除网关自身 pane");
  }
  assert.ok(HELP.includes("/agents") && BOT_COMMANDS.some((c) => c.command === "agents"), "/agents registered");
  {
    const r = spawnSync("node", ["--check", "--experimental-strip-types", join(dirname(fileURLToPath(import.meta.url)), "herdr-extension.ts")]);
    assert.equal(r.status, 0, `herdr-extension.ts syntax check: ${r.stderr}`);
  }
  assert.ok(HELP.includes("/upgrade"), "HELP mentions /upgrade");
  assert.ok(BOT_COMMANDS.some((c) => c.command === "upgrade"), "BOT_COMMANDS registers upgrade");

  // 1. pollBackoffMs 指数退避与全抖动
  assert.equal(pollBackoffMs(1, () => 1), 1000);
  assert.equal(pollBackoffMs(1, () => 0), 500); // 最小不低于 500ms
  assert.equal(pollBackoffMs(1, () => 0.8), 800);
  assert.equal(pollBackoffMs(2, () => 1), 2000);
  assert.equal(pollBackoffMs(2, () => 0.1), 500); // 2000 * 0.1 = 200 -> 500
  assert.equal(pollBackoffMs(3, () => 0.5), 2000); // 4000 * 0.5 = 2000
  assert.equal(pollBackoffMs(7, () => 1), 60_000); // 64_000 封顶 60_000
  assert.equal(pollBackoffMs(10, () => 1), 60_000);
  assert.equal(pollBackoffMs(0, () => 1), 1000);

  // 1. Telegram.call quiet 选项抑制重试与 HTTP 错误日志
  {
    const tg = new Telegram("fake-token", "/tmp/fake");
    const origFetch = globalThis.fetch;
    const origError = console.error;
    const loggedErrors = [];
    console.error = (...args) => loggedErrors.push(args.join(" "));

    globalThis.fetch = async () => { throw new Error("connection dropped"); };
    await assert.rejects(() => tg.call("getUpdates", {}, 1000, 1, null, true), /connection dropped/);
    assert.equal(loggedErrors.filter((l) => l.includes("[tg:call]")).length, 0, "quiet=true 时应抑制 [tg:call] 错误日志");

    await assert.rejects(() => tg.call("getUpdates", {}, 1000, 1, null, false), /connection dropped/);
    assert.ok(loggedErrors.some((l) => l.includes("[tg:call] getUpdates attempt 1/1 failed")), "quiet=false 时应输出错误日志");

    console.error = origError;
    globalThis.fetch = origFetch;
  }

  // 1. poll() 退避睡眠可被 handleWake 中断并重置失败计数
  {
    const tg = new Telegram("123456:fake-token", join(tmpdir(), `test-offset-${Date.now()}`));
    tg.pollFailures = 4;
    tg.outageStart = Date.now() - 5000;
    let sleepAborted = false;
    tg.pollSleepAc = new AbortController();
    tg.pollSleepAc.signal.addEventListener("abort", () => { sleepAborted = true; });

    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true }) });
    const wakePromise = tg.handleWake(10);
    assert.equal(sleepAborted, true, "handleWake 应立即 abort 退避等待");
    assert.equal(tg.pollFailures, 0, "handleWake 应重置连续失败计数");
    await wakePromise;
    globalThis.fetch = origFetch;
  }

  // 1. poll() 断网与恢复日志：断网仅首见打 1 行 offline，期间静默，恢复打 1 行 back online
  {
    const tmpOffset = join(tmpdir(), `test-poll-${Date.now()}`);
    const tg = new Telegram("fake-token", tmpOffset);
    const origError = console.error;
    const origLog = console.log;
    const errors = [];
    const logs = [];
    const sleptMs = [];
    console.error = (...args) => errors.push(args.join(" "));
    console.log = (...args) => logs.push(args.join(" "));

    tg.pollSleep = async (ms) => {
      sleptMs.push(ms);
    };

    let pollStep = 0;
    let pollPromise;
    const donePromise = new Promise((resolve) => {
      tg.call = async () => {
        pollStep++;
        if (pollStep === 1) throw new Error("poll outage 1");
        if (pollStep === 2) throw new Error("poll outage 2");
        if (pollStep === 3) return [{ update_id: 10 }];
        throw new Error("unexpected poll");
      };
      pollPromise = tg.poll(() => { resolve(); return Promise.resolve(); });
    });

    await donePromise;
    tg.stopPolling();
    tg.stopWakeMonitor();
    await pollPromise;
    console.error = origError;
    console.log = origLog;

    assert.equal(errors.filter((l) => l.includes("[tg:poll] offline:")).length, 1, "断网期间 offline 仅应记录 1 行");
    assert.ok(errors.some((l) => l.includes("[tg:poll] offline: poll outage 1; retrying with backoff")), "offline 日志内容");
    assert.equal(errors.filter((l) => l.includes("poll outage 2")).length, 0, "断网期间后续失败应保持静默");
    assert.equal(logs.filter((l) => l.includes("[tg:poll] back online after")).length, 1, "恢复后应记录 1 行 back online");
    assert.ok(logs.some((l) => l.includes("(2 failed polls)")), "恢复日志需体现连续失败次数");
    assert.equal(sleptMs.length, 2, "断网期间应触发 2 次退避睡眠");
    assert.ok(sleptMs[0] >= 500 && sleptMs[0] <= 1000, `failure 1 退避范围 500..1000，实际: ${sleptMs[0]}`);
    assert.ok(sleptMs[1] >= 500 && sleptMs[1] <= 2000, `failure 2 退避范围 500..2000，实际: ${sleptMs[1]}`);
  }

  // 1. poll() Conflict 处理：记录 [tg:poll] conflict:，不计入 outage/back-online，15s 可中断休眠
  {
    const tmpOffset = join(tmpdir(), `test-poll-conflict-${Date.now()}`);
    const tg = new Telegram("fake-token", tmpOffset);
    const origError = console.error;
    const origLog = console.log;
    const errors = [];
    const logs = [];
    const sleptMs = [];
    console.error = (...args) => errors.push(args.join(" "));
    console.log = (...args) => logs.push(args.join(" "));

    tg.pollSleep = async (ms) => {
      sleptMs.push(ms);
    };

    let step = 0;
    let pollPromise;
    const donePromise = new Promise((resolve) => {
      tg.call = async () => {
        step++;
        if (step === 1) throw new Error("Conflict: terminated by other getUpdates request");
        if (step === 2) throw new Error("Conflict: duplicate");
        if (step === 3) return [{ update_id: 20 }];
        throw new Error("unexpected poll");
      };
      pollPromise = tg.poll(() => { resolve(); return Promise.resolve(); });
    });

    await donePromise;
    tg.stopPolling();
    tg.stopWakeMonitor();
    await pollPromise;
    console.error = origError;
    console.log = origLog;

    assert.equal(errors.filter((l) => l.includes("[tg:poll] conflict:")).length, 1, "Conflict 连续出现应只打 1 行日志");
    assert.equal(errors.filter((l) => l.includes("[tg:poll] offline:")).length, 0, "Conflict 不应被当作 offline outage");
    assert.equal(logs.filter((l) => l.includes("[tg:poll] back online")).length, 0, "Conflict 恢复不应打 back online");
    assert.equal(tg.pollFailures, 0, "Conflict 不应计入 pollFailures");
    assert.deepEqual(sleptMs, [15_000, 15_000], "Conflict 每次应请求 15s 休眠");
  }

  // 2. getUpdates 空轮询不打成功日志，非空或其它方法打成功日志
  {
    const tg = new Telegram("fake-token", "/tmp/fake");
    const origFetch = globalThis.fetch;
    const origLog = console.log;
    let logged = [];
    console.log = (...args) => logged.push(args.join(" "));

    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, result: [] }) });
    await tg.call("getUpdates", {});
    assert.equal(logged.filter((l) => l.includes("[tg:call] getUpdates ok")).length, 0, "空轮询不应输出 [tg:call] getUpdates ok 日志");

    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, result: [{ update_id: 1 }] }) });
    await tg.call("getUpdates", {});
    assert.ok(logged.some((l) => l.includes("[tg:call] getUpdates ok") && l.includes("(updates: 1)")), "有更新时应输出日志");

    logged = [];
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, result: { id: 123 } }) });
    await tg.call("getMe", {});
    assert.ok(logged.some((l) => l.includes("[tg:call] getMe ok")), "其它方法成功应输出日志");

    console.log = origLog;
    globalThis.fetch = origFetch;
  }

  // 3. config.example.json 嵌套结构及 README 一致性
  {
    const exampleRaw = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "config.example.json"), "utf8");
    const example = JSON.parse(exampleRaw);
    assert.ok(example.telegram?.botToken, "config.example.json 需包含 telegram.botToken");
    assert.ok(example.telegram?.allowedUserId, "config.example.json 需包含 telegram.allowedUserId");
    assert.equal(example.botToken, undefined, "config.example.json 不应有顶层 botToken");
    assert.equal(example.allowedUserId, undefined, "config.example.json 不应有顶层 allowedUserId");
    assert.equal(example.devRoot, undefined, "config.example.json 不应包含无用字段 devRoot");
    assert.ok(example.cwd, "config.example.json 需包含 cwd");

    const readmeEn = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "README.md"), "utf8");
    const readmeZh = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "README.zh-CN.md"), "utf8");
    for (const [name, doc] of [["README.md", readmeEn], ["README.zh-CN.md", readmeZh]]) {
      assert.ok(doc.includes('"telegram": {'), `${name} 应包含嵌套 telegram 配置示例`);
      assert.ok(doc.includes('"botToken":'), `${name} 应包含 botToken`);
      assert.ok(!doc.includes('"devRoot":'), `${name} 不应包含 devRoot 示例`);
    }
  }

  // 4. 非幂等方法不盲目重试 (isConnectPhaseError / shouldRetryTelegram)
  {
    assert.equal(isConnectPhaseError({ cause: { code: "ECONNREFUSED" } }), true);
    assert.equal(isConnectPhaseError({ cause: { code: "ENOTFOUND" } }), true);
    assert.equal(isConnectPhaseError({ cause: { code: "EAI_AGAIN" } }), true);
    assert.equal(isConnectPhaseError({ cause: { code: "ENETUNREACH" } }), true);
    assert.equal(isConnectPhaseError({ cause: { code: "EHOSTUNREACH" } }), true);
    assert.equal(isConnectPhaseError({ cause: { code: "UND_ERR_CONNECT_TIMEOUT" } }), true);
    assert.equal(isConnectPhaseError({ code: "ECONNREFUSED" }), true);
    assert.equal(isConnectPhaseError({ cause: { code: "ECONNRESET" } }), false);
    assert.equal(isConnectPhaseError(new Error("aborted")), false);
    assert.equal(isConnectPhaseError(null), false);

    assert.equal(shouldRetryTelegram("sendMessage", { error: { cause: { code: "ECONNREFUSED" } } }), true);
    assert.equal(shouldRetryTelegram("sendMessage", { error: { cause: { code: "ECONNRESET" } } }), false);
    assert.equal(shouldRetryTelegram("sendMessage", { error: new Error("timeout") }), false);
    assert.equal(shouldRetryTelegram("sendMessage", { status: 429 }), true);
    assert.equal(shouldRetryTelegram("sendMessage", { status: 500 }), false);
    assert.equal(shouldRetryTelegram("sendMessage", { status: 502 }), false);
    assert.equal(shouldRetryTelegram("sendMessage", { status: 400 }), false);

    for (const m of ["sendDocument", "sendPhoto", "sendMediaGroup", "copyMessage", "forwardMessage"]) {
      assert.equal(shouldRetryTelegram(m, { status: 500 }), false, `${m} HTTP 500 不应重试`);
      assert.equal(shouldRetryTelegram(m, { status: 429 }), true, `${m} HTTP 429 应重试`);
      assert.equal(shouldRetryTelegram(m, { error: { cause: { code: "ECONNRESET" } } }), false, `${m} ECONNRESET 不应重试`);
      assert.equal(shouldRetryTelegram(m, { error: { cause: { code: "ECONNREFUSED" } } }), true, `${m} ECONNREFUSED 应重试`);
    }

    for (const m of ["getUpdates", "editMessageText", "deleteMessage", "getMe"]) {
      assert.equal(shouldRetryTelegram(m, { status: 500 }), true, `${m} HTTP 500 应重试`);
      assert.equal(shouldRetryTelegram(m, { status: 429 }), true, `${m} HTTP 429 应重试`);
      assert.equal(shouldRetryTelegram(m, { status: 400 }), false, `${m} HTTP 400 不应重试`);
      assert.equal(shouldRetryTelegram(m, { error: { cause: { code: "ECONNRESET" } } }), true, `${m} ECONNRESET 应重试`);
      assert.equal(shouldRetryTelegram(m, { error: new Error("timeout") }), true, `${m} 超时应重试`);
    }

    const tg = new Telegram("fake-token", "/tmp/fake");
    const origFetch = globalThis.fetch;
    let fetchCount = 0;

    globalThis.fetch = async () => {
      fetchCount++;
      const err = new TypeError("fetch failed");
      err.cause = { code: "ECONNRESET" };
      throw err;
    };
    await assert.rejects(() => tg.call("sendMessage", { text: "hi" }, 1000, 3, null, true), /fetch failed/);
    assert.equal(fetchCount, 1, "sendMessage 遇 ECONNRESET 仅发 1 次不重试");

    fetchCount = 0;
    globalThis.fetch = async () => {
      fetchCount++;
      return { ok: false, status: 500, json: async () => ({ ok: false, description: "Internal Server Error" }) };
    };
    await assert.rejects(() => tg.call("sendMessage", { text: "hi" }, 1000, 3, null, true), /Telegram sendMessage: Internal Server Error/);
    assert.equal(fetchCount, 1, "sendMessage 遇 HTTP 500 仅发 1 次不重试");

    fetchCount = 0;
    await assert.rejects(() => tg.call("editMessageText", { text: "hi" }, 1000, 3, null, true), /Telegram editMessageText: Internal Server Error/);
    assert.equal(fetchCount, 3, "editMessageText 遇 HTTP 500 应重试满 maxAttempts");

    globalThis.fetch = origFetch;
  }

  // 5. PiRpc start race + pending leak
  {
    let startCalls = 0;
    const rpc = new PiRpc({ cwd: process.cwd(), sessionDir: "/tmp" }, () => {}, () => {});
    rpc.start = async () => {
      startCalls++;
      await sleep(20);
      rpc.proc = { stdin: { writable: false, write: () => {} } };
    };

    await Promise.all([rpc.ensureStarted(), rpc.ensureStarted(), rpc.ensureStarted()]);
    assert.equal(startCalls, 1, "ensureStarted 并发调用时 start 仅应执行一次");

    rpc.write = () => { throw new Error("pipe broke"); };
    await assert.rejects(
      () => rpc.request("test_cmd", {}, 1000),
      /pipe broke/,
      "write 抛出异常时 request 应立即 reject",
    );
    assert.equal(rpc.pending.size, 0, "write 异常后 pending 不应泄露");
  }

  console.log("self-test: ok");
}

if (import.meta.main) {
  if (process.argv.includes("--self-test")) {
    await selfTest();
  } else {
    if (process.env.REMOTE_PI_GATEWAY) {
      console.error("❌ Refusing to start: already running inside a remote-pi session.");
      process.exit(1);
    }
    const gateway = new Gateway(loadConfig());
    for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { gateway.stop(); process.exit(0); });
    gateway.start().catch((error) => { console.error(error); gateway.stop(); process.exit(1); });
  }
}
