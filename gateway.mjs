#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { copyFile, appendFile, mkdir, readFile, readdir, realpath, rename, stat, truncate, unlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const MAX_MESSAGE = 1800;
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
/history [条数]      历史消息，默认 20，最多 50
/tree               查看 Session 树
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
  ["session", "Session 和费用"], ["history", "查看历史消息"],
  ["tree", "查看 Session 树"], ["fork", "从历史分支"], ["clone", "克隆当前分支"],
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

function telegramSkillName(piName) {
  return `skill_${piName.slice("skill:".length).toLowerCase().replace(/[^a-z0-9_]/g, "_")}`.slice(0, 32);
}

function telegramCommandName(command) {
  if (command.source === "skill") return telegramSkillName(command.name);
  return command.name.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 32);
}

function escapeTelegramMarkdown(text) {
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

function inlineTelegramMarkdown(text) {
  const placeholders = [];
  const hold = (rendered) => {
    const key = `\x1a${placeholders.length}\x1a`;
    placeholders.push(rendered);
    return key;
  };

  let s = text.replace(/(?<!`)(`+)([\s\S]+?)(?<!`)\1(?!`)/g, (_, ticks, code) => {
    let clean = code;
    if (clean.startsWith(" ") && clean.endsWith(" ") && clean.trim().length > 0) clean = clean.slice(1, -1);
    return hold(`\`${clean.replace(/[\\`]/g, "\\$&")}\``);
  });
  s = s.replace(/\[([^\]\n]+)\]\(([^)\n]+)\)/g, (_, label, url) => hold(`[${escapeTelegramMarkdown(label)}](${url.replace(/[\\)]/g, "\\$&")})`));
  s = s.replace(/\*\*([^*\n]+)\*\*/g, (_, content) => hold(`*${escapeTelegramMarkdown(content)}*`));
  s = s.replace(/~~([^~\n]+)~~/g, (_, content) => hold(`~${escapeTelegramMarkdown(content)}~`));
  s = s.replace(/(?<!\*)\*([^*\n\s](?:[^*\n]*[^*\n\s])?)\*(?!\*)/g, (_, content) => hold(`_${escapeTelegramMarkdown(content)}_`));
  s = s.replace(/(?<!\w)_(?!\s)([^_\n]+?)(?<!\s)_(?!\w)/g, (_, content) => hold(`_${escapeTelegramMarkdown(content)}_`));
  s = escapeTelegramMarkdown(s);
  while (/\x1a(\d+)\x1a/.test(s)) s = s.replace(/\x1a(\d+)\x1a/g, (_, index) => placeholders[Number(index)]);
  return s;
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

function expandableBlockquote(text) {
  const clean = String(text || "").trim();
  if (!clean) return "";
  const lines = clean.split("\n").map((line) => `>${line}`).join("\n");
  return `**${lines}||`;
}

function telegramMarkdown(text) {
  const blocks = [];
  const holdBlock = (rendered) => {
    const key = `\x1bBLOCK_${blocks.length}\x1b`;
    blocks.push(rendered);
    return key;
  };

  const fenceRegex = /^[ \t]{0,3}```([^\n]*)\n([\s\S]*?\n)?[ \t]{0,3}```[ \t]*$/gm;
  let s = text.replace(fenceRegex, (_, info, body) => {
    const lang = (info || "").trim().split(/\s+/)[0].replace(/[^a-zA-Z0-9_+-]/g, "");
    const code = (body || "").replace(/[\\`]/g, "\\$&").replace(/\n$/, "");
    return holdBlock(`\`\`\`${lang}\n${code}\n\`\`\``);
  });

  s = s.replace(/(?:^[ \t]*\|.+?\|[ \t]*$\n?)+/gm, (table) => {
    if (!/^[ \t]*\|[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)+\|[ \t]*$/m.test(table)) return table;
    const newline = table.endsWith("\n") ? "\n" : "";
    return holdBlock(`\`\`\`\n${table.trim().replace(/[\\`]/g, "\\$&")}\n\`\`\``) + newline;
  });

  s = s.replace(/^\*\*>\s?([\s\S]*?)\|\|$/gm, (_, content) => {
    const lines = content.split("\n").map((line) => {
      const clean = line.replace(/^>\s?/, "");
      return `>${inlineTelegramMarkdown(clean)}`;
    });
    return holdBlock(`**${lines.join("\n")}||`);
  });

  const renderLine = (line) => {
    if (line.includes("\x1bBLOCK_")) return line;
    let match = line.match(/^#{1,6}\s+(.+)$/);
    if (match) return `*${escapeTelegramMarkdown(match[1].trim())}*`;
    match = line.match(/^(\s*)[-*+]\s+(.+)$/);
    if (match) return `${match[1]}• ${inlineTelegramMarkdown(match[2])}`;
    match = line.match(/^(\s*)(\d+)\.\s+(.+)$/);
    if (match) return `${match[1]}${match[2]}\\. ${inlineTelegramMarkdown(match[3])}`;
    match = line.match(/^>\s?(.*)$/);
    if (match) return `>${inlineTelegramMarkdown(match[1])}`;
    return inlineTelegramMarkdown(line);
  };

  s = s.split("\n").map(renderLine).join("\n");
  while (/\x1bBLOCK_(\d+)\x1b/.test(s)) s = s.replace(/\x1bBLOCK_(\d+)\x1b/g, (_, index) => blocks[Number(index)]);
  return s;
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

function contentText(content, includeThinking = false) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (part.type === "text") return part.text;
    if (includeThinking && part.type === "thinking") return `💭 ${part.thinking}`;
    if (part.type === "toolCall") return `🔧 ${part.name} ${JSON.stringify(part.arguments)}`;
    if (part.type === "image") return "[图片]";
    return "";
  }).filter(Boolean).join("\n");
}

function assistantText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (part.type === "text" ? part.text : "")).filter(Boolean).join("\n");
}

function toolSummary(name, args = {}) {
  const val = args?.command || args?.path || args?.pattern || args?.query || (Array.isArray(args?.queries) && args.queries.join(", ")) || args?.url || Object.values(args || {}).find((v) => typeof v === "string");
  if (val) return `${name}: ${val}`;
  const json = JSON.stringify(args || {});
  return json && json !== "{}" ? `${name} ${json}` : name;
}

function renderToolPanel(tools, isSettled = false, now = Date.now()) {
  if (!tools.length) return "";
  const total = tools.length;
  const done = tools.filter((t) => t.status !== "running").length;
  const header = isSettled ? `🛠 已完成 ${total} 项操作` : `⚙️ 正在执行操作 (${done}/${total})…`;
  const recent = tools.slice(-6).map((t) => {
    const icon = t.status === "running" ? "⏳" : t.status === "error" ? "❌" : "✅";
    const summary = t.summary.length > 80 ? `${t.summary.slice(0, 77)}…` : t.summary;
    const seconds = t.startedAt ? Math.floor((now - t.startedAt) / 1000) : 0;
    const elapsed = t.status === "running" && seconds >= 30 ? ` · ${Math.floor(seconds / 60)}m ${seconds % 60}s` : "";
    return `• ${icon} ${summary}${elapsed}`;
  });
  const hidden = tools.length - recent.length;
  const prefix = hidden > 0 ? [`… 之前已完成 ${hidden} 项`] : [];
  const body = [...prefix, ...recent].join("\n");
  if (tools.length >= 3 || isSettled) {
    return `${header}\n${expandableBlockquote(body)}`;
  }
  return [header, ...prefix, ...recent].join("\n");
}

function entryText(entry) {
  if (entry.type === "message") {
    const message = entry.message;
    const labels = { user: "👤", assistant: "🤖", toolResult: "🔧", bashExecution: "⌨️" };
    const body = message.role === "bashExecution"
      ? `${message.command}\n${message.output}`
      : contentText(message.content);
    return `${labels[message.role] ?? message.role}: ${body || "（无文本内容）"}`;
  }
  if (entry.type === "compaction") return `📦 压缩：${entry.summary}`;
  if (entry.type === "branch_summary") return `🌿 分支摘要：${entry.summary}`;
  if (entry.type === "custom_message") return `📎 ${contentText(entry.content)}`;
  return "";
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
  const chars = [...text];
  return chars.slice(0, MAX_MESSAGE).join("") + (chars.length > MAX_MESSAGE ? "\n\n*(内容较长，输出中…)*" : "");
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
    doneEmoji: process.env.TELEGRAM_DONE_EMOJI || file.doneEmoji || "👍",
  };
  config.sessionDir = join(config.stateDir, "sessions", config.cwd.replace(/^\//, "").replaceAll("/", "-"));
  config.downloadsDir = join(config.stateDir, "downloads");
  config.spoolDir = join(config.stateDir, "spool");
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(config.botToken || "")) throw new Error(`Invalid botToken in ${path}`);
  if (!/^\d+$/.test(config.allowedUserId)) throw new Error(`Invalid allowedUserId in ${path}`);
  if (!existsSync(config.cwd)) throw new Error(`Pi working directory does not exist: ${config.cwd}`);
  if (!existsSync(config.devRoot)) throw new Error(`Project directory does not exist: ${config.devRoot}`);
  return config;
}

let rotatingLog = false;
async function rotateLog(logFile, maxSize = MAX_LOG_SIZE) {
  if (!logFile || rotatingLog) return;
  rotatingLog = true;
  try {
    const s = await stat(logFile);
    if (s.size >= maxSize) {
      await copyFile(logFile, `${logFile}.1`);
      await truncate(logFile, 0);
    }
  } catch {
  } finally {
    rotatingLog = false;
  }
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
      return await this.call("sendMessage", { chat_id: chatId, text: telegramMarkdown(plain), parse_mode: "MarkdownV2", ...extra });
    } catch (error) {
      if (!error.message.includes("can't parse entities")) throw error;
      console.error("Markdown parse fallback:", error.message);
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
      return await this.call("editMessageText", { chat_id: chatId, message_id: messageId, text: telegramMarkdown(plain), parse_mode: "MarkdownV2" }, timeout, maxAttempts);
    } catch (error) {
      if (error.message.includes("can't parse entities")) {
        console.error("Markdown parse fallback:", error.message);
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
    form.set("document", new Blob([await readFile(path)]), basename(path));
    const response = await fetch(`${this.base}/sendDocument`, { method: "POST", body: form, signal: AbortSignal.timeout(60_000) });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(`Telegram sendDocument: ${data.description || response.status}`);
  }

  async sendDraft(chatId, draftId, text) {
    // Bot API 9.5+; ephemeral streaming preview, replaced when the final message is sent.
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
    } catch (error) {
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
          // At-most-once is safer than running a coding instruction twice after a crash.
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

const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

class PiRpc {
  constructor(config, onEvent, isBusy) {
    this.config = config;
    this.onEvent = onEvent;
    this.isBusyCallback = isBusy || (() => false);
    this.pending = new Map();
    this.sequence = 0;
    this.closing = false;
    this.idleStopping = false;
    this.startingPromise = null;
    this.idleStoppingPromise = null;
    this.idleTimeoutMs = Number(process.env.REMOTE_PI_IDLE_TIMEOUT_MS) || DEFAULT_IDLE_TIMEOUT_MS;
    this.idleTimer = null;
  }

  isBusy() {
    return this.pending.size > 0 || this.isBusyCallback();
  }

  touch() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.closing || this.idleStopping || !this.proc) return;
    if (this.isBusy()) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (!this.isBusy()) this.stopIdle().catch((err) => console.error("Pi idle stop error:", err));
    }, this.idleTimeoutMs);
    this.idleTimer.unref();
  }

  async ensureStarted() {
    if (this.proc && !this.idleStopping) return;
    if (this.startingPromise) return this.startingPromise;
    this.startingPromise = (async () => {
      try {
        if (this.idleStoppingPromise) await this.idleStoppingPromise;
        await this.start();
      } finally {
        this.startingPromise = null;
      }
    })();
    return this.startingPromise;
  }

  async start() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.closing = false;
    this.idleStopping = false;
    const args = ["--mode", "rpc", "--continue", "--session-dir", this.config.sessionDir];
    if (this.config.approve) args.push("--approve");
    const extensionPath = join(dirname(fileURLToPath(import.meta.url)), "telegram-extension.mjs");
    if (existsSync(extensionPath)) args.push("-e", extensionPath);
    const env = { ...process.env, REMOTE_PI_GATEWAY: "1", REMOTE_PI_SPOOL: this.config.spoolDir, PATH: `${dirname(process.execPath)}:${process.env.PATH || "/usr/bin:/bin"}` };
    this.proc = spawn(this.config.piBin, args, { cwd: this.config.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    this.proc.stderr.pipe(process.stderr);
    await new Promise((resolveSpawn, reject) => {
      this.proc.once("spawn", resolveSpawn);
      this.proc.once("error", reject);
    });

    createInterface({ input: this.proc.stdout, crlfDelay: Infinity })
      .on("line", (line) => line && this.handleLine(line));
    this.proc.on("close", (code, signal) => {
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(new Error(`Pi exited (${code ?? signal})`));
      }
      this.pending.clear();
      this.proc = null;
      if (!this.closing && !this.idleStopping) {
        console.error(`Pi exited (${code ?? signal}); exiting so launchd can restart both.`);
        process.exitCode = 1;
        setTimeout(() => process.exit(1), 100);
      }
    });
    this.touch();
  }

  handleLine(line) {
    let value;
    try { value = JSON.parse(line); }
    catch { console.error("Invalid Pi RPC line:", line.slice(0, 500)); return; }
    if (value.type === "response" && value.id && this.pending.has(value.id)) {
      const pending = this.pending.get(value.id);
      this.pending.delete(value.id);
      clearTimeout(pending.timer);
      this.touch();
      value.success ? pending.resolve(value.data) : pending.reject(new Error(value.error || `${value.command} failed`));
    } else {
      this.onEvent(value);
    }
  }

  async request(type, fields = {}, timeout = 600_000) {
    await this.ensureStarted();
    this.touch();
    const id = `tg-${++this.sequence}`;
    return new Promise((resolveRequest, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.touch();
        reject(new Error(`Pi RPC ${type} timed out`));
      }, timeout);
      this.pending.set(id, { resolve: resolveRequest, reject, timer });
      this.write({ id, type, ...fields });
    }).finally(() => {
      this.touch();
    });
  }

  write(value) {
    if (!this.proc?.stdin?.writable) throw new Error("Pi RPC is not running");
    this.touch();
    this.proc.stdin.write(`${JSON.stringify(value)}\n`);
  }

  async stopProc() {
    if (!this.proc) return;
    const proc = this.proc;
    this.proc = null;
    proc.kill("SIGTERM");
    await new Promise((resolveClose) => {
      if (proc.killed || proc.exitCode !== null) return resolveClose();
      proc.once("close", resolveClose);
      setTimeout(resolveClose, 2000);
    });
  }

  async stopIdle() {
    if (!this.proc || this.closing || this.startingPromise) return;
    if (this.isBusy()) return;
    console.log(`${new Date().toISOString()} Pi RPC idle for ${Math.round(this.idleTimeoutMs / 60_000)}m; stopping subprocess to save memory.`);
    this.idleStopping = true;
    this.idleStoppingPromise = this.stopProc();
    try {
      await this.idleStoppingPromise;
    } finally {
      this.idleStopping = false;
      this.idleStoppingPromise = null;
    }
  }

  async stop() {
    this.closing = true;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    await this.stopProc();
  }
}

class Gateway {
  constructor(config) {
    this.config = config;
    this.chatId = config.allowedUserId;
    this.chatReady = false;
    this.telegram = new Telegram(config.botToken, join(config.stateDir, "telegram-offset"));
    this.pi = new PiRpc(config, (event) => this.queueEvent(event), () => this.isBusy());
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
    this.spoolOffset = 0;
    this.spoolInitialized = false;
    this.activeMessageIds = [];
  }

  isBusy() {
    return this.isStreaming || !!this.pendingUi || this.queue.steering.length > 0 || this.queue.followUp.length > 0;
  }

  async start() {
    await rotateLog(this.config.logFile);
    this.logTimer = setInterval(() => { rotateLog(this.config.logFile).catch(() => {}); }, 60_000);
    this.logTimer.unref();
    await Promise.all([
      mkdir(this.config.stateDir, { recursive: true, mode: 0o700 }),
      mkdir(this.config.sessionDir, { recursive: true, mode: 0o700 }),
      mkdir(this.config.downloadsDir, { recursive: true, mode: 0o700 }),
      mkdir(join(this.config.spoolDir, "answers"), { recursive: true, mode: 0o700 }),
    ]);
    await this.acquireLock();
    // A stale webhook makes getUpdates return nothing forever.
    await this.telegram.call("deleteWebhook", { drop_pending_updates: false }).catch(() => {});
    const me = await this.telegram.call("getMe");
    try { await this.telegram.call("getChat", { chat_id: this.chatId }); this.chatReady = true; }
    catch (error) { if (!error.message.includes("chat not found")) throw error; }
    await this.pi.start();
    const state = await this.pi.request("get_state");
    await this.registerBotCommands();
    console.log(`${new Date().toISOString()} @${me.username} ready; Pi session ${state.sessionId}`);
    const eventsPath = join(this.config.spoolDir, "events.jsonl");
    this.spoolTimer = setInterval(() => {
      this.consumeSpool(eventsPath).catch((error) => console.error("Extension spool:", error.message));
    }, 700);
    this.spoolTimer.unref();
    await this.telegram.poll((update) => this.handleUpdate(update));
  }

  // ponytail: check-then-write 有竞态窗口，防的是人手双开（相隔几秒），不是毫秒级并发
  async acquireLock() {
    const pidFile = join(this.config.stateDir, "gateway.pid");
    const pid = Number(await readFile(pidFile, "utf8").catch(() => 0));
    if (pid && pid !== process.pid) {
      let alive = false;
      try { process.kill(pid, 0); alive = true; } catch {}
      if (alive) throw new Error(`另一个 gateway 正在运行 (pid ${pid})。先 ./install.sh stop`);
    }
    await writeFile(pidFile, String(process.pid), { mode: 0o600 });
    this.pidFile = pidFile;
  }

  async consumeSpool(eventsPath) {
    const buffer = await readFile(eventsPath).catch(() => null);
    if (!buffer) return;
    // First successful read: start from the current end so stale events from a previous run aren't replayed.
    if (!this.spoolInitialized) {
      this.spoolInitialized = true;
      this.spoolOffset = buffer.length;
      return;
    }
    if (buffer.length < this.spoolOffset) this.spoolOffset = 0;
    const chunk = buffer.subarray(this.spoolOffset).toString("utf8");
    this.spoolOffset = buffer.length;
    for (const line of chunk.split("\n")) {
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      await this.handleSpoolEvent(event);
    }
    // ponytail: truncate instead of rotating; offset 0 re-inits to "current end" on the next tick
    if (buffer.length > 10 * 1024 * 1024) {
      await truncate(eventsPath).catch(() => {});
      this.spoolOffset = 0;
    }
  }

  async handleSpoolEvent(event) {
    if (event.type === "attach") {
      for (const path of event.paths || []) {
        await this.queueTelegram(async () => {
          try { await this.telegram.sendDocument(this.chatId, path); }
          catch (error) { await this.telegram.send(this.chatId, `❌ 附件发送失败 ${basename(path)}: ${error.message}`); }
        });
      }
    } else if (event.type === "ask") {
      const options = (event.options || []).slice(0, 8);
      await this.queueTelegram(() => this.telegram.send(this.chatId, event.question, this.keyboard(options.map((option) => ({
        label: option,
        action: { type: "ask", askId: event.id, answer: option, question: event.question },
      })))));
    }
  }

  async saveDownload(fileId, name) {
    const file = await this.telegram.call("getFile", { file_id: fileId });
    const response = await fetch(`${this.telegram.fileBase}/${file.file_path}`, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`Telegram download: ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    const safe = name.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80) || "file";
    const path = join(this.config.downloadsDir, `${Date.now()}-${safe}`);
    await writeFile(path, buffer);
    return { path, data: buffer.toString("base64") };
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
        // User tapped the native stop button on a streaming draft.
        await this.handleCommand({ name: "abort", argument: "" }, "/abort");
      }
    } catch (error) {
      console.error("Telegram input:", error);
      if (this.activeMessageIds.length) {
        const ids = [...this.activeMessageIds];
        this.activeMessageIds = [];
        for (const id of ids) {
          this.telegram.setReaction(this.chatId, id, [this.config.ackEmoji, this.config.doneEmoji]).catch(() => {});
        }
      }
      await this.telegram.send(this.chatId, `❌ ${error.message}`);
    }
  }

  async extractMedia(m) {
    if (m.photo?.length) {
      const saved = await this.saveDownload(m.photo.at(-1).file_id, `photo-${m.message_id}.jpg`);
      return { saved, image: { type: "image", data: saved.data, mimeType: "image/jpeg" }, label: "图片" };
    }
    const file = m.document || m.voice || m.video || m.video_note || m.audio || m.animation;
    if (!file) return null;
    const kind = m.voice ? "voice" : m.video_note ? "video_note" : m.audio ? "audio" : "file";
    const saved = await this.saveDownload(file.file_id, file.file_name || `${kind}-${m.message_id}${extensionFromMime(file.mime_type)}`);
    const image = file.mime_type?.startsWith("image/") ? { type: "image", data: saved.data, mimeType: file.mime_type || "image/jpeg" } : null;
    const label = m.voice ? "语音消息" : file.file_name ? `文件 ${file.file_name}` : kind;
    return { file, saved, image, label };
  }

  async handleMessage(message) {
    if (this.pendingUi && !message.text?.startsWith("/")) {
      const pending = this.pendingUi;
      this.pendingUi = null;
      this.telegram.setReaction(this.chatId, message.message_id, this.config.ackEmoji);
      this.pi.write({ type: "extension_ui_response", id: pending.id, value: message.text || message.caption || "" });
      await this.telegram.send(this.chatId, "已提交。 ");
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
    if (/^restart$/i.test(text)) {
      await this.telegram.send(this.chatId, "⚠️ 如需重启 Gateway，请手动发送 /restart 命令。");
      return;
    }

    this.telegram.setReaction(this.chatId, message.message_id, this.config.ackEmoji);

    const command = parseCommand(text);
    if (command) {
      if (command.name === "followup") {
        this.activeMessageIds.push(message.message_id);
      }
      try {
        await this.handleCommand(command, text);
        if (command.name !== "followup") {
          await this.telegram.setReaction(this.chatId, message.message_id, [this.config.ackEmoji, this.config.doneEmoji]);
        }
      } catch (error) {
        throw error;
      }
    } else {
      this.activeMessageIds.push(message.message_id);
      await this.prompt(text);
    }
  }

  async handleMediaGroup(messages) {
    const images = [];
    const files = [];
    let caption = "";
    for (const m of messages) {
      if (m.caption) caption = m.caption;
      const media = await this.extractMedia(m);
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
    if (this.toolPanel?.heartbeat) clearInterval(this.toolPanel.heartbeat);
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
    this.pi?.touch();
  }

  async prompt(message, images, streamingBehavior) {
    this.startTyping();
    try {
      const state = await this.pi.request("get_state").catch(() => null);
      if (state) this.isStreaming = state.isStreaming;
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
      case "history": return this.showHistory(argument);
      case "tree": return this.showTree();
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
        if (this.activeMessageIds.length) {
          const ids = [...this.activeMessageIds];
          this.activeMessageIds = [];
          for (const id of ids) {
            this.queueTelegram(() => this.telegram.setReaction(this.chatId, id, [this.config.ackEmoji, this.config.doneEmoji]));
          }
        }
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
    if (data.commands.some((item) => item.name === "git-commit-push")) {
      this.commandAliases.set("commit_push", "git-commit-push");
      this.commandAliases.set("gcp", "git-commit-push");
    }
    const finalCommands = commands.slice(0, 100);
    await this.telegram.call("setMyCommands", { commands: finalCommands });
    await this.telegram.call("setMyCommands", { commands: finalCommands, scope: { type: "all_private_chats" } });
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
    const sessions = [];
    for (const { path, name, mtime } of sorted) {
      try {
        const raw = await readFile(path, "utf8");
        let header;
        let title = "";
        for (const line of raw.split("\n")) {
          if (!line) continue;
          let entry;
          try { entry = JSON.parse(line); } catch { continue; }
          if (entry.type === "session") header = entry;
          if (entry.type === "session_info" && entry.name) title = entry.name;
          if (!title && entry.type === "message" && entry.message?.role === "user") title = contentText(entry.message.content).slice(0, 60);
          if (header && title) break;
        }
        if (header?.cwd === this.config.cwd) sessions.push({ path, id: header.id, title: title || name, mtime });
      } catch (error) { console.error(`Skipping session ${path}:`, error.message); }
    }
    return sessions;
  }

  async showSessions() {
    const sessions = (await this.sessionFiles()).slice(0, 12);
    if (!sessions.length) return this.telegram.send(this.chatId, "当前目录还没有历史 Session。 ");
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

  async showHistory(argument) {
    const count = Math.min(Math.max(Number(argument) || 20, 1), 50);
    const data = await this.pi.request("get_entries");
    const formatted = data.entries.map(entryText).filter(Boolean).slice(-count);
    await this.telegram.send(this.chatId, formatted.join("\n\n") || "暂无历史消息。 ");
  }

  async showTree() {
    const data = await this.pi.request("get_tree");
    const lines = [];
    const visit = (node, depth) => {
      if (lines.length >= 80) return;
      const entry = node.entry;
      const summary = entryText(entry).replaceAll("\n", " ").slice(0, 100) || entry.type;
      lines.push(`${"  ".repeat(depth)}${entry.id === data.leafId ? "●" : "○"} ${entry.id} ${summary}`);
      for (const child of node.children || []) visit(child, depth + 1);
    };
    for (const root of data.tree) visit(root, 0);
    if (lines.length >= 80) lines.push("…仅显示前 80 个节点");
    await this.telegram.send(this.chatId, lines.join("\n") || "Session 树为空。 ");
  }

  async showForks() {
    const data = await this.pi.request("get_fork_messages");
    const messages = data.messages.slice(-12).reverse();
    if (!messages.length) return this.telegram.send(this.chatId, "没有可分支的用户消息。 ");
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
      } else if (action.type === "ask") {
        await writeFile(join(this.config.spoolDir, "answers", `${action.askId}.json`), JSON.stringify({ answer: action.answer }));
        await this.telegram.edit(callback.message.chat.id, callback.message.message_id, `${action.question}\n\n✅ ${action.answer}`).catch(() => {});
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
    await this.pi.stop();
    this.config.cwd = target;
    this.config.sessionDir = join(this.config.stateDir, "sessions", target.replace(/^\//, "").replaceAll("/", "-"));
    await mkdir(this.config.sessionDir, { recursive: true, mode: 0o700 });
    this.resetSessionState();
    this.pi = new PiRpc(this.config, (event) => this.queueEvent(event), () => this.isBusy());
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
      this.pi?.touch();
      if (this.toolPanel?.timer) clearTimeout(this.toolPanel.timer);
      if (this.toolPanel?.heartbeat) clearInterval(this.toolPanel.heartbeat);
      this.toolPanel = null;
    }
    if (event.type === "agent_settled") {
      this.isStreaming = false;
      this.pendingUi = null;
      this.stopTyping();
      this.pi?.touch();
      if (this.toolPanel && this.toolPanel.tools.length) {
        if (this.toolPanel.heartbeat) clearInterval(this.toolPanel.heartbeat);
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
      if (this.activeMessageIds.length) {
        const ids = [...this.activeMessageIds];
        this.activeMessageIds = [];
        for (const id of ids) {
          this.queueTelegram(() => this.telegram.setReaction(this.chatId, id, [this.config.ackEmoji, this.config.doneEmoji]));
        }
      }
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
      const content = assistantText(event.message.content);
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
      if (!this.toolPanel) this.toolPanel = { messageId: null, tools: [], timer: null, heartbeat: null, sending: false };
      this.toolPanel.tools.push({
        id: event.toolCallId,
        summary: toolSummary(event.toolName, event.args),
        status: "running",
        startedAt: Date.now(),
      });
      if (!this.toolPanel.heartbeat) {
        const panel = this.toolPanel;
        panel.heartbeat = setInterval(() => {
          if (this.toolPanel === panel) this.queueTelegram(() => this.flushToolPanel(false));
        }, 30_000);
        panel.heartbeat.unref();
      }
      this.scheduleToolPanelUpdate(false, false);
    }
    if (event.type === "tool_execution_end") {
      if (this.toolPanel) {
        const tool = this.toolPanel.tools.find((item) => item.id === event.toolCallId);
        if (tool) tool.status = event.isError ? "error" : "done";
        if (!this.toolPanel.tools.some((item) => item.status === "running") && this.toolPanel.heartbeat) {
          clearInterval(this.toolPanel.heartbeat);
          this.toolPanel.heartbeat = null;
        }
        this.scheduleToolPanelUpdate(false, false);
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
      // Fallback preview: silent real message edited in place; finishDraft deletes it and sends the final answer.
      if (draft.messageId) await this.telegram.edit(this.chatId, draft.messageId, text, true);
      else draft.messageId = (await this.telegram.sendOne(this.chatId, text, { disable_notification: true })).message_id;
    } catch {
    } finally {
      draft.flushing = false;
    }
  }

  async finishDraft(draft) {
    if (!draft.text) return;
    // Dismiss the preview; the final answer is sent fresh so the phone rings once.
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
    if (this.logTimer) clearInterval(this.logTimer);
    if (this.spoolTimer) clearInterval(this.spoolTimer);
    try { unlinkSync(this.pidFile); } catch {}
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
  assert.equal(telegramSkillName("skill:grill-me"), "skill_grill_me");
  assert.equal(telegramSkillName(`skill:${"a".repeat(40)}`).length, 32);
  assert.equal(telegramCommandName({ name: "git-commit-push", source: "extension" }), "git_commit_push");
  assert.equal(telegramCommandName({ name: "skill:grill-me", source: "skill" }), "skill_grill_me");
  assert.equal(telegramMarkdown("### Status!\n- **ready** and `a_b`"), "*Status\\!*\n• *ready* and `a_b`");
  assert.equal(telegramMarkdown("```js\na_b();\n```"), "```js\na_b();\n```");
  assert.ok(telegramMarkdown("| A | B |\n|---|---|\n| 1 | 2 |").includes("```\n| A | B |\n|---|---|\n| 1 | 2 |\n```"));
  assert.equal(
    telegramMarkdown("- code: `/```([^\\n]*)\\n?([\\s\\S]*?)```/` and ```` ```lang ````"),
    "• code: `/\\`\\`\\`([^\\\\n]*)\\\\n?([\\\\s\\\\S]*?)\\`\\`\\`/` and `\\`\\`\\`lang`"
  );
  assert.equal(telegramMarkdown("**`code`**"), "*`code`*");
  assert.equal(expandableBlockquote("line 1\nline 2"), "**>line 1\n>line 2||");
  assert.equal(
    telegramMarkdown(expandableBlockquote("line 1\nline 2")),
    "**>line 1\n>line 2||"
  );
  assert.ok(formatAssistantError("Codex error: The usage limit has been reached").includes("额度已用尽"));
  assert.ok(formatAssistantError("Rate limit exceeded").includes("速率限制"));
  assert.equal(formatAssistantError("Network failure"), "❌ Network failure");
  assert.equal(retryableTelegramStatus(429), true);
  assert.equal(retryableTelegramStatus(500), true);
  assert.equal(retryableTelegramStatus(400), false);
  const original = "a".repeat(4000) + "🐈";
  assert.equal(chunks(original).join(""), original);
  assert.ok(chunks(original).every((part) => [...part].length <= MAX_MESSAGE));
  const fenced = "```js\n" + "const a = 1;\n".repeat(10) + "```";
  const fencedChunks = chunks(fenced, 60);
  assert.ok(fencedChunks.length > 1);
  assert.ok(fencedChunks[0].endsWith("```"));
  assert.ok(fencedChunks[1].startsWith("```js\n"));
  assert.equal(contentText([{ type: "text", text: "hi" }, { type: "toolCall", name: "read", arguments: { path: "x" } }]), 'hi\n🔧 read {"path":"x"}');
  assert.equal(assistantText([{ type: "text", text: "hi" }, { type: "toolCall", name: "read", arguments: { path: "x" } }]), "hi");
  assert.equal(toolSummary("bash", { command: "git status" }), "bash: git status");
  assert.equal(toolSummary("read", { path: "foo.txt" }), "read: foo.txt");
  assert.ok(renderToolPanel([{ summary: "bash: git status", status: "running" }]).includes("⏳"));
  assert.ok(renderToolPanel([{ summary: "web_search", status: "running", startedAt: 1_000 }], false, 66_000).includes("1m 5s"));
  assert.ok(renderToolPanel([{ summary: "bash: git status", status: "done" }], true).includes("🛠 已完成 1 项操作"));
  const mockPi = new PiRpc({ sessionDir: "/tmp" }, () => {}, () => false);
  mockPi.proc = { kill: () => {} };
  assert.equal(mockPi.isBusy(), false);
  mockPi.touch();
  assert.ok(mockPi.idleTimer !== null);
  mockPi.isBusyCallback = () => true;
  assert.equal(mockPi.isBusy(), true);
  mockPi.touch();
  assert.equal(mockPi.idleTimer, null);
  assert.equal(formatContextTokens(1048576), "1.0M");
  assert.equal(formatContextTokens(128000), "128K");
  assert.equal(formatContextTokens(8192), "8K");
  assert.equal(formatContextTokens(500), "500");
  assert.equal(extensionFromMime("audio/ogg"), ".ogg");
  assert.equal(extensionFromMime("weird/type"), "");
  assert.ok(attachmentPrompt("看看", [{ path: "/tmp/a b.txt" }]).includes("- /tmp/a b.txt"));
  assert.equal(previewText("ab"), "ab");
  assert.ok(previewText("x".repeat(4000)).endsWith("*(内容较长，输出中…)*"));
  assert.ok([...previewText("x".repeat(4000))].length <= MAX_MESSAGE + 20);
  assert.equal(await runStt("printf %s $1", "/tmp/audio.ogg"), "/tmp/audio.ogg");
  {
    const gw = new Gateway({ allowedUserId: "1", botToken: "1:x", stateDir: tmpdir() });
    const sent = [];
    gw.telegram = { send: async (_chat, text) => sent.push(text), sendDocument: async (_chat, path) => sent.push(`doc:${path}`) };
    const eventsPath = join(tmpdir(), `remote-pi-spool-${Date.now()}.jsonl`);
    await writeFile(eventsPath, "");
    await gw.consumeSpool(eventsPath);
    await appendFile(eventsPath, `${JSON.stringify({ type: "attach", paths: ["/tmp/a.txt"] })}\n${JSON.stringify({ type: "ask", id: "ask-1", question: "选一个", options: ["甲", "乙"] })}\n`);
    await gw.consumeSpool(eventsPath);
    await gw.consumeSpool(eventsPath);
    assert.deepEqual(sent, ["doc:/tmp/a.txt", "选一个"]);
    await unlink(eventsPath);

    gw.telegram.sendDraft = async () => { throw new Error("fetch failed"); };
    gw.telegram.sendOne = async () => ({ message_id: 123 });
    const draft = { text: "hello", flushing: false, draftId: null, messageId: null };
    await gw.flushDraft(draft);
    assert.equal(gw.draftSupport, "unknown");

    gw.telegram.sendDraft = async () => { throw new Error("Telegram sendMessageDraft: Not Found"); };
    await gw.flushDraft(draft);
    assert.equal(gw.draftSupport, "unsupported");
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
  console.log("self-test: ok");
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

    await tg.setReaction(123, 456, ["👀", "👍"]);
    assert.deepEqual(calls[1], {
      method: "setMessageReaction",
      body: { chat_id: 123, message_id: 456, reaction: [{ type: "emoji", emoji: "👀" }, { type: "emoji", emoji: "👍" }] },
    });

    await tg.setReaction(123, 456, ["fail_multi", "👍"]);
    assert.deepEqual(calls[3], {
      method: "setMessageReaction",
      body: { chat_id: 123, message_id: 456, reaction: [{ type: "emoji", emoji: "👍" }] },
    });
  }
  const tmpLog = join(tmpdir(), `test-remote-pi-rot-${Date.now()}.log`);
  await writeFile(tmpLog, "x".repeat(20));
  await rotateLog(tmpLog, 10);
  assert.equal((await stat(tmpLog)).size, 0);
  assert.equal((await stat(`${tmpLog}.1`)).size, 20);
  await unlink(tmpLog);
  await unlink(`${tmpLog}.1`);
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
