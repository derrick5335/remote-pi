#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, openAsBlob, readFileSync } from "node:fs";
import { mkdir, open, readFile, readdir, realpath, rename, stat, truncate, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import MarkdownIt from "markdown-it";

const MAX_MESSAGE = 4000;
const MAX_LOG_SIZE = 5 * 1024 * 1024;
const HELP = `Remote Pi

直接发送文字即可和 Pi 对话；运行中发送的文字会作为 steer。

/help               显示帮助
/commands           扩展、Prompt 和 Skill 命令
/cwd                查看或切换 ~/dev 下的项目
/sh <命令>           直接执行 Shell 命令
/get <文件路径>      从当前项目下载文件
/model [关键词|provider/model]
/thinking [level]
/resume             选择历史会话
/new                新会话
/name <名称>         设置会话名
/session            当前模型、Session、Token 和费用
/fork               从历史用户消息创建分支
/clone              克隆当前分支
/compact [要求]      压缩上下文
/export             导出 HTML
/abort              停止当前任务（排队消息保留）
/abort clear        停止并清空队列
/restart            重启 Gateway
/queue [clear]       查看或清空消息队列
/followup <消息>     追加为排队后续任务`;

const BOT_COMMANDS = [
  ["help", "帮助"], ["commands", "扩展、Prompt 和 Skill 命令"],
  ["cwd", "查看或切换工作目录"], ["sh", "直接执行 Shell 命令"], ["get", "下载项目文件"],
  ["model", "查看或切换模型"], ["thinking", "查看或切换思考级别"],
  ["resume", "恢复历史会话"], ["new", "新会话"], ["name", "设置会话名"],
  ["session", "Session 和费用"],
  ["fork", "从历史分支"], ["clone", "克隆当前分支"],
  ["compact", "压缩上下文"], ["export", "导出会话"], ["abort", "停止当前任务（保留队列）"],
  ["restart", "重启 Gateway"],
  ["queue", "查看或清空队列"],
  ["followup", "排队追加后续任务"],
].map(([command, description]) => ({ command, description }));

function parseCommand(text) {
  const match = text.match(/^\/([\w:-]+)(?:@\w+)?(?:\s+([\s\S]*))?$/);
  return match ? { name: match[1].toLowerCase(), argument: match[2]?.trim() ?? "" } : null;
}

function isDirectChild(root, target) {
  return dirname(target) === root;
}

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
rules.paragraph_close = () => "";
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
  const str = String(text || "（无内容）");
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
  const header = isSettled ? `✅ 已完成 ${total} 项操作` : `⚙️ 正在执行操作 (${done}/${total})…`;
  const recent = tools.slice(-6).map((t) => {
    const icon = t.status === "running" ? "⏳" : t.status === "error" ? "❌" : "✅";
    const summary = t.summary.length > 80 ? `${t.summary.slice(0, 77)}…` : t.summary;
    return `• ${icon} ${summary}`;
  });
  const hidden = tools.length - recent.length;
  const prefix = hidden > 0 ? [`… 之前已完成 ${hidden} 项`] : [];
  const body = [...prefix, ...recent].join("\n");
  if (tools.length >= 3 || isSettled) {
    return `${header}\n${expandableBlockquote(body)}`;
  }
  return [header, ...prefix, ...recent].join("\n");
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
  return `${caption}\n\n附件已保存到本地：\n${files.map((file) => `- ${file.path}`).join("\n")}`;
}

function previewText(text) {
  return text.length > MAX_MESSAGE ? `${text.slice(0, MAX_MESSAGE)}\n\n*(内容较长，输出中…)*` : text;
}

function formatAssistantError(errorMessage) {
  const message = String(errorMessage || "模型调用失败");
  if (/usage limit|quota|balance|credit|insufficient|budget/i.test(message)) {
    return `⚠️ ${message}\n\n💡 提示：当前模型用量额度已用尽。你可以使用 /model 切换到其他可用模型（例如 Gemini 或 Claude）。`;
  }
  if (/rate limit|too many requests|429/i.test(message)) {
    return `⚠️ ${message}\n\n💡 提示：触发了服务商速率限制，请稍候重试，或使用 /model 切换模型。`;
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
      rejectStt(new Error(`语音转写失败 (exit ${code ?? "signal"})：${(err.trim() || text || "无输出").slice(-300)}`));
    });
  });
}

function loadConfig() {
  const path = process.env.REMOTE_PI_CONFIG || join(homedir(), ".config", "remote-pi", "config.json");
  let file = {};
  if (existsSync(path)) file = JSON.parse(readFileSync(path, "utf8"));
  const config = {
    botToken: process.env.TELEGRAM_BOT_TOKEN || file.botToken,
    allowedUserId: String(process.env.TELEGRAM_ALLOWED_USER_ID || file.allowedUserId || ""),
    cwd: resolve(process.env.PI_CWD || file.cwd || process.cwd()),
    configPath: path,
    devRoot: join(homedir(), "dev"),
    piBin: process.env.PI_BIN || file.piBin || "pi",
    stateDir: resolve(file.stateDir || join(homedir(), ".local", "var", "remote-pi")),
    logFile: resolve(process.env.REMOTE_PI_LOG_FILE || file.logFile || join(homedir(), ".local", "var", "log", "remote-pi.log")),
    approve: file.approve !== false,
    sttCommand: file.sttCommand || "",
    ackEmoji: process.env.TELEGRAM_ACK_EMOJI || file.ackEmoji || "👀",
    doneEmoji: process.env.TELEGRAM_DONE_EMOJI || file.doneEmoji || "🫡",
  };
  config.sessionDir = join(config.stateDir, "sessions", config.cwd.replace(/^\//, "").replaceAll("/", "-"));
  config.downloadsDir = join(config.stateDir, "downloads");
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(config.botToken || "")) throw new Error(`Invalid botToken in ${path}`);
  if (!/^\d+$/.test(config.allowedUserId)) throw new Error(`Invalid allowedUserId in ${path}`);
  if (!existsSync(config.cwd)) throw new Error(`Pi working directory does not exist: ${config.cwd}`);
  if (!existsSync(config.devRoot)) throw new Error(`Project directory does not exist: ${config.devRoot}`);
  return config;
}

class Telegram {
  constructor(token, offsetPath) {
    this.base = `https://api.telegram.org/bot${token}`;
    this.fileBase = `https://api.telegram.org/file/bot${token}`;
    this.offsetPath = offsetPath;
  }

  async call(method, body = {}, timeout = 35_000, maxAttempts = 3) {
    let lastError;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      let response;
      let data;
      try {
        response = await fetch(`${this.base}/${method}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeout),
        });
        data = await response.json();
      } catch (error) {
        lastError = error;
        if (attempt === maxAttempts - 1) throw error;
        await sleep((attempt + 1) * 1000);
        continue;
      }
      if (response.ok && data.ok) return data.result;
      lastError = new Error(`Telegram ${method}: ${data.description || response.status}`);
      if (!retryableTelegramStatus(response.status) || attempt === maxAttempts - 1) throw lastError;
      await sleep((data.parameters?.retry_after || attempt + 1) * 1000);
    }
    throw lastError;
  }

  async sendOne(chatId, text, extra = {}) {
    const plain = String(text || "（无内容）");
    try {
      return await this.call("sendMessage", { chat_id: chatId, text: telegramHtml(plain), parse_mode: "HTML", ...extra });
    } catch (error) {
      if (!error.message.includes("can't parse entities")) throw error;
      console.error("HTML parse fallback:", error.message);
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
    const plain = String(text || "（无内容）");
    const timeout = ephemeral ? 10_000 : 35_000;
    const maxAttempts = ephemeral ? 1 : 3;
    try {
      return await this.call("editMessageText", { chat_id: chatId, message_id: messageId, text: telegramHtml(plain), parse_mode: "HTML" }, timeout, maxAttempts);
    } catch (error) {
      if (error.message.includes("can't parse entities")) {
        console.error("HTML parse fallback:", error.message);
        return this.call("editMessageText", { chat_id: chatId, message_id: messageId, text: plain }, timeout, maxAttempts);
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
    const form = new FormData();
    form.set("chat_id", String(chatId));
    form.set("document", await openAsBlob(path), basename(path));
    const response = await fetch(`${this.base}/sendDocument`, { method: "POST", body: form, signal: AbortSignal.timeout(60_000) });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(`Telegram sendDocument: ${data.description || response.status}`);
  }

  async sendDraft(chatId, draftId, text) {
    await this.call("sendMessageDraft", { chat_id: chatId, draft_id: draftId, text, can_stop: true }, 10_000, 1);
  }

  async deleteMessage(chatId, messageId) {
    await this.call("deleteMessage", { chat_id: chatId, message_id: messageId }, 10_000, 1);
  }

  async setReaction(chatId, messageId, emojis) {
    if (!messageId) return null;
    const list = !emojis ? [] : Array.isArray(emojis) ? emojis : [emojis];
    const reaction = list.map((e) => (typeof e === "string" ? { type: "emoji", emoji: e } : e));
    try {
      return await this.call("setMessageReaction", { chat_id: chatId, message_id: messageId, reaction }, 5000, 1);
    } catch {
      if (reaction.length > 1) {
        try {
          return await this.call("setMessageReaction", { chat_id: chatId, message_id: messageId, reaction: [reaction.at(-1)] }, 5000, 1);
        } catch {
          return null;
        }
      }
      return null;
    }
  }

  async poll(handler) {
    let offset = Number(await readFile(this.offsetPath, "utf8").catch(() => "0")) || 0;
    for (;;) {
      try {
        const updates = await this.call("getUpdates", {
          offset, timeout: 50, allowed_updates: ["message", "callback_query", "stopped_message_generation"],
        }, 60_000);
        for (const update of updates) {
          offset = update.update_id + 1;
          const tmp = `${this.offsetPath}.tmp`;
          await writeFile(tmp, String(offset), { mode: 0o600 });
          await rename(tmp, this.offsetPath);
          await handler(update);
        }
      } catch (error) {
        console.error(new Date().toISOString(), error.message);
        if (error.message?.includes("Conflict")) {
          await sleep(15_000);
          continue;
        }
        await sleep(3000);
      }
    }
  }
}

class PiRpc {
  constructor(config, onEvent) {
    this.config = config;
    this.onEvent = onEvent;
    this.pending = new Map();
    this.sequence = 0;
    this.proc = null;
  }

  async ensureStarted() {
    if (!this.proc) await this.start();
  }

  async start() {
    const args = ["--mode", "rpc", "--continue", "--session-dir", this.config.sessionDir];
    if (this.config.approve) args.push("--approve");
    const extensionPath = join(dirname(fileURLToPath(import.meta.url)), "telegram-extension.mjs");
    if (existsSync(extensionPath)) args.push("-e", extensionPath);
    const env = { ...process.env, REMOTE_PI_GATEWAY: "1", PATH: `${dirname(process.execPath)}:${process.env.PATH || "/usr/bin:/bin"}` };
    this.proc = spawn(this.config.piBin, args, { cwd: this.config.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    this.proc.stderr.pipe(process.stderr);
    await new Promise((resolveSpawn, reject) => {
      this.proc.once("spawn", resolveSpawn);
      this.proc.once("error", reject);
    });

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
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(new Error(`Pi exited (${code ?? signal})`));
      }
      this.pending.clear();
      this.proc = null;
    });
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

  async request(type, fields = {}, timeout = 600_000) {
    await this.ensureStarted();
    const id = `tg-${++this.sequence}`;
    return new Promise((resolveRequest, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Pi RPC ${type} timed out`));
      }, timeout);
      this.pending.set(id, { resolve: resolveRequest, reject, timer });
      this.write({ id, type, ...fields });
    });
  }

  write(value) {
    if (!this.proc?.stdin?.writable) throw new Error("Pi RPC is not running");
    this.proc.stdin.write(`${JSON.stringify(value)}\n`);
  }

  stop() {
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
    this.telegram = new Telegram(config.botToken, join(config.stateDir, "telegram-offset"));
    this.pi = new PiRpc(config, (event) => this.queueEvent(event));
    this.actions = new Map();
    this.commandAliases = new Map();
    this.toolPanel = null;
    this.mediaGroups = new Map();
    this.queue = { steering: [], followUp: [] };
    this.isStreaming = false;
    this.typingTimer = null;
    this.eventChain = Promise.resolve();
    this.telegramChain = Promise.resolve();
    this.draftSupport = "unknown";
    this.nextDraftId = 0;
    this.activeMessageIds = [];
  }

  async start() {
    // launchd 以 O_APPEND 持有日志 fd，启动时截断即可防无限增长（newsyslog 处理不了这种 fd）
    await stat(this.config.logFile).then((s) => s.size > MAX_LOG_SIZE ? truncate(this.config.logFile, 0) : null).catch(() => {});
    await Promise.all([
      mkdir(this.config.stateDir, { recursive: true, mode: 0o700 }),
      mkdir(this.config.sessionDir, { recursive: true, mode: 0o700 }),
      mkdir(this.config.downloadsDir, { recursive: true, mode: 0o700 }),
    ]);
    await this.telegram.call("deleteWebhook", { drop_pending_updates: false }).catch(() => {});
    const me = await this.telegram.call("getMe");
    try { await this.telegram.call("getChat", { chat_id: this.chatId }); this.chatReady = true; }
    catch (error) { if (!error.message.includes("chat not found")) throw error; }
    await this.pi.start();
    const state = await this.pi.request("get_state");
    await this.registerBotCommands();
    console.log(`${new Date().toISOString()} @${me.username} ready; Pi session ${state.sessionId}`);
    await this.telegram.poll((update) => this.handleUpdate(update));
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

  queueEvent(event) {
    this.eventChain = this.eventChain.then(() => this.handleEvent(event)).catch((error) => console.error("Pi event:", error));
  }

  queueTelegram(work) {
    const next = this.telegramChain.then(work);
    this.telegramChain = next.catch((error) => console.error("Telegram output:", error));
    return next;
  }

  isAllowed(from, chat) {
    return String(from?.id) === this.config.allowedUserId && (!chat || chat.type === "private");
  }

  settleActiveReactions() {
    for (const id of this.activeMessageIds.splice(0)) {
      this.queueTelegram(() => this.telegram.setReaction(this.chatId, id, [this.config.ackEmoji, this.config.doneEmoji]));
    }
  }

  async handleUpdate(update) {
    try {
      if (update.message) {
        if (!this.isAllowed(update.message.from, update.message.chat)) return;
        this.chatReady = true;
        await this.handleMessage(update.message);
      } else if (update.callback_query) {
        const callback = update.callback_query;
        if (!this.isAllowed(callback.from, callback.message?.chat)) return;
        this.chatReady = true;
        await this.handleCallback(callback);
      } else if (update.stopped_message_generation) {
        await this.handleCommand({ name: "abort", argument: "" }, "/abort");
      }
    } catch (error) {
      console.error("Telegram input:", error);
      this.settleActiveReactions();
      await this.telegram.send(this.chatId, `❌ ${error.message}`);
    }
  }

  async extractMedia(m) {
    if (m.photo?.length) {
      const saved = await this.saveDownload(m.photo.at(-1).file_id, `photo-${m.message_id}.jpg`, true);
      return { saved, image: { type: "image", data: saved.data, mimeType: "image/jpeg" }, label: "图片" };
    }
    const file = m.document || m.voice || m.video || m.video_note || m.audio || m.animation;
    if (!file) return null;
    const isImage = file.mime_type?.startsWith("image/");
    const kind = m.voice ? "voice" : m.video_note ? "video_note" : m.audio ? "audio" : "file";
    const saved = await this.saveDownload(file.file_id, file.file_name || `${kind}-${m.message_id}${extensionFromMime(file.mime_type)}`, isImage);
    const image = isImage ? { type: "image", data: saved.data, mimeType: file.mime_type || "image/jpeg" } : null;
    const label = m.voice ? "语音消息" : file.file_name ? `文件 ${file.file_name}` : kind;
    return { saved, image, label };
  }

  async handleMessage(message) {
    if (this.pendingUi && !message.text?.startsWith("/")) {
      const pending = this.pendingUi;
      this.pendingUi = null;
      this.telegram.setReaction(this.chatId, message.message_id, this.config.ackEmoji);
      this.pi.write({ type: "extension_ui_response", id: pending.id, value: message.text || message.caption || "" });
      await this.telegram.send(this.chatId, "已提交。");
      await this.telegram.setReaction(this.chatId, message.message_id, [this.config.ackEmoji, this.config.doneEmoji]);
      return;
    }

    if (message.media_group_id) {
      this.telegram.setReaction(this.chatId, message.message_id, this.config.ackEmoji);
      const key = `${this.chatId}:${message.media_group_id}`;
      const group = this.mediaGroups.get(key) || { messages: [], timer: null };
      group.messages.push(message);
      if (group.timer) clearTimeout(group.timer);
      group.timer = setTimeout(async () => {
        this.mediaGroups.delete(key);
        await this.handleMediaGroup(group.messages).catch((err) => {
          console.error("Media group error:", err);
          this.telegram.send(this.chatId, `❌ 处理图片组失败: ${err.message}`);
        });
      }, 1200);
      this.mediaGroups.set(key, group);
      return;
    }

    const media = await this.extractMedia(message);
    if (media) {
      this.telegram.setReaction(this.chatId, message.message_id, this.config.ackEmoji);
      if (message.voice && this.config.sttCommand) {
        try {
          const transcript = await runStt(this.config.sttCommand, media.saved.path);
          this.activeMessageIds.push(message.message_id);
          await this.prompt(`${transcript}${message.caption ? `\n\n${message.caption}` : ""}`);
          return;
        } catch (error) {
          return this.telegram.send(this.chatId, `❌ ${error.message}`);
        }
      }
      this.activeMessageIds.push(message.message_id);
      await this.prompt(attachmentPrompt(message.caption || `用户发送了${media.label}。`, [media.saved]), media.image ? [media.image] : undefined);
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
        await this.telegram.setReaction(this.chatId, message.message_id, [this.config.ackEmoji, this.config.doneEmoji]);
      }
    } else {
      this.activeMessageIds.push(message.message_id);
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
    if (files.length) {
      await this.prompt(attachmentPrompt(caption || "请查看这组文件。", files), images.length ? images : undefined);
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
    this.pendingUi = null;
    for (const group of this.mediaGroups.values()) {
      if (group.timer) clearTimeout(group.timer);
    }
    this.mediaGroups.clear();
    if (this.toolPanel?.timer) clearTimeout(this.toolPanel.timer);
    this.toolPanel = null;
    if (this.draft) {
      if (this.draft.timer) clearTimeout(this.draft.timer);
      if (this.draft.draftId !== null && this.draftSupport === "supported") {
        this.telegram.sendDraft(this.chatId, this.draft.draftId, "").catch(() => {});
      }
      if (this.draft.messageId) this.telegram.deleteMessage(this.chatId, this.draft.messageId).catch(() => {});
    }
    this.draft = null;
    this.queue = { steering: [], followUp: [] };
  }

  async prompt(message, images, streamingBehavior) {
    this.startTyping();
    try {
      const fields = { message };
      if (images) fields.images = images;
      const behavior = streamingBehavior || (this.isStreaming ? "steer" : undefined);
      if (behavior) fields.streamingBehavior = behavior;
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
      if (fields.streamingBehavior === "followUp") await this.telegram.send(this.chatId, "↪ 已加入 follow-up 队列", { disable_notification: true });
    } catch (error) {
      this.stopTyping();
      throw error;
    }
  }

  async handleCommand({ name, argument }, original) {
    switch (name) {
      case "start": case "help": return this.telegram.send(this.chatId, HELP);
      case "commands": return this.showCommands();
      case "cwd": return this.showCwds();
      case "model": return this.showModels(argument);
      case "thinking": return this.showThinking(argument);
      case "resume": return this.showSessions();
      case "reset":
      case "new": {
        this.resetSessionState();
        const result = await this.pi.request("new_session");
        if (result.cancelled) {
          this.queueTelegram(() => this.telegram.send(this.chatId, "新会话已取消"));
          return;
        }
        const state = await this.pi.request("get_state").catch(() => null);
        const text = formatSessionReset({ model: state?.model, cwd: this.config.cwd });
        this.queueTelegram(() => this.telegram.send(this.chatId, text));
        return;
      }
      case "name": {
        if (!argument) return this.telegram.send(this.chatId, "用法：/name <名称>");
        await this.pi.request("set_session_name", { name: argument });
        return this.telegram.send(this.chatId, `✅ 会话名：${argument}`);
      }
      case "session": case "status": return this.showSession();
      case "fork": return this.showForks();
      case "clone": {
        const result = await this.pi.request("clone");
        return this.telegram.send(this.chatId, result.cancelled ? "克隆已取消" : "✅ 已克隆当前分支");
      }
      case "compact": {
        this.startTyping();
        try {
          const result = await this.pi.request("compact", argument ? { customInstructions: argument } : {});
          return this.telegram.send(this.chatId, `✅ 已压缩：${result.tokensBefore} → 约 ${result.estimatedTokensAfter} tokens`);
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
        if (!argument) return this.telegram.send(this.chatId, "用法：/sh <命令>");
        if (/install\.sh\s+(restart|stop|uninstall)|launchctl\s+(bootout|kickstart)/i.test(argument)) {
          return this.telegram.send(this.chatId, "❌ 禁止在此执行服务重启/停止命令。如需重启 Gateway 请手动发送 /restart。");
        }
        this.startTyping();
        try {
          const res = await this.pi.request("bash", { command: argument });
          const output = res.output ? res.output.trim() : "（命令无输出）";
          if (output.split("\n").length > 3) {
            return this.telegram.send(this.chatId, expandableBlockquote(output));
          }
          return this.telegram.send(this.chatId, output);
        } catch (error) {
          return this.telegram.send(this.chatId, `❌ ${error.message}`);
        } finally {
          this.stopTyping();
        }
      }
      case "get": {
        if (!argument) return this.telegram.send(this.chatId, "用法：/get <相对路径>");
        const filePath = resolve(this.config.cwd, argument);
        try {
          const s = await stat(filePath);
          if (!s.isFile()) return this.telegram.send(this.chatId, "❌ 指定路径不是普通文件");
          if (s.size > 20 * 1024 * 1024) return this.telegram.send(this.chatId, "❌ 文件超过 20MB 限制");
          await this.telegram.sendDocument(this.chatId, filePath);
        } catch (error) {
          return this.telegram.send(this.chatId, `❌ 文件不存在或无法访问: ${error.message}`);
        }
        return;
      }
      case "followup": {
        if (!argument) return this.telegram.send(this.chatId, "用法：/followup <消息>");
        return this.prompt(argument, undefined, "followUp");
      }
      case "abort": {
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
        return this.telegram.send(this.chatId, clear ? "⏹ 已停止，队列已清空" : "⏹ 已停止（排队消息保留，/abort clear 可清空）");
      }
      case "restart": {
        await this.telegram.send(this.chatId, "🔄 正在重启 Gateway…");
        this.pi.stop();
        setTimeout(() => process.exit(0), 100);
        return;
      }
      case "queue": {
        if (argument === "clear") {
          const removed = this.pi.proc ? await this.pi.request("clear_queue").catch(() => ({ steering: [], followUp: [] })) : { steering: [], followUp: [] };
          this.queue = { steering: [], followUp: [] };
          return this.telegram.send(this.chatId, `已清空\nsteering: ${removed.steering.length}\nfollow-up: ${removed.followUp.length}`);
        }
        return this.telegram.send(this.chatId, `steering:\n${this.queue.steering.join("\n") || "（空）"}\n\nfollow-up:\n${this.queue.followUp.join("\n") || "（空）"}`);
      }
      default: {
        const alias = this.commandAliases.get(name);
        if (alias) return this.prompt(`/${alias}${argument ? ` ${argument}` : ""}`);
        const commands = await this.pi.request("get_commands");
        if (commands.commands.some((item) => item.name.toLowerCase() === name)) return this.prompt(original);
        return this.telegram.send(this.chatId, `未知命令：/${name}\n使用 /help 或 /commands`);
      }
    }
  }

  async registerBotCommands() {
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
  }

  async showCommands() {
    const data = await this.pi.request("get_commands");
    const text = data.commands.length
      ? data.commands.map((item) => `/${item.name}${item.description ? ` — ${item.description}` : ""}`).join("\n")
      : "没有加载扩展命令、Prompt Template 或 Skill。";
    await this.telegram.send(this.chatId, text);
  }

  async showCwds() {
    const projects = (await readdir(this.config.devRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .sort((a, b) => a.name.localeCompare(b.name));
    await this.telegram.send(this.chatId, `当前目录：${this.config.cwd}\n\n选择 ~/dev 下的项目：`, this.keyboard(projects.map((entry) => ({
      label: `${join(this.config.devRoot, entry.name) === this.config.cwd ? "●" : "○"} ${entry.name}`,
      action: { type: "cwd", path: join(this.config.devRoot, entry.name) },
    }))));
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
        return this.telegram.send(this.chatId, `✅ ${exact.provider}/${exact.id}`);
      }
    }
    const filtered = models.filter((model) => !query || `${model.provider}/${model.id} ${model.name}`.toLowerCase().includes(query.toLowerCase()));
    if (!filtered.length) return this.telegram.send(this.chatId, `没有匹配模型：${query}`);
    const display = filtered.slice(0, 18);
    const suffix = filtered.length > 18 ? `\n\n（共 ${filtered.length} 个模型，仅显示前 18 个，可用 /model 关键词 过滤）` : "";
    return this.telegram.send(this.chatId, `选择模型：${suffix}`, this.keyboard(display.map((model) => ({
      label: `${model.provider}/${model.id}`,
      action: { type: "model", provider: model.provider, modelId: model.id },
    }))));
  }

  async showThinking(argument) {
    const data = await this.pi.request("get_available_thinking_levels");
    if (argument) {
      if (!data.levels.includes(argument)) return this.telegram.send(this.chatId, `可用级别：${data.levels.join(", ")}`);
      await this.pi.request("set_thinking_level", { level: argument });
      return this.telegram.send(this.chatId, `✅ thinking: ${argument}`);
    }
    return this.telegram.send(this.chatId, "选择 thinking level：", this.keyboard(data.levels.map((level) => ({
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
    if (!sessions.length) return this.telegram.send(this.chatId, "当前目录还没有历史 Session。");
    return this.telegram.send(this.chatId, "选择 Session：", this.keyboard(sessions.map((session) => ({
      label: session.title,
      action: { type: "resume", path: session.path },
    }))));
  }

  async showSession() {
    const [state, stats] = await Promise.all([this.pi.request("get_state"), this.pi.request("get_session_stats")]);
    const model = state.model ? `${state.model.provider}/${state.model.id}` : "未选择";
    const context = stats.contextUsage ? `${stats.contextUsage.tokens ?? "?"}/${stats.contextUsage.contextWindow} (${stats.contextUsage.percent ?? "?"}%)` : "暂无";
    await this.telegram.send(this.chatId, [
      `名称：${state.sessionName || "（未命名）"}`, `模型：${model}`, `Thinking：${state.thinkingLevel}`,
      `状态：${state.isStreaming ? "working" : "idle"}`, `消息：${stats.totalMessages}`, `上下文：${context}`,
      `费用：$${Number(stats.cost || 0).toFixed(4)}`, `Session：${state.sessionId}`, `文件：${state.sessionFile || "未持久化"}`,
    ].join("\n"));
  }

  async showForks() {
    const data = await this.pi.request("get_fork_messages");
    const messages = data.messages.slice(-12).reverse();
    if (!messages.length) return this.telegram.send(this.chatId, "没有可分支的用户消息。");
    return this.telegram.send(this.chatId, "从哪条消息创建分支？", this.keyboard(messages.map((message) => ({
      label: message.text.replaceAll("\n", " ").slice(0, 60),
      action: { type: "fork", entryId: message.entryId },
    }))));
  }

  async handleCallback(callback) {
    const token = callback.data?.startsWith("a:") ? callback.data.slice(2) : "";
    const action = this.actions.get(token);
    this.actions.delete(token);
    if (!action || action.expires < Date.now()) return this.telegram.answer(callback.id, "操作已过期");
    try {
      if (action.type === "model") {
        await this.pi.request("set_model", { provider: action.provider, modelId: action.modelId });
        await this.telegram.send(this.chatId, `✅ ${action.provider}/${action.modelId}`);
      } else if (action.type === "thinking") {
        await this.pi.request("set_thinking_level", { level: action.level });
        await this.telegram.send(this.chatId, `✅ thinking: ${action.level}`);
      } else if (action.type === "resume") {
        if (this.isStreaming) await this.pi.request("abort").catch(() => {});
        this.resetSessionState();
        const result = await this.pi.request("switch_session", { sessionPath: action.path });
        await this.telegram.send(this.chatId, result.cancelled ? "恢复已取消" : "✅ 已恢复 Session");
      } else if (action.type === "fork") {
        if (this.isStreaming) await this.pi.request("abort").catch(() => {});
        this.resetSessionState();
        const result = await this.pi.request("fork", { entryId: action.entryId });
        await this.telegram.send(this.chatId, result.cancelled ? "分支已取消" : `✅ 已从「${result.text.slice(0, 80)}」创建分支`);
      } else if (action.type === "cwd") {
        await this.switchCwd(action.path, callback.id);
        return;
      } else if (action.type === "ui") {
        this.pi.write({ type: "extension_ui_response", id: action.requestId, ...action.response });
        if (callback.message) {
          const chosen = action.response?.value ?? (action.response?.confirmed ? "确认" : "取消");
          await this.telegram.edit(callback.message.chat.id, callback.message.message_id, `${callback.message.text}\n\n✅ ${chosen}`).catch(() => {});
        }
      }
      await this.telegram.answer(callback.id, "完成");
    } catch (error) {
      await this.telegram.answer(callback.id, "失败");
      await this.telegram.send(this.chatId, `❌ ${error.message}`);
    }
  }

  async switchCwd(path, callbackId) {
    const [root, target] = await Promise.all([realpath(this.config.devRoot), realpath(path)]);
    if (!isDirectChild(root, target) || !(await stat(target)).isDirectory()) throw new Error("只能切换到 ~/dev 的一级子目录");
    if (target === this.config.cwd) {
      await this.telegram.answer(callbackId, "已经在此目录");
      return;
    }

    const config = JSON.parse(await readFile(this.config.configPath, "utf8"));
    config.cwd = target;
    const temporary = `${this.config.configPath}.tmp`;
    await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.config.configPath);
    await this.telegram.answer(callbackId, "正在切换");
    await this.telegram.send(this.chatId, `✅ 工作目录已切换到：\n${target}\n\n正在热重启 Pi…`);
    this.pi.stop();
    this.config.cwd = target;
    this.config.sessionDir = join(this.config.stateDir, "sessions", target.replace(/^\//, "").replaceAll("/", "-"));
    await mkdir(this.config.sessionDir, { recursive: true, mode: 0o700 });
    this.resetSessionState();
    this.pi = new PiRpc(this.config, (event) => this.queueEvent(event));
    await this.pi.start();
    await this.registerBotCommands();
    const state = await this.pi.request("get_state");
    await this.telegram.send(this.chatId, `✅ Pi 已就绪；Session: ${state.sessionId}`);
  }

  async handleEvent(event) {
    if (event.type === "agent_start") {
      this.isStreaming = true;
      this.pendingUi = null;
      this.repliedInRun = false;
      this.startTyping();
      if (this.toolPanel?.timer) clearTimeout(this.toolPanel.timer);
      this.toolPanel = null;
    }
    if (event.type === "agent_settled") {
      this.isStreaming = false;
      this.pendingUi = null;
      this.stopTyping();
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
        this.queueTelegram(() => this.finishDraft(draft));
      }
      if (!this.repliedInRun) {
        this.queueTelegram(() => this.telegram.send(this.chatId, "⚠️ 模型未返回任何文本回复（可能是上游请求超时）。可使用 /model 切换模型或重试。"));
      }
      this.settleActiveReactions();
    }
    if (event.type === "queue_update") this.queue = { steering: event.steering, followUp: event.followUp };
    if (!this.chatReady) return;

    if (event.type === "auto_retry_start") {
      await this.telegram.send(this.chatId, `⏳ 模型响应异常，正在自动重试 (${event.attempt}/${event.maxAttempts})…`);
    }
    if (event.type === "compaction_end" && event.errorMessage) {
      await this.telegram.send(this.chatId, `⚠️ 上下文压缩失败: ${event.errorMessage}`);
    }

    if (event.type === "message_start" && event.message?.role === "assistant") {
      this.draft = { text: "", messageId: null, timer: null, draftId: null };
    }
    if (event.type === "message_update") {
      const update = event.assistantMessageEvent;
      if (update?.type === "text_delta" && this.draft) {
        this.draft.text += update.delta;
        if (!this.draft.timer) {
          const draft = this.draft;
          draft.timer = setTimeout(() => {
            draft.timer = null;
            this.queueTelegram(() => this.flushDraft(draft));
          }, 1200);
        }
      }
    }
    if (event.type === "message_end" && event.message?.role === "assistant") {
      const draft = this.draft || { text: "", messageId: null, timer: null };
      this.draft = null;
      if (draft.timer) clearTimeout(draft.timer);
      const content = extractText(event.message.content);
      if (content) draft.text = content;
      if (event.message.stopReason === "error" || event.message.errorMessage) {
        const errText = formatAssistantError(event.message.errorMessage);
        draft.text = draft.text ? `${draft.text}\n\n${errText}` : errText;
      }
      if (draft.text) {
        this.repliedInRun = true;
        this.queueTelegram(() => this.finishDraft(draft));
      }
    }

    if (event.type === "tool_execution_start") {
      if (!this.toolPanel) this.toolPanel = { messageId: null, tools: [], timer: null, sending: false };
      this.toolPanel.tools.push({
        id: event.toolCallId,
        summary: toolSummary(event.toolName, event.args),
        status: "running",
        startedAt: Date.now(),
      });
      this.scheduleToolPanelUpdate(false, false);
    }
    if (event.type === "tool_execution_end") {
      if (this.toolPanel) {
        const tool = this.toolPanel.tools.find((item) => item.id === event.toolCallId);
        if (tool) tool.status = event.isError ? "error" : "done";
        this.scheduleToolPanelUpdate(false, false);
      }
      if (event.toolName === "telegram_attach" && !event.isError) {
        const paths = event.result?.details?.paths || event.args?.paths || [];
        for (const path of paths) {
          this.queueTelegram(async () => {
            try { await this.telegram.sendDocument(this.chatId, path); }
            catch (error) { await this.telegram.send(this.chatId, `❌ 附件发送失败 ${basename(path)}: ${error.message}`); }
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
    try {
      if (this.toolPanel.messageId) {
        await this.telegram.edit(this.chatId, this.toolPanel.messageId, text);
      } else {
        const sent = await this.telegram.sendOne(this.chatId, text, { disable_notification: true });
        if (this.toolPanel) this.toolPanel.messageId = sent.message_id;
      }
    } finally {
      if (this.toolPanel) this.toolPanel.sending = false;
    }
  }

  async flushDraft(draft) {
    if (!draft.text || draft.flushing) return;
    draft.flushing = true;
    try {
      const text = previewText(draft.text);
      if (this.draftSupport !== "unsupported") {
        if (draft.draftId === null) draft.draftId = ++this.nextDraftId;
        try {
          await this.telegram.sendDraft(this.chatId, draft.draftId, text);
          this.draftSupport = "supported";
          return;
        } catch (error) {
          const msg = String(error.message || "");
          if (/not found|unknown method|404/i.test(msg)) {
            this.draftSupport = "unsupported";
            console.error("sendMessageDraft unavailable; falling back to send+edit:", error.message);
          } else {
            console.error("sendMessageDraft transient error:", error.message);
            if (this.draftSupport === "supported") return;
          }
        }
      }
      if (draft.messageId) await this.telegram.edit(this.chatId, draft.messageId, text, true);
      else draft.messageId = (await this.telegram.sendOne(this.chatId, text, { disable_notification: true })).message_id;
    } catch {
    } finally {
      draft.flushing = false;
    }
  }

  async finishDraft(draft) {
    if (!draft.text) return;
    if (this.draftSupport === "supported" && draft.draftId !== null) {
      await this.telegram.sendDraft(this.chatId, draft.draftId, "").catch(() => {});
    }
    if (draft.messageId) await this.telegram.deleteMessage(this.chatId, draft.messageId).catch(() => {});
    for (const part of chunks(draft.text)) await this.telegram.sendOne(this.chatId, part);
  }

  async handleUiRequest(request) {
    if (["select", "confirm"].includes(request.method)) {
      const options = request.method === "confirm" ? [
        { label: "确认", response: { confirmed: true } }, { label: "取消", response: { confirmed: false } },
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

  stop() {
    this.resetSessionState();
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
  assert.equal(isDirectChild("/Users/me/dev", "/Users/me/dev/project"), true);
  assert.equal(isDirectChild("/Users/me/dev", "/Users/me/dev/project/nested"), false);
  assert.equal(isDirectChild("/Users/me/dev", "/Users/me/other"), false);
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

  assert.ok(formatAssistantError("Codex error: The usage limit has been reached").includes("额度已用尽"));
  assert.ok(formatAssistantError("Rate limit exceeded").includes("速率限制"));
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
  assert.ok(renderToolPanel([{ summary: "bash: git status", status: "done" }], true).includes("✅ 已完成 1 项操作"));

  assert.equal(formatContextTokens(1048576), "1.0M");
  assert.equal(formatContextTokens(128000), "128K");
  assert.equal(formatContextTokens(8192), "8K");
  assert.equal(formatContextTokens(500), "500");
  assert.equal(extensionFromMime("audio/ogg"), ".ogg");
  assert.equal(extensionFromMime("weird/type"), "");
  assert.ok(attachmentPrompt("看看", [{ path: "/tmp/a b.txt" }]).includes("- /tmp/a b.txt"));
  assert.equal(previewText("ab"), "ab");
  assert.ok(previewText("x".repeat(5000)).endsWith("*(内容较长，输出中…)*"));
  assert.ok(previewText("x".repeat(5000)).length <= MAX_MESSAGE + 20);
  assert.equal(await runStt("printf %s $1", "/tmp/audio.ogg"), "/tmp/audio.ogg");

  {
    const gw = new Gateway({ allowedUserId: "1", botToken: "1:x", stateDir: tmpdir() });
    gw.telegram.sendDraft = async () => { throw new Error("fetch failed"); };
    gw.telegram.sendOne = async () => ({ message_id: 123 });
    const draft = { text: "hello", flushing: false, draftId: null, messageId: null };
    await gw.flushDraft(draft);
    assert.equal(gw.draftSupport, "unknown");

    gw.telegram.sendDraft = async () => { throw new Error("Telegram sendMessageDraft: Not Found"); };
    await gw.flushDraft(draft);
    assert.equal(gw.draftSupport, "unsupported");

    // Test telegram_attach auto delivery via tool_execution_end
    gw.chatReady = true;
    const docs = [];
    gw.telegram.sendDocument = async (_chat, path) => docs.push(path);
    await gw.handleEvent({
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "telegram_attach",
      isError: false,
      result: { details: { paths: ["/tmp/file1.png", "/tmp/file2.pdf"] } },
    });
    await gw.telegramChain;
    assert.deepEqual(docs, ["/tmp/file1.png", "/tmp/file2.pdf"]);
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

  {
    const tg = new Telegram("123456:fake-token", "/tmp/fake-offset");
    const calls = [];
    tg.call = async (method, body) => {
      calls.push({ method, body });
      if (body.reaction?.length > 1 && body.reaction[0].emoji === "fail_multi") {
        throw new Error("Telegram setMessageReaction: too many reactions");
      }
      return true;
    };

    await tg.setReaction(123, 456, "👀");
    assert.deepEqual(calls[0], {
      method: "setMessageReaction",
      body: { chat_id: 123, message_id: 456, reaction: [{ type: "emoji", emoji: "👀" }] },
    });

    await tg.setReaction(123, 456, ["👀", "🫡"]);
    assert.deepEqual(calls[1], {
      method: "setMessageReaction",
      body: { chat_id: 123, message_id: 456, reaction: [{ type: "emoji", emoji: "👀" }, { type: "emoji", emoji: "🫡" }] },
    });

    await tg.setReaction(123, 456, ["fail_multi", "🫡"]);
    assert.deepEqual(calls[3], {
      method: "setMessageReaction",
      body: { chat_id: 123, message_id: 456, reaction: [{ type: "emoji", emoji: "🫡" }] },
    });
  }

  console.log("self-test: ok");
}

if (import.meta.main) {
  if (process.argv.includes("--self-test")) {
    await selfTest();
  } else {
    const gateway = new Gateway(loadConfig());
    for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { gateway.stop(); process.exit(0); });
    gateway.start().catch((error) => { console.error(error); gateway.stop(); process.exit(1); });
  }
}
