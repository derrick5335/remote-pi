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
  ["session", "Session & cost"],
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
  }

  async call(method, body = {}, timeout = 35_000, maxAttempts = 3) {
    let lastError;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      let response;
      let data;
      const t0 = performance.now();
      try {
        response = await fetch(`${this.base}/${method}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeout),
        });
        data = await response.json();
      } catch (error) {
        const ms = Math.round(performance.now() - t0);
        console.error(`${new Date().toISOString()} [tg:call] ${method} attempt ${attempt + 1}/${maxAttempts} failed in ${ms}ms:`, error.message);
        lastError = error;
        if (attempt === maxAttempts - 1) throw error;
        await sleep((attempt + 1) * 1000);
        continue;
      }
      const ms = Math.round(performance.now() - t0);
      if (response.ok && data.ok) {
        if (method !== "getUpdates" || (Array.isArray(data.result) && data.result.length > 0) || ms > 1500) {
          console.log(`${new Date().toISOString()} [tg:call] ${method} ok in ${ms}ms${method === "getUpdates" ? ` (updates: ${data.result.length})` : ""}`);
        }
        return data.result;
      }
      if (response.status === 429) {
        const retrySec = data?.parameters?.retry_after || attempt + 1;
        this.retryNotBefore = Math.max(this.retryNotBefore, Date.now() + retrySec * 1000);
      }
      lastError = new Error(`Telegram ${method}: ${data.description || response.status}`);
      console.error(`${new Date().toISOString()} [tg:call] ${method} HTTP ${response.status} in ${ms}ms: ${data.description || ""}`);
      if (!retryableTelegramStatus(response.status) || attempt === maxAttempts - 1) throw lastError;
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

  async poll(handler) {
    let offset = Number(await readFile(this.offsetPath, "utf8").catch(() => "0")) || 0;
    // at-least-once：普通消息处理完才落盘 offset，崩溃后由 Telegram 重投（重复优于丢失）；p0/p1 只推进内存 offset
    let persistChain = Promise.resolve();
    for (;;) {
      try {
        const updates = await this.call("getUpdates", {
          offset, timeout: 50, allowed_updates: ["message", "callback_query", "stopped_message_generation"],
        }, 60_000);
        for (const update of updates) {
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
        console.error(`${new Date().toISOString()} [tg:poll] error:`, error.message);
        if (error.message?.includes("Conflict")) {
          await sleep(15_000);
          continue;
        }
        await sleep(3000);
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

class PiRpc {
  constructor(config, onEvent, onClose) {
    this.config = config;
    this.onEvent = onEvent;
    this.onClose = onClose;
    this.pending = new Map();
    this.sequence = 0;
    this.proc = null;
    this.pingTimer = null;
    this.missedPings = 0;
    this.stopping = false;
  }

  async ensureStarted() {
    if (!this.proc) await this.start();
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
      this.write({ id, type, ...fields });
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
    this.draftSupport = "unknown";
    this.nextDraftId = 0;
    this.activeMessageIds = [];
    this.runStartedAt = null;
    this.runFirstTokenAt = null;
    this.runFirstUiAt = null;
    this.lastModel = null;

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

  action(payload) {
    const now = Date.now();
    for (const [key, value] of this.actions) if (value.expires < now) this.actions.delete(key);
    const token = randomBytes(6).toString("base64url");
    this.actions.set(token, { ...payload, expires: now + 10 * 60_000 });
    return `a:${token}`;
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
      this.draft = { text: "", messageId: null, timer: null, draftId: null, closed: false };
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

  async flushDraft(draft) {
    if (!draft.text || draft.flushing || draft.closed) return;
    if (this.telegram.retryNotBefore > Date.now()) return; // 429 冷却中
    draft.flushing = true;
    const t0 = performance.now();
    try {
      const text = previewText(draft.text);
      if (text === draft.sentPreview) return; // 去重：冻结预览不再每 1.2s 重发（循环播放的根因）
      if (this.draftSupport !== "unsupported") {
        if (draft.draftId === null) draft.draftId = ++this.nextDraftId;
        try {
          await this.telegram.sendDraft(this.chatId, draft.draftId, text);
          this.draftSupport = "supported";
          draft.sentPreview = text;
          this.logFirstUi(t0, "draft");
          return;
        } catch (error) {
          const msg = String(error.message || "");
          if (/not found|unknown method|404/i.test(msg)) {
            this.draftSupport = "unsupported";
            console.error("sendMessageDraft unavailable; falling back to send+edit:", error.message);
          } else {
            console.error("sendMessageDraft transient error:", error.message);
            if (this.draftSupport === "supported" || /429|too many requests/i.test(msg)) return;
          }
        }
      }
      if (draft.messageId) {
        await this.telegram.edit(this.chatId, draft.messageId, text, true);
      } else {
        draft.messageId = (await this.telegram.sendOne(this.chatId, text, { disable_notification: true })).message_id;
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
      // 先交付最终回复，成功后再清理预览；失败时预览保留为可恢复副本
      const parts = chunks(draft.text);
      for (const part of parts) await this.telegram.sendOne(this.chatId, part);
      if (draft.messageId) await this.telegram.deleteMessage(this.chatId, draft.messageId).catch(() => {});
      const apiMs = Math.round(performance.now() - t0);
      const turnMs = this.runStartedAt ? ` (total turn: ${Math.round(performance.now() - this.runStartedAt)}ms)` : "";
      console.log(`${new Date().toISOString()} [ui] final reply sent (${parts.length} parts, took ${apiMs}ms)${turnMs}`);
    } catch (error) {
      console.error(`${new Date().toISOString()} [ui] final reply delivery failed:`, error.message);
      // draft 模式预览 30s 即过期，失败副本落盘防丢内容
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
    gw.telegram.edit = async () => {};
    gw.telegram.sendDraft = async () => { throw new Error("fetch failed"); };
    gw.telegram.sendOne = async () => ({ message_id: 123 });
    const draft = { text: "hello", flushing: false, draftId: null, messageId: null };
    await gw.flushDraft(draft);
    assert.equal(gw.draftSupport, "unknown");

    gw.telegram.sendDraft = async () => { throw new Error("Telegram sendMessageDraft: Not Found"); };
    draft.text = "hello world";
    await gw.flushDraft(draft);
    assert.equal(gw.draftSupport, "unsupported");

    // 回归：预览内容不变时跳过重复发送（冻结预览不再每 1.2s 重发）
    let draftCalls = 0;
    gw.draftSupport = "unknown";
    gw.telegram.sendDraft = async () => { draftCalls++; };
    draft.text = "hello world again";
    await gw.flushDraft(draft);
    assert.equal(draftCalls, 1);
    draft.text += "!";
    await gw.flushDraft(draft);
    assert.equal(draftCalls, 2);
    await gw.flushDraft(draft);
    assert.equal(draftCalls, 2);

    // 回归：最终交付不再发送空文本清除草稿；closed 拦截过期刷新
    const sentParts = [];
    gw.telegram.sendOne = async (_chat, text) => { sentParts.push(text); return { message_id: 1 }; };
    gw.telegram.deleteMessage = async () => {};
    await gw.finishDraft({ text: "final answer", messageId: 9, draftId: 4 });
    assert.deepEqual(sentParts, ["final answer"]);
    assert.equal(draftCalls, 2);
    await gw.flushDraft({ text: "stale", closed: true });
    assert.equal(draftCalls, 2);

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
      const prevSupport = gw.draftSupport;
      const prevSendOne = gw.telegram.sendOne;
      gw.draftSupport = "unsupported";
      gw.telegram.sendOne = async () => { throw new Error("preview boom"); };
      await gw.flushDraft({ text: "boom draft", flushing: false, draftId: null, messageId: null });
      console.error = origError;
      gw.draftSupport = prevSupport;
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
      let draftCalled = false;
      gwRate.telegram.sendDraft = async () => { draftCalled = true; };
      await gwRate.flushDraft({ text: "test rate limit", flushing: false, closed: false, draftId: null, messageId: null });
      assert.equal(draftCalled, false, "429 冷却期内 flushDraft 应跳过发送");
    }

    await sleep(80);
    assert.equal(existsSync(join(tmpOffset, "offset")), false, "offset 不应在处理完前落盘");
    release();
    await sleep(80);
    assert.deepEqual(handled, [7]);
    assert.equal(readFileSync(join(tmpOffset, "offset"), "utf8"), "8", "处理完后 offset 应为 update_id+1");
  }

  {
    const r = spawnSync("bash", ["-n", join(dirname(fileURLToPath(import.meta.url)), "install.sh")]);
    assert.equal(r.status, 0, "install.sh bash syntax check");
  }
  assert.ok(HELP.includes("/upgrade"), "HELP mentions /upgrade");
  assert.ok(BOT_COMMANDS.some((c) => c.command === "upgrade"), "BOT_COMMANDS registers upgrade");
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
