#!/usr/bin/env node

import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, openAsBlob, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, readdir, realpath, rename, stat, truncate, unlink, writeFile } from "node:fs/promises";
import net from "node:net";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import MarkdownIt from "markdown-it";
import { readJsonLines, writeJsonLine } from "./remote-pi.ts";

const MAX_MESSAGE = 4000;
const MAX_LOG_SIZE = 5 * 1024 * 1024;
let HERDR_DISABLED_FOR_TEST = false;

function setTestMode(on) {
  HERDR_DISABLED_FOR_TEST = Boolean(on);
}
let stateWriteCounter = 0;
const HELP = `Remote Pi

Just send text to chat with Pi; messages sent while it is working act as steering.

/help               Show help and extension, prompt & skill commands
/cwd [path]         Switch workspace; no argument shows recent projects
/topic [path]       Start a new topic session (parallel task)
/close              Close current topic session
/sh <command>       Run a shell command directly
/get <path>         Download a file from the workspace
/model [query|provider/model]
/thinking [level]
/resume             Pick a past session
/new                New session
/status             Current model, session, tokens & cost
/agents             Status of all Herdr agents (📡 = pushed here)
/fork               Branch from a past user message
/compact [focus]    Compact the context
/export             Export as HTML
/abort              Stop current task (queue kept)
/queue [clear]      View/reset queue display (native queue unavailable)
/followup <text>    Queue a follow-up prompt
/git_commit_push [extra] Stage, commit, and push changes

Admin
/name <name>        Name the session
/restart            Restart the gateway
/upgrade            Upgrade gateway to latest (git pull + self-test + restart)`;

const BOT_COMMANDS = [
  ["help", "Help"],
  ["cwd", "Switch workspace or show history"],
  ["topic", "New topic session"], ["close", "Close current topic"],
  ["sh", "Run a shell command"], ["get", "Download a file"],
  ["model", "View or switch model"], ["thinking", "View or set thinking level"],
  ["resume", "Resume a past session"], ["new", "New session"],
  ["status", "Session status, tokens & cost"], ["agents", "Herdr agent status"],
  ["fork", "Branch from history"],
  ["compact", "Compact context"], ["export", "Export as HTML"],
  ["abort", "Stop task (queue kept)"],
  ["queue", "View or reset queue display"],
  ["followup", "Queue a follow-up"],
  ["git_commit_push", "Stage, commit and push"],
  // ref: https://core.telegram.org/bots/api#setmycommands — publish /restart in the slash menu.
  ["restart", "Restart the gateway"],
].map(([command, description]) => ({ command, description }));
const RESERVED_COMMANDS = new Set([...BOT_COMMANDS.map((c) => c.command), "start", "commands", "name", "upgrade", "git-commit-push"]);

function parseCommand(text) {
  const match = text.match(/^\/([\w:-]+)(?:@\w+)?(?:\s+([\s\S]*))?$/);
  return match ? { name: match[1].toLowerCase(), argument: match[2]?.trim() ?? "" } : null;
}

function getUpdatePriority(update) {
  const text = update?.message?.text?.trim();
  if (!text) return "p2";
  const cmd = parseCommand(text);
  if (!cmd) return "p2";
  if (["abort", "restart", "new"].includes(cmd.name)) return "p0";
  if (["status", "queue", "help", "start", "commands"].includes(cmd.name)) return "p1";
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

const htmlRenderer = new MarkdownIt({ html: false, linkify: true });

function extractTitle(markdown) {
  const lines = String(markdown || "").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    const headingMatch = trimmed.match(/^#{1,6}\s+(.+?)(?:\s+#+)?$/);
    if (headingMatch) {
      return headingMatch[1].trim().slice(0, 60);
    }
  }
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed) {
      return trimmed.slice(0, 60);
    }
  }
  return "Reply";
}

function renderReplyHtml(markdown) {
  const title = extractTitle(markdown);
  const content = htmlRenderer.render(markdown || "");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
:root {
  --bg: #ffffff;
  --fg: #1f2328;
  --code-bg: #f6f8fa;
  --border: #d0d7de;
  --th-bg: #f6f8fa;
  --link: #0969da;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0d1117;
    --fg: #e6edf3;
    --code-bg: #161b22;
    --border: #30363d;
    --th-bg: #161b22;
    --link: #2f81f7;
  }
}
body {
  box-sizing: border-box;
  max-width: 760px;
  margin: 0 auto;
  padding: 16px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  line-height: 1.6;
  background: var(--bg);
  color: var(--fg);
}
a { color: var(--link); }
pre {
  background: var(--code-bg);
  padding: 12px;
  border-radius: 6px;
  overflow-x: auto;
}
code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 0.9em;
}
pre code {
  font-size: 0.85em;
}
table {
  display: block;
  overflow-x: auto;
  border-collapse: collapse;
  margin: 16px 0;
  width: 100%;
}
th, td {
  border: 1px solid var(--border);
  padding: 8px 12px;
  text-align: left;
}
th {
  background: var(--th-bg);
}
blockquote {
  margin: 0;
  padding: 0 1em;
  opacity: 0.85;
  border-left: 4px solid var(--border);
}
img { max-width: 100%; }
</style>
</head>
<body>
${content}
</body>
</html>`;
}

function formatStamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function nextFallbackModel(list, current) {
  if (!Array.isArray(list) || !list.length) return null;
  const currentStr = typeof current === "string"
    ? current
    : (current && current.provider ? `${current.provider}/${current.modelId || current.id}` : "");
  const idx = list.indexOf(currentStr);
  if (idx !== -1) {
    for (let i = 1; i <= list.length; i++) {
      const candidate = list[(idx + i) % list.length];
      if (candidate && candidate !== currentStr) return candidate;
    }
    return null;
  }
  for (const candidate of list) {
    if (candidate && candidate !== currentStr) return candidate;
  }
  return null;
}

function redactLog(text, botToken = "") {
  let result = String(text || "");
  if (botToken) {
    result = result.replaceAll(botToken, "[REDACTED]");
  }
  return result.replace(/(api[_-]?key|token|secret|authorization)\S*\s*[:=]\s*\S+/gi, "[REDACTED]");
}

function errorActions(session, errorText, { endedRun = false } = {}) {
  const ONE_HOUR = 60 * 60_000;
  const isRateOrQuota = /429|rate.?limit|quota|exhausted/i.test(errorText || "");
  const targetModel = nextFallbackModel(session.gateway.config.fallbackModels || [], session.lastModel);
  const canRetry = !!session.lastPrompt && (!session.isStreaming || endedRun);

  const buttons = [];
  const retryBtn = canRetry ? {
    label: "🔁 Retry",
    action: { type: "retry" },
  } : null;

  const fallbackBtn = (canRetry && targetModel) ? {
    label: `🔀 Retry with ${targetModel}`,
    action: { type: "retry_fallback", model: targetModel },
  } : null;

  // 429/限流/配额场景优先推荐切模型重试
  if (isRateOrQuota && fallbackBtn) {
    buttons.push(fallbackBtn);
    if (retryBtn) buttons.push(retryBtn);
  } else {
    if (retryBtn) buttons.push(retryBtn);
    if (fallbackBtn) buttons.push(fallbackBtn);
  }

  buttons.push({ label: "🧠 Models", action: { type: "models" } });
  buttons.push({ label: "♻️ Restart Pi", action: { type: "restart_pi" } });
  buttons.push({ label: "📜 Log", action: { type: "show_log" } });

  return session.keyboard(buttons, ONE_HOUR);
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

function formatDuration(ms) {
  if (typeof ms !== "number" || isNaN(ms) || ms < 0) return null;
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m < 60) return `${m}m${s}s`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return `${h}h${remM}m${s}s`;
}

function formatTokensDelta(tokens) {
  if (typeof tokens !== "number" || isNaN(tokens)) return null;
  if (tokens >= 1_000_000) {
    const val = (tokens / 1_000_000).toFixed(1).replace(/\.0$/, "");
    return `${val}M tok`;
  }
  if (tokens >= 1_000) {
    const val = (tokens / 1_000).toFixed(1).replace(/\.0$/, "");
    return `${val}k tok`;
  }
  return `${tokens} tok`;
}

function formatRunCard({ durationMs, costDelta, tokensDelta, ctxPercent, files } = {}) {
  const parts = ["✅ Done"];
  const dur = formatDuration(durationMs);
  if (dur) parts.push(dur);

  if (typeof costDelta === "number" && !isNaN(costDelta)) {
    parts.push(costDelta >= 0 ? `+$${costDelta.toFixed(2)}` : `-$${Math.abs(costDelta).toFixed(2)}`);
  }

  const tok = formatTokensDelta(tokensDelta);
  if (tok) parts.push(tok);

  if (typeof ctxPercent === "number" && !isNaN(ctxPercent)) {
    parts.push(`ctx ${Math.round(ctxPercent)}%`);
  }

  const header = parts.join(" · ");
  if (!files || !Array.isArray(files) || files.length === 0) {
    return header;
  }

  let totalAdded = 0;
  let totalDeleted = 0;
  for (const f of files) {
    totalAdded += (f.added || 0);
    totalDeleted += (f.deleted || 0);
  }

  const countLabel = files.length === 1 ? "1 file" : `${files.length} files`;
  const lines = [header, "", `📝 ${countLabel} changed this run (+${totalAdded} \u2212${totalDeleted})`];
  const maxDisplay = Math.min(files.length, 8);
  for (let i = 0; i < maxDisplay; i++) {
    const f = files[i];
    if (f.untracked || f.new || f.status === "new") {
      lines.push(`• ${f.path} new`);
    } else if (f.binary) {
      lines.push(`• ${f.path} binary`);
    } else {
      lines.push(`• ${f.path} +${f.added || 0} \u2212${f.deleted || 0}`);
    }
  }
  if (files.length > 8) {
    lines.push(`…and ${files.length - 8} more`);
  }
  return lines.join("\n");
}

// ref: git-diff docs `-z` / `--numstat` ("pathnames are output verbatim, NUL-terminated"); git-config core.quotePath.
function parseNumstat(text) {
  if (!text || typeof text !== "string") return [];
  const tokens = text.split("\0");
  const result = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token) continue;
    const tabIdx1 = token.indexOf("\t");
    if (tabIdx1 === -1) continue;
    const tabIdx2 = token.indexOf("\t", tabIdx1 + 1);
    if (tabIdx2 === -1) continue;
    const addStr = token.slice(0, tabIdx1);
    const delStr = token.slice(tabIdx1 + 1, tabIdx2);
    const rest = token.slice(tabIdx2 + 1);
    const binary = addStr === "-" && delStr === "-";
    const added = binary ? 0 : parseInt(addStr, 10) || 0;
    const deleted = binary ? 0 : parseInt(delStr, 10) || 0;

    if (rest === "") {
      const oldPath = tokens[++i];
      const path = tokens[++i];
      if (oldPath !== undefined && path !== undefined) {
        result.push({ path, added, deleted, binary, oldPath });
      }
    } else {
      result.push({ path: rest, added, deleted, binary });
    }
  }
  return result;
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
  if (!existsSync(statePath)) return { cwd: null, recentProjects: [], topics: {}, herdrPanes: {} };
  try {
    const raw = JSON.parse(readFileSync(statePath, "utf8"));
    const topics = {};
    if (typeof raw.topics === "object" && raw.topics !== null) {
      for (const [threadId, info] of Object.entries(raw.topics)) {
        if (typeof info?.cwd === "string" && existsSync(info.cwd)) {
          topics[threadId] = { cwd: info.cwd };
        }
      }
    }
    const herdrPanes = {};
    if (typeof raw.herdrPanes === "object" && raw.herdrPanes !== null) {
      for (const [key, paneId] of Object.entries(raw.herdrPanes)) {
        if (typeof paneId === "string" && paneId) {
          herdrPanes[key] = paneId;
        } else if (paneId && typeof paneId === "object" && typeof paneId.cwd === "string") {
          herdrPanes[key] = {
            cwd: paneId.cwd,
            ...(typeof paneId.paneId === "string" ? { paneId: paneId.paneId } : {}),
            ...(typeof paneId.sessionFile === "string" ? { sessionFile: paneId.sessionFile } : {}),
            ...(typeof paneId.workspaceId === "string" ? { workspaceId: paneId.workspaceId } : {}),
            owned: paneId.owned === true,
          };
        }
      }
    }
    return {
      cwd: typeof raw.cwd === "string" ? raw.cwd : null,
      recentProjects: Array.isArray(raw.recentProjects)
        ? raw.recentProjects.filter((p) => typeof p === "string" && existsSync(p))
        : [],
      topics,
      herdrPanes,
      pendingRestartMessageId: Number.isSafeInteger(raw.pendingRestartMessageId) && raw.pendingRestartMessageId > 0
        ? raw.pendingRestartMessageId : null,
    };
  } catch {
    return { cwd: null, recentProjects: [], topics: {}, herdrPanes: {} };
  }
}

function shellQuote(str) {
  return `'${String(str).replaceAll("'", "'\\''")}'`;
}

async function readFirstLine(filePath) {
  let fh;
  try {
    fh = await open(filePath, "r");
    const buf = Buffer.alloc(4096);
    const { bytesRead } = await fh.read(buf, 0, 4096, 0);
    const str = buf.toString("utf8", 0, bytesRead);
    const nl = str.indexOf("\n");
    return nl === -1 ? str : str.slice(0, nl);
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

async function parseSessionHeader(filePath) {
  try {
    const firstLine = await readFirstLine(filePath);
    if (!firstLine) return null;
    const header = JSON.parse(firstLine);
    return header?.type === "session" ? header : null;
  } catch {
    return null;
  }
}

async function parseSessionPreview(filePath) {
  try {
    const fh = await open(filePath, "r");
    const buf = Buffer.alloc(16384);
    const { bytesRead } = await fh.read(buf, 0, 16384, 0);
    await fh.close();
    const raw = buf.toString("utf8", 0, bytesRead);
    let title = "";
    for (const line of raw.split("\n", 20)) {
      if (!line) continue;
      let entry;
      try { entry = JSON.parse(line); } catch {
        const m = line.match(/"role"\s*:\s*"user"[\s\S]*?"text"\s*:\s*"([^"\\]{1,60})/);
        if (m) title = m[1];
        continue;
      }
      if (entry.type === "session_info" && entry.name) title = entry.name;
      if (!title && entry.type === "message" && entry.message?.role === "user") {
        title = extractText(entry.message.content).slice(0, 60);
      }
      if (title) break;
    }
    return title;
  } catch {
    return "";
  }
}

function encodeCwdSessionDir(baseDir, cwd) {
  const slug = cwd.replace(/^[/\\]+/, "").replace(/[/\\:]/g, "-");
  return join(baseDir, `--${slug}--`);
}

async function scanDesktopSessions(desktopDir, targetCwd, limit = 10) {
  if (!desktopDir || !targetCwd) return [];
  const dir = encodeCwdSessionDir(desktopDir, targetCwd);
  if (!existsSync(dir)) return [];
  let names;
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith(".jsonl"));
  } catch {
    return [];
  }
  const matched = [];
  for (const name of names) {
    const path = join(dir, name);
    try {
      const header = await parseSessionHeader(path);
      if (header?.cwd === targetCwd) {
        const fileStat = await stat(path).catch(() => null);
        if (fileStat) {
          matched.push({ path, mtime: fileStat.mtimeMs, id: header.id });
        }
      }
    } catch {}
  }
  matched.sort((a, b) => b.mtime - a.mtime);
  const sliced = matched.slice(0, limit);
  return Promise.all(sliced.map(async (item) => {
    const title = (await parseSessionPreview(item.path)) || basename(item.path);
    return { ...item, title };
  }));
}

function parseNumberConfig(envVal, fileVal, defaultVal, { min, integer = false } = {}) {
  const raw = envVal !== undefined ? envVal : fileVal;
  if (raw === undefined || raw === null || raw === "") return defaultVal;
  const num = Number(raw);
  if (!Number.isFinite(num)) return defaultVal;
  if (integer && !Number.isInteger(num)) return defaultVal;
  if (min !== undefined && num < min) return defaultVal;
  return num;
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

  const stateDir = resolvePath(file.stateDir || join(homedir(), ".local", "var", "remote-pi"), configDir);
  const savedState = loadState(stateDir);

  let targetCwd = process.env.PI_CWD
    ? resolvePath(process.env.PI_CWD, configDir)
    : savedState.cwd || (file.cwd ? resolvePath(file.cwd, configDir) : null);
  if (!targetCwd) throw new Error(`"cwd" is required: set "cwd" in ${path} or export PI_CWD`);

  const telegram = typeof file.telegram === "object" && file.telegram !== null ? file.telegram : {};
  const envLongReply = process.env.REMOTE_PI_LONG_REPLY_CHARS;
  const longReplyChars = envLongReply !== undefined
    ? Number(envLongReply)
    : (file.longReplyChars !== undefined ? Number(file.longReplyChars) : 8000);

  let fallbackModels = [];
  if (process.env.REMOTE_PI_FALLBACK_MODELS !== undefined) {
    fallbackModels = process.env.REMOTE_PI_FALLBACK_MODELS.split(",").map((s) => s.trim()).filter(Boolean);
  } else if (Array.isArray(file.fallbackModels)) {
    fallbackModels = file.fallbackModels.map((s) => String(s).trim()).filter(Boolean);
  }

  const presenceFile = (process.env.REMOTE_PI_PRESENCE_FILE || file.presenceFile)
    ? resolvePath(process.env.REMOTE_PI_PRESENCE_FILE || file.presenceFile, configDir)
    : "";

  const config = {
    botToken: process.env.TELEGRAM_BOT_TOKEN || telegram.botToken,
    allowedUserId: String(process.env.TELEGRAM_ALLOWED_USER_ID || telegram.allowedUserId || ""),
    cwd: targetCwd,
    configPath: path,
    stateDir,
    presenceFile,
    logFile: resolvePath(process.env.REMOTE_PI_LOG_FILE || file.logFile || join(homedir(), ".local", "var", "log", "remote-pi.log"), configDir),
    sttCommand: file.sttCommand || "",
    ackEmoji: process.env.TELEGRAM_ACK_EMOJI || telegram.ackEmoji || "\u{1F440}",
    downloadRetentionDays: parseNumberConfig(process.env.REMOTE_PI_DOWNLOAD_RETENTION_DAYS, file.downloadRetentionDays, 30, { min: 0 }),
    longReplyChars: parseNumberConfig(process.env.REMOTE_PI_LONG_REPLY_CHARS, file.longReplyChars, 8000, { min: 0 }),
    fallbackModels,
    doneCard: process.env.REMOTE_PI_DONE_CARD !== undefined
      ? process.env.REMOTE_PI_DONE_CARD !== "false" && process.env.REMOTE_PI_DONE_CARD !== "0"
      : file.doneCard !== false,
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
    const baseExtra = {};
    if (extra?.message_thread_id) baseExtra.message_thread_id = extra.message_thread_id;
    if (extra?.disable_notification) baseExtra.disable_notification = extra.disable_notification;
    for (let i = 0; i < parts.length; i++) {
      last = await this.sendOne(chatId, parts[i], i === parts.length - 1 ? extra : baseExtra);
    }
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

  async sendChatAction(chatId, action = "typing", extra = {}) {
    try {
      const body = { chat_id: chatId, action };
      if (extra?.message_thread_id) body.message_thread_id = extra.message_thread_id;
      await fetch(`${this.base}/sendChatAction`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(4_000),
      });
    } catch {
      // Best-effort UI hint
    }
  }

  async sendDocument(chatId, path, extra = {}) {
    const t0 = performance.now();
    const form = new FormData();
    form.set("chat_id", String(chatId));
    if (extra?.message_thread_id) form.set("message_thread_id", String(extra.message_thread_id));
    form.set("document", await openAsBlob(path), basename(path));
    const response = await fetch(`${this.base}/sendDocument`, { method: "POST", body: form, signal: AbortSignal.timeout(60_000) });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(`Telegram sendDocument: ${data.description || response.status}`);
    console.log(`${new Date().toISOString()} [tg:call] sendDocument ok in ${Math.round(performance.now() - t0)}ms`);
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
          offset, timeout: 50, allowed_updates: ["message", "callback_query"],
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
async function resolveHerdrEnvironment(cwd, { excludePaneIds, threadId, persistedPaneId, paneEnv = {}, runCmd = runCommand } = {}) {
  if (HERDR_DISABLED_FOR_TEST && runCmd === runCommand) return {};

  let herdrBin;
  try {
    herdrBin = (await runCmd("which", ["herdr"], { timeout: 2000 })).trim();
  } catch {
    const fallback = join(homedir(), ".local", "bin", "herdr");
    if (existsSync(fallback)) herdrBin = fallback;
    else return {};
  }

  // 1. 检查 Herdr Server 是否运行；若未运行，启动 headless server（有则进，无则建）
  let status = null;
  try {
    const raw = await runCmd(herdrBin, ["status", "server", "--json"], { timeout: 3000 });
    const parsed = JSON.parse(raw);
    if (parsed.running) status = parsed;
  } catch {
    status = null;
  }

  if (!status) {
    if (HERDR_DISABLED_FOR_TEST) throw new Error("Self-test must never start a Herdr server");
    try {
      const serverProc = spawn(herdrBin, ["server"], { detached: true, stdio: "ignore" });
      serverProc.unref();
      const start = Date.now();
      while (Date.now() - start < 3000) {
        await sleep(100);
        try {
          const raw = await runCmd(herdrBin, ["status", "server", "--json"], { timeout: 1000 });
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

  // 2. 查找或创建对应 cwd 的 Workspace 与 Pane（仅复用本会话已持久化的 Pane，严禁按 cwd 匹配用户窗格）
  let workspaceId;
  let tabId;
  let paneId;
  let createdPane = false;
  const exclude = new Set(excludePaneIds || []);
  if (persistedPaneId && !exclude.has(persistedPaneId)) {
    try {
      const paneRaw = await runCmd(herdrBin, ["pane", "get", persistedPaneId], { timeout: 3000 });
      const paneData = JSON.parse(paneRaw);
      const existingPane = paneData.result?.pane;
      if (existingPane && existingPane.pane_id) {
        workspaceId = existingPane.workspace_id;
        tabId = existingPane.tab_id;
        paneId = existingPane.pane_id;
      }
    } catch {}
  }

  if (!paneId) {
    try {
      const base = basename(cwd) || "remote-pi";
      const label = threadId ? `${base}#${threadId}` : base;
      const createdRaw = await runCmd(herdrBin, ["workspace", "create", "--cwd", cwd, "--label", label, "--no-focus", ...Object.entries(paneEnv).flatMap(([key, value]) => ["--env", `${key}=${value}`])], { timeout: 5000 });
      const created = JSON.parse(createdRaw);
      workspaceId = created.result?.workspace?.workspace_id;
      tabId = created.result?.tab?.tab_id;
      paneId = created.result?.root_pane?.pane_id;
      createdPane = Boolean(paneId);
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
    REMOTE_PI_CREATED_PANE: createdPane ? "1" : "0",
  };
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
    if (HERDR_DISABLED_FOR_TEST) return;
    this.sync();
    this.reconcileTimer = setInterval(() => this.sync(), 15_000);
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
    if (HERDR_DISABLED_FOR_TEST) return;
    clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => this.sync(), delay);
    this.syncTimer.unref?.();
  }

  sync() {
    if (HERDR_DISABLED_FOR_TEST) return Promise.resolve();
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
    this.closed = false;
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
    server.unref();
  }

  find({ paneId, sessionFile }) {
    return [...this.connections.values()].find((c) => !c.socket.destroyed && c.socket.writable && (sessionFile ? c.hello.sessionFile === sessionFile : paneId && c.hello.paneId === paneId));
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
    this.session = session;
    this.gateway = session.gateway;
    this.onEvent = onEvent;
    this.onClose = onClose;
    this.proc = null;
    this.connection = null;
    this.pending = new Map();
    this.starting = null;
    this.herdrEnv = {};
    this.stopping = false;
  }

  async ensureStarted() {
    if (this.proc && !this.proc.destroyed) return;
    this.starting ??= this.start().finally(() => { this.starting = null; });
    return this.starting;
  }

  async start() {
    this.stopping = false;
    await this.gateway.ensurePaneSession(this);
  }

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
    if (!replacing) this.onClose?.({ expected: this.stopping || this.gateway.bridge.closed });
  }

  async request(type, fields = {}, timeout = 600_000) {
    await this.ensureStarted();
    const id = `pane-${randomBytes(12).toString("hex")}`;
    return new Promise((done, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Pi bridge ${type} timed out; not retried`)); }, timeout);
      this.pending.set(id, { type, done, reject, timer, from: this.session.binding.sessionFile });
      try { this.write({ id, type, ...fields }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  write(record) {
    if (!writeJsonLine(this.proc, record)) throw new Error("Pi bridge is not connected");
  }

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
    this.pendingUi = null;
    this.runStartedAt = null;
    this.runFirstTokenAt = null;
    this.runFirstUiAt = null;
    this.lastModel = null;
    this.lastPrompt = null;
    this.mediaGroups = new Map();
    this.eventChain = Promise.resolve();
    this.updateChain = Promise.resolve();
    this.currentCtxPercent = null;
    this.runSnapshotPromise = null;
    this.runOrigin = "telegram";
    this.lastTopicName = null;

    this.pi = this.createPi();
  }

  createPi() {
    return new PaneRpc(this, (event) => this.queueEvent(event), (exit) => {
      this.handlePiExit(exit).catch((error) => console.warn(`[bridge] disconnect: ${error.message}`));
    });
  }

  threadExtra(extra = {}) {
    return this.threadId ? { message_thread_id: this.threadId, ...extra } : extra;
  }

  send(text, extra = {}) {
    return this.gateway.telegram.send(this.chatId, text, this.threadExtra(extra));
  }

  sendOne(text, extra = {}) {
    return this.gateway.telegram.sendOne(this.chatId, text, this.threadExtra(extra));
  }

  sendDocument(path, extra = {}) {
    return this.gateway.queueUpload(() => this.gateway.telegram.sendDocument(this.chatId, path, this.threadExtra(extra)));
  }

  action(payload, ttl = 10 * 60_000) {
    return this.gateway.action({ ...payload, sessionKey: this.key }, ttl);
  }

  keyboard(items, ttl) {
    return { reply_markup: { inline_keyboard: items.map(({ label, action }) => [{ text: label.slice(0, 60), callback_data: this.action(action, ttl) }]) } };
  }

  queueEvent(event) {
    this.eventChain = this.eventChain.then(() => this.handleEvent(event)).catch((error) => console.error(`Pi event [${this.key}]:`, error));
  }

  startTyping() {
    if (this.typingTimer) return;
    this.gateway.telegram.sendChatAction(this.chatId, "typing", this.threadExtra());
    this.typingTimer = setInterval(() => {
      this.gateway.telegram.sendChatAction(this.chatId, "typing", this.threadExtra());
    }, 4500);
    this.typingTimer.unref();
  }

  stopTyping() {
    if (this.typingTimer) {
      clearInterval(this.typingTimer);
      this.typingTimer = null;
    }
  }

  async onSessionSwitched(sessionPath = null) {
    const state = await this.pi.request("get_state");
    this.binding = { ...this.binding, sessionFile: sessionPath || state.sessionFile };
    await this.gateway.persistPaneSession(this);
  }

  async handlePiExit({ expected }) {
    if (expected) return;
    this.stopTyping();
    this.isStreaming = false;
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
    this.runSnapshotPromise = null;
    if (this.draft) {
      if (this.draft.timer) clearTimeout(this.draft.timer);
      this.draft.closed = true;
      if (this.draft.messageId) this.gateway.telegram.deleteMessage(this.chatId, this.draft.messageId).catch(() => {});
    }
    this.draft = null;
    this.queue = { steering: [], followUp: [] };
  }

  async prompt(message, images, streamingBehavior) {
    this.runOrigin = "telegram";
    const t0 = performance.now();
    this.startTyping();
    if (!streamingBehavior && !this.isStreaming) {
      this.lastPrompt = { message, images };
    }
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
        } else {
          throw error;
        }
      }
      console.log(`${new Date().toISOString()} [prompt${this.threadId ? `:${this.threadId}` : ""}] accepted by Pi in ${Math.round(performance.now() - t0)}ms`);
      if (fields.streamingBehavior === "followUp") await this.send("↪ Queued as follow-up", { disable_notification: true });
    } catch (error) {
      this.stopTyping();
      throw error;
    }
  }

  async handleCommand({ name, argument }, original, updateId = null) {
    const t0 = performance.now();
    try {
      switch (name) {
      case "start": return this.send(HELP);
      case "help": case "commands":
        await this.send(HELP);
        return this.showCommands();
      case "cwd": return argument ? this.switchCwd(resolvePath(argument.trim(), this.cwd), null) : this.showCwds();
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
          : this.lastModel;
        this.resetSessionState();
        const result = await this.pi.request("new_session");
        if (result.cancelled) {
          return this.send("New session cancelled");
        }
        if (targetModel) {
          await this.pi.request("set_model", targetModel).catch((err) => {
            console.error("Failed to restore last model after new_session:", err.message);
          });
          this.lastModel = targetModel;
        }
        const state = await this.pi.request("get_state").catch(() => null);
        await this.onSessionSwitched();
        const text = formatSessionReset({ model: state?.model, cwd: this.cwd });
        return this.send(text);
      }
      case "name": {
        if (!argument) return this.send("Usage: /name <name>");
        await this.pi.request("set_session_name", { name: argument });
        return this.send(`✅ Session name: ${argument}`);
      }
      case "status": return this.showSession();
      case "agents": return this.gateway.showHerdrAgents();
      case "fork": return this.showForks();
      case "compact": {
        this.startTyping();
        try {
          const result = await this.pi.request("compact", argument ? { customInstructions: argument } : {});
          return this.send(`✅ Compacted: ${result.tokensBefore} → ~${result.estimatedTokensAfter} tokens`);
        } catch (error) {
          if (!/abort/i.test(error.message)) {
            return this.send(`❌ ${error.message}`);
          }
        } finally {
          this.stopTyping();
        }
        return;
      }
      case "export": {
        const result = await this.pi.request("export_html");
        await this.sendDocument(result.path);
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
          if (output.split("\n").length > 3) {
            return this.send(expandableBlockquote(output));
          }
          return this.send(output);
        } catch (error) {
          if (!/abort/i.test(error.message)) {
            return this.send(`❌ ${error.message}`);
          }
        } finally {
          this.stopTyping();
        }
        return;
      }
      case "get": {
        if (!argument) return this.send("Usage: /get <path>");
        const filePath = resolve(this.cwd, argument);
        try {
          const s = await stat(filePath);
          if (!s.isFile()) return this.send("❌ Not a regular file");
          if (s.size > 20 * 1024 * 1024) return this.send("❌ File exceeds the 20MB limit");
          await this.sendDocument(filePath);
        } catch (error) {
          return this.send(`❌ File missing or inaccessible: ${error.message}`);
        }
        return;
      }
      case "followup": {
        if (!argument) return this.send("Usage: /followup <message>");
        return this.prompt(argument, undefined, "followUp");
      }
      case "git_commit_push":
      case "git-commit-push": {
        return this.prompt(`/git-commit-push${argument ? ` ${argument}` : ""}`);
      }
      case "abort": {
        this.abortedRun = true;
        if (this.pendingUi && this.pi.proc) {
          this.pi.write({ type: "extension_ui_response", id: this.pendingUi.id, cancelled: true });
        }
        if (this.pi.proc) {
          await this.pi.request("abort").catch(() => {});
        }
        const kept = this.queue;
        this.resetSessionState();
        this.queue = kept;
        return this.send("⏹ Stopped (queued messages kept; use /queue clear to clear)");
      }
      case "upgrade": {
        this.startTyping();
        const script = join(dirname(fileURLToPath(import.meta.url)), "install.sh");
        const res = await new Promise((done) => {
          const child = spawn("bash", [script, "upgrade", "--no-restart"], { timeout: 300_000 });
          let buf = "";
          child.stdout.setEncoding("utf8");
          child.stderr.setEncoding("utf8");
          child.stdout.on("data", (c) => { buf += c; });
          child.stderr.on("data", (c) => { buf += c; });
          child.on("close", (code) => done({ code, buf }));
          child.on("error", (err) => done({ code: 1, buf: String(err) }));
        });
        this.stopTyping();
        const text = res.buf.trim() || "(no output)";
        if (res.code !== 0) return this.send(`❌ Upgrade failed\n${text}`);
        if (text.includes("Already up to date")) return this.send(text);
        await this.send(text);
        return this.handleCommand({ name: "restart", argument: "" }, "/restart", updateId);
      }
      case "restart": {
        const message = await this.send("🔄 Restarting gateway…");
        await this.gateway.saveState({ pendingRestartMessageId: message.message_id });
        if (updateId) {
          const receiptPath = join(this.gateway.config.stateDir, "last-restart-update");
          await writeFile(receiptPath, String(updateId), { mode: 0o600 }).catch(() => {});
          const tmp = `${this.gateway.telegram.offsetPath}.tmp`;
          await writeFile(tmp, String(updateId + 1), { mode: 0o600 }).catch(() => {});
          await rename(tmp, this.gateway.telegram.offsetPath).catch(() => {});
        }
        this.gateway.stop();
        setTimeout(() => process.exit(0), 100);
        return;
      }
      case "queue": {
        if (argument === "clear") {
          const removed = this.pi.proc ? await this.pi.request("clear_queue").catch(() => ({ steering: [], followUp: [] })) : { steering: [], followUp: [] };
          this.queue = { steering: [], followUp: [] };
          return this.send(`Cleared\nsteering: ${removed.steering.length}\nfollow-up: ${removed.followUp.length}`);
        }
        return this.send(`steering:\n${this.queue.steering.join("\n") || "(empty)"}\n\nfollow-up:\n${this.queue.followUp.join("\n") || "(empty)"}`);
      }
      default: {
        const data = await this.pi.request("get_commands");
        const targets = commandRoutes(data.commands).get(name);
        if (targets?.size > 1) return this.send(`Ambiguous command: /${name}\nMatches: ${[...targets].map((target) => `/${target}`).join(", ")}\nUse an unambiguous native name from /help, or run it in the Pi terminal.`);
        if (targets?.size === 1) return this.prompt(`/${[...targets][0]}${argument ? ` ${argument}` : ""}`);
        return this.send(`Unknown command: /${name}\nUse /help`);
      }
      }
    } finally {
      console.log(`${new Date().toISOString()} [cmd${this.threadId ? `:${this.threadId}` : ""}] /${name} finished in ${Math.round(performance.now() - t0)}ms`);
    }
  }

  async handleMediaGroup(messages) {
    const mediaList = await Promise.all(messages.map((m) => this.gateway.extractMedia(m)));
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
    if (files.length) {
      await this.prompt(attachmentPrompt(caption || "Please review these files.", files), images.length ? images : undefined);
    } else if (caption) {
      await this.prompt(caption);
    }
  }

  async showCommands() {
    if (!this.pi.proc) return;
    const data = await this.pi.request("get_commands");
    if (!data.commands.length) return;
    const routes = commandRoutes(data.commands);
    const text = data.commands.map((item) => {
      const name = telegramCommandName(item);
      const isForwarded = name === "git_commit_push" || item.name === "git-commit-push";
      const issue = (RESERVED_COMMANDS.has(name) && !isForwarded) ? `Telegram /${name} is gateway-reserved; use Pi terminal`
        : routes.get(name)?.size > 1 ? `Telegram /${name} is ambiguous; use an unambiguous native name or Pi terminal` : "";
      return `/${item.name}${item.description ? ` — ${item.description}` : ""}${issue ? ` [${issue}]` : ""}`;
    }).join("\n");
    await this.send(text);
  }

  async retryLastPrompt() {
    const { message, images } = this.lastPrompt;
    this.runStartedAt = performance.now();
    this.runFirstTokenAt = null;
    this.runFirstUiAt = null;
    await this.send(`🔁 Retrying last prompt (${message.length} chars)…`);
    await this.prompt(message, images);
  }

  async restartPi(notice = "♻️ Restarting Pi…") {
    if (!this.binding.owned) return this.send("Restart this Pi in its desktop pane; this view will not stop it.");
    await this.send(notice);
    const socket = this.pi.proc;
    await this.pi.request("quit", {}, 10_000);
    if (socket && !socket.destroyed) await new Promise((done, reject) => {
      const timer = setTimeout(() => reject(new Error("Pi has not exited")), 10_000);
      socket.once("close", () => { clearTimeout(timer); done(); });
    });
    this.pi.stop();
    this.resetSessionState();
    await this.pi.start();
    const state = await this.pi.request("get_state");
    await this.send(`✅ Pi restarted; Session: ${state.sessionId}`);
  }

  async sendGatewayLog() {
    let text = "(log file empty or missing)";
    try {
      const raw = await readFile(this.gateway.config.logFile, "utf8");
      const tail = raw.split("\n").slice(-40).join("\n");
      text = redactLog(tail, this.gateway.config.botToken);
    } catch (error) {
      text = `(failed to read log: ${error.message})`;
    }
    await this.send(`📜 Last 40 log lines:\n${expandableBlockquote(text)}`);
  }

  async showCwds() {
    const items = new Map();
    if (Array.isArray(this.gateway.state.recentProjects)) {
      for (const p of this.gateway.state.recentProjects) {
        if (!items.has(p) && existsSync(p)) {
          items.set(p, basename(p));
        }
      }
    }
    if (!items.has(this.cwd)) {
      items.set(this.cwd, basename(this.cwd));
    }
    if (items.size <= 1) {
      await this.send(
        `Current directory: ${this.cwd}\n\nNo recent projects yet. Use /cwd <absolute-path> to switch to another project.`,
      );
      return;
    }
    const keyboardItems = Array.from(items.entries()).map(([path, name]) => ({
      label: `${path === this.cwd ? "●" : "○"} ${name}`,
      action: { type: "cwd", path },
    }));
    await this.send(`Current directory: ${this.cwd}\n\nPick a workspace project:`, this.keyboard(keyboardItems));
  }

  async switchCwd(path, callbackId) {
    // callback 场景已在 handleCallback 提前 answer，不再二次 answer；文本一律走聊天消息
    const reply = (text) => this.send(text);
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
    if (target === this.cwd) {
      await reply("Already in this directory");
      return;
    }

    const recentProjects = [target, ...(this.gateway.state.recentProjects || []).filter((p) => p !== target)].slice(0, 20);
    await this.gateway.closePaneSession(this);
    this.cwd = target;
    this.binding = { cwd: target };
    this.pi = this.createPi();
    this.resetSessionState();
    await this.gateway.persistPaneSession(this);
    if (this.threadId === null) {
      this.gateway.config.cwd = target;
      await this.gateway.saveState({ cwd: target, recentProjects });
    } else {
      await this.gateway.saveState({ recentProjects });
      const newTopicName = (basename(target) || "topic").slice(0, 128);
      this.lastTopicName = newTopicName;
      await this.gateway.telegram.call("editForumTopic", { chat_id: this.chatId, message_thread_id: this.threadId, name: newTopicName }).catch(() => {});
    }
    await this.pi.start();
    const state = await this.pi.request("get_state");
    if (state.model) this.lastModel = { provider: state.model.provider, modelId: state.model.id };
    if (this.threadId === null) await this.gateway.registerBotCommands();
    await this.send(`✅ Working directory switched to:\n${target}\nSession: ${state.sessionId}`);
  }

  async showModels(query) {
    const data = await this.pi.request("get_available_models");
    const models = data.models;
    if (query) {
      const exact = models.find((model) => `${model.provider}/${model.id}` === query || model.id === query);
      if (exact) {
        await this.pi.request("set_model", { provider: exact.provider, modelId: exact.id });
        this.lastModel = { provider: exact.provider, modelId: exact.id };
        return this.send(`✅ ${exact.provider}/${exact.id}`);
      }
    }
    const filtered = models.filter((model) => !query || `${model.provider}/${model.id} ${model.name}`.toLowerCase().includes(query.toLowerCase()));
    if (!filtered.length) return this.send(`No matching model: ${query}`);
    const display = filtered.slice(0, 18);
    const suffix = filtered.length > 18 ? `\n\n(${filtered.length} models; showing first 18 — use /model <query> to filter)` : "";
    return this.send(`Pick a model:${suffix}`, this.keyboard(display.map((model) => ({
      label: `${model.provider}/${model.id}`,
      action: { type: "model", provider: model.provider, modelId: model.id },
    }))));
  }

  async showThinking(argument) {
    const data = await this.pi.request("get_available_thinking_levels");
    if (argument) {
      if (!data.levels.includes(argument)) return this.send(`Available levels: ${data.levels.join(", ")}`);
      await this.pi.request("set_thinking_level", { level: argument });
      return this.send(`✅ thinking: ${argument}`);
    }
    return this.send("Pick a thinking level:", this.keyboard(data.levels.map((level) => ({
      label: level, action: { type: "thinking", level },
    }))));
  }

  async sessionFiles() {
    // ref: Pi config.getSessionsDir / ENV_SESSION_DIR — use the native location, never a gateway-specific directory.
    const root = process.env.PI_CODING_AGENT_SESSION_DIR || join(resolvePath(process.env.PI_CODING_AGENT_DIR || "~/.pi/agent", this.cwd), "sessions");
    return scanDesktopSessions(resolvePath(root, this.cwd), this.cwd, 15);
  }

  async showSessions() {
    const sessions = (await this.sessionFiles()).slice(0, 12);
    if (!sessions.length) return this.send("No past sessions for this directory yet.");
    return this.send("Pick a session:", this.keyboard(sessions.map((session) => ({
      label: session.title, action: { type: "resume", path: session.path },
    }))));
  }

  topicSummaryLines() {
    if (this.threadId !== null) return [];
    const topicSessions = [...this.gateway.sessions.values()].filter((s) => s.threadId !== null);
    if (!topicSessions.length) return ["", "Topics: (none)"];
    const lines = ["", "Topics:"];
    for (const ts of topicSessions) {
      const status = ts.isStreaming ? "running" : ts.pi?.proc ? "idle" : "stopped";
      const name = basename(ts.cwd) || `topic-${ts.threadId}`;
      lines.push(`• ${name} (${status}) — ${ts.cwd}`);
    }
    return lines;
  }

  async showSession() {
    const [state, stats] = await Promise.all([this.pi.request("get_state"), this.pi.request("get_session_stats")]);
    const model = state.model ? `${state.model.provider}/${state.model.id}` : "none";
    const context = stats.contextUsage ? `${stats.contextUsage.tokens ?? "?"}/${stats.contextUsage.contextWindow} (${stats.contextUsage.percent ?? "?"}%)` : "n/a";
    const lines = [
      `Name: ${state.sessionName || "(unnamed)"}`, `Model: ${model}`, `Thinking: ${state.thinkingLevel}`,
      `State: ${state.isStreaming ? "working" : "idle"}`, `Messages: ${stats.totalMessages}`, `Context: ${context}`,
      `Cost: $${Number(stats.cost || 0).toFixed(4)}`, `Session: ${state.sessionId}`, `File: ${state.sessionFile || "not persisted"}`,
      ...this.topicSummaryLines(),
    ];
    await this.send(lines.join("\n"));
  }

  async showForks() {
    const data = await this.pi.request("get_fork_messages");
    const messages = data.messages.slice(-12).reverse();
    if (!messages.length) return this.send("No user messages to fork from.");
    return this.send("Fork from which message?", this.keyboard(messages.map((message) => ({
      label: message.text.replaceAll("\n", " ").slice(0, 60),
      action: { type: "fork", entryId: message.entryId },
    }))));
  }

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
    } else if (action.type === "retry" || action.type === "retry_fallback") {
      if (!this.lastPrompt) return this.send("No prompt to retry");
      if (this.isStreaming) return this.send("⚠️ Still streaming; /abort first");
      if (action.type === "retry_fallback") {
        const [provider, ...rest] = String(action.model).split("/");
        const modelId = rest.join("/");
        await this.pi.request("set_model", { provider, modelId });
        this.lastModel = { provider, modelId };
        await this.send(`✅ Switched to ${provider}/${modelId}`);
      }
      await this.retryLastPrompt();
    } else if (action.type === "models") {
      await this.showModels("");
    } else if (action.type === "restart_pi") {
      await this.restartPi("♻️ Restarting Pi…");
    } else if (action.type === "show_log") {
      await this.sendGatewayLog();
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
        if (state?.model?.provider && state?.model?.id) {
          this.lastModel = { provider: state.model.provider, modelId: state.model.id };
        }
        await this.onSessionSwitched(action.path);
      }
      await this.send(result.cancelled ? "Resume cancelled" : "✅ Session resumed");
    } else if (action.type === "fork") {
      if (this.isStreaming) await this.pi.request("abort").catch(() => {});
      this.resetSessionState();
      const result = await this.pi.request("fork", { entryId: action.entryId });
      if (!result.cancelled) await this.onSessionSwitched();
      await this.send(result.cancelled ? "Fork cancelled" : `✅ Forked from "${result.text.slice(0, 80)}"`);
    } else if (action.type === "cwd") {
      await this.switchCwd(action.path, callback.id);
    } else if (action.type === "run_diff") {
      const gitDir = action.toplevel || this.cwd;
      let diff = "";
      if (action.snap) {
        try {
          diff = await runCommand("git", ["diff", action.snap], { cwd: gitDir, timeout: 10_000 });
        } catch (err) {
          console.warn(`[run_diff] git diff ${action.snap} failed: ${err.message}`);
        }
      }
      for (const file of (action.untrackedFiles || [])) {
        try {
          const out = await runCommand("git", ["diff", "--no-index", "--", "/dev/null", file], { cwd: gitDir, timeout: 5000, okCodes: [0, 1] });
          if (out) diff = diff ? `${diff}\n${out}` : out;
        } catch {}
      }
      diff = diff.trim();
      if (!diff) {
        await this.send("No changes detected in working tree.");
        return;
      }
      if (diff.length < 3500) {
        await this.send(`\`\`\`diff\n${diff}\n\`\`\``);
      } else {
        const downloadsDir = this.gateway.config.downloadsDir;
        await mkdir(downloadsDir, { recursive: true, mode: 0o700 });
        const diffPath = join(downloadsDir, `run-${Date.now()}.diff`);
        await writeFile(diffPath, diff, "utf8");
        await this.sendDocument(diffPath);
      }
    } else if (action.type === "run_commit") {
      await this.prompt("Review the current uncommitted changes (git status / git diff) and commit them with a concise conventional commit message. Do not push.");
    } else if (action.type === "run_undo") {
      if (this.isStreaming) {
        await this.send("Cannot undo while running.");
        return;
      }
      if (action.confirmed === undefined) {
        const keyboard = {
          reply_markup: {
            inline_keyboard: [
              [
                { text: "Confirm", callback_data: this.action({ type: "run_undo", toplevel: action.toplevel, snap: action.snap, trackedFiles: action.trackedFiles, untrackedFiles: action.untrackedFiles, confirmed: true }, 600_000) },
                { text: "Cancel", callback_data: this.action({ type: "run_undo", confirmed: false }, 600_000) },
              ],
            ],
          },
        };
        await this.send("↩️ Undo changes from this run?", keyboard);
        return;
      }
      if (action.confirmed === false) {
        if (callback.message) {
          await this.gateway.telegram.edit(callback.message.chat.id, callback.message.message_id, "Undo cancelled.").catch(() => {});
        }
        return;
      }
      if (action.confirmed === true) {
        if (callback.message) {
          await this.gateway.telegram.edit(callback.message.chat.id, callback.message.message_id, "Undoing run changes…").catch(() => {});
        }
        const gitDir = action.toplevel || this.cwd;
        const restoredTracked = [];
        if (action.snap && action.trackedFiles?.length) {
          try {
            await runCommand("git", ["restore", `--source=${action.snap}`, "--worktree", "--", ...action.trackedFiles], { cwd: gitDir, timeout: 10_000 });
            restoredTracked.push(...action.trackedFiles);
          } catch (err) {
            console.warn(`[run_undo] git restore failed: ${err.message}`);
          }
        }
        const deletedUntracked = [];
        for (const file of (action.untrackedFiles || [])) {
          try {
            const filePath = resolve(gitDir, file);
            await unlink(filePath);
            deletedUntracked.push(file);
          } catch (err) {
            console.warn(`[run_undo] failed to delete untracked file ${file}: ${err.message}`);
          }
        }
        const restored = [...restoredTracked, ...deletedUntracked];
        if (restored.length > 0) {
          await this.send(`↩️ Restored ${restored.length} file(s):\n${restored.map((f) => `• ${f}`).join("\n")}`);
        } else {
          await this.send("↩️ No files were restored.");
        }
        return;
      }
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
      if (this.pendingUi?.id === event.id) this.pendingUi = null;
      const messageId = this.uiMessages?.get(event.id);
      this.uiMessages?.delete(event.id);
      if (messageId) await this.gateway.telegram.call("editMessageReplyMarkup", { chat_id: this.chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } }).catch(() => {});
      return;
    }
    if (event.type === "agent_start") {
      const isInitialStart = !this.isStreaming;
      this.isStreaming = true;
      this.pendingUi = null;
      this.repliedInRun = false;
      this.abortedRun = false;
      this.startTyping();
      if (this.toolPanel?.timer) clearTimeout(this.toolPanel.timer);
      this.toolPanel = null;
      if (isInitialStart) {
        this.runStartedAt = this.runStartedAt || performance.now();
        this.runSnapshotPromise = this.takeRunSnapshot();
      }
      const since = this.runStartedAt ? ` (+${Math.round(performance.now() - this.runStartedAt)}ms)` : "";
      console.log(`${new Date().toISOString()} [run${this.threadId ? `:${this.threadId}` : ""}] agent_start${since}`);
    }
    if (event.type === "agent_settled") {
      this.isStreaming = false;
      this.pendingUi = null;
      this.stopTyping();
      const durationMs = this.runStartedAt ? Math.round(performance.now() - this.runStartedAt) : null;
      const since = durationMs != null ? ` (total: ${durationMs}ms)` : "";
      console.log(`${new Date().toISOString()} [run${this.threadId ? `:${this.threadId}` : ""}] agent_settled${since}`);
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
      const runOrigin = this.runOrigin || "telegram";
      if (!this.repliedInRun && !this.abortedRun) {
        const silent = runOrigin === "terminal" || this.gateway.isUserPresent();
        const extra = {
          ...errorActions(this, "no text reply"),
          ...(silent ? { disable_notification: true } : {}),
        };
        this.gateway.queueTelegram(() => this.send("⚠️ The model returned no text reply. Use /model to switch models or retry.", extra));
      }
      if (!this.abortedRun && this.gateway.config.doneCard !== false) {
        const snapPromise = this.runSnapshotPromise;
        this.sendRunCard(snapPromise, durationMs, runOrigin).catch((err) => {
          console.error(`[run-card] failed to send run card:`, err.message);
        });
      }
      this.abortedRun = false;
      this.runStartedAt = null;
      this.runFirstTokenAt = null;
      this.runFirstUiAt = null;
      this.runSnapshotPromise = null;
      this.runOrigin = "telegram";
    }
    if (event.type === "queue_update") {
      this.queue = { steering: event.steering, followUp: event.followUp };
    }
    if (!this.gateway.chatReady) return;

    if (event.type === "auto_retry_start") {
      const extra = this.gateway.isUserPresent() ? { disable_notification: true } : {};
      await this.send(`⏳ Model error; auto-retrying (${event.attempt}/${event.maxAttempts})…`, extra);
    }
    if (event.type === "compaction_end" && event.errorMessage) {
      const extra = this.gateway.isUserPresent() ? { disable_notification: true } : {};
      await this.send(`⚠️ Context compaction failed: ${event.errorMessage}`, extra);
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
          console.log(`${new Date().toISOString()} [run${this.threadId ? `:${this.threadId}` : ""}] first token received${ttft}`);
        }
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
        this.gateway.queueTelegram(() => this.send("🛠 Recovery actions:", errorActions(this, `${event.message.errorMessage || ""} ${errText}`, { endedRun: true })));
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
      // ref: https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html — do not log tool arguments/paths to disk
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
        // 扩展返回的 details.paths 已解析为绝对路径；旧版扩展回退 args.paths 时按会话 cwd 解析
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
    if (event.type === "extension_error") await this.send(`❌ Extension ${event.extensionPath}: ${event.error}`, errorActions(this, event.error));
  }

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
    const t0 = performance.now();
    try {
      if (this.toolPanel.messageId) {
        await this.gateway.telegram.edit(this.chatId, this.toolPanel.messageId, text);
      } else {
        const sent = await this.sendOne(text, { disable_notification: true });
        if (this.toolPanel) this.toolPanel.messageId = sent.message_id;
        if (!this.runFirstUiAt && this.runStartedAt) {
          this.runFirstUiAt = performance.now();
          console.log(`${new Date().toISOString()} [ui${this.threadId ? `:${this.threadId}` : ""}] first tool panel visible (TTFE: ${Math.round(this.runFirstUiAt - this.runStartedAt)}ms, send took ${Math.round(performance.now() - t0)}ms)`);
        }
      }
    } finally {
      if (this.toolPanel) this.toolPanel.sending = false;
    }
  }

  async flushDraft(draft) {
    if (!draft.text || draft.flushing || draft.closed) return;
    if (this.gateway.telegram.retryNotBefore > Date.now()) return;
    draft.flushing = true;
    const t0 = performance.now();
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
      this.logFirstUi(t0, "edit");
    } catch (error) {
      console.error(`${new Date().toISOString()} [ui${this.threadId ? `:${this.threadId}` : ""}] preview update failed:`, error.message);
    } finally {
      draft.flushing = false;
    }
  }

  logFirstUi(t0, mode) {
    if (!this.runFirstUiAt && this.runStartedAt) {
      this.runFirstUiAt = performance.now();
      const ttfe = Math.round(this.runFirstUiAt - this.runStartedAt);
      const api = Math.round(performance.now() - t0);
      console.log(`${new Date().toISOString()} [ui${this.threadId ? `:${this.threadId}` : ""}] first preview visible (TTFE: ${ttfe}ms, api took ${api}ms, mode: ${mode})`);
    }
  }

  async finishDraft(draft) {
    if (!draft.text) return;
    draft.closed = true;
    const t0 = performance.now();
    const limit = this.gateway.config.longReplyChars ?? 8000;
    // 超长回复不再刷屏：首段留在原地，全文渲染为独立 HTML 文档发送（0 关闭）
    if (limit > 0 && draft.text.length > limit) {
      try {
        const name = `reply-${formatStamp()}.html`;
        const path = join(this.gateway.config.downloadsDir, name);
        await writeFile(path, renderReplyHtml(draft.text));
        const note = `\n\n… (full reply attached, ${draft.text.length} chars)`;
        const first = chunks(draft.text)[0];
        const head = (first.length + note.length > MAX_MESSAGE ? first.slice(0, MAX_MESSAGE - note.length) : first) + note;
        if (draft.messageId) {
          await this.gateway.telegram.edit(this.chatId, draft.messageId, head, false);
        } else {
          await this.sendOne(head);
        }
        await this.gateway.telegram.sendDocument(this.chatId, path, this.threadExtra());
        const apiMs = Math.round(performance.now() - t0);
        console.log(`${new Date().toISOString()} [ui${this.threadId ? `:${this.threadId}` : ""}] long reply sent as ${name} (${draft.text.length} chars, took ${apiMs}ms)`);
        return;
      } catch (error) {
        console.error(`${new Date().toISOString()} [ui${this.threadId ? `:${this.threadId}` : ""}] long reply document failed (${error.message}); falling back to chunks`);
      }
    }
    try {
      const parts = chunks(draft.text);
      if (draft.messageId) {
        await this.gateway.telegram.edit(this.chatId, draft.messageId, parts[0], false);
        for (let i = 1; i < parts.length; i++) {
          await this.sendOne(parts[i]);
        }
      } else {
        for (const part of parts) {
          await this.sendOne(part);
        }
      }
      const apiMs = Math.round(performance.now() - t0);
      const turnMs = this.runStartedAt ? ` (total turn: ${Math.round(performance.now() - this.runStartedAt)}ms)` : "";
      console.log(`${new Date().toISOString()} [ui${this.threadId ? `:${this.threadId}` : ""}] final reply sent (${parts.length} parts, took ${apiMs}ms)${turnMs}`);
    } catch (error) {
      console.error(`${new Date().toISOString()} [ui${this.threadId ? `:${this.threadId}` : ""}] final reply delivery failed:`, error.message);
      const copy = join(this.gateway.config.stateDir, `failed-reply-${Date.now()}.txt`);
      await writeFile(copy, draft.text).catch(() => {});
      await this.send(`❌ Reply delivery failed: ${error.message}\nContent saved to: ${copy}`).catch(() => {});
    }
  }

  async handleUiRequest(request) {
    if (["select", "confirm"].includes(request.method)) {
      const options = request.method === "confirm" ? [
        { label: "Confirm", response: { confirmed: true } }, { label: "Cancel", response: { confirmed: false } },
      ] : request.options.map((value) => ({ label: value, response: { value } }));
      const sent = await this.send([request.title, request.message].filter(Boolean).join("\n"), this.keyboard(options.map((option) => ({
        label: option.label, action: { type: "ui", requestId: request.id, response: option.response },
      }))));
      this.uiMessages ||= new Map();
      if (sent?.message_id) this.uiMessages.set(request.id, sent.message_id);
    } else if (["input", "editor"].includes(request.method)) {
      this.pendingUi = request;
      await this.send([request.title, request.placeholder || request.prefill].filter(Boolean).join("\n"));
    } else if (request.method === "notify") {
      await this.send(request.message);
    }
  }

  async takeRunSnapshot() {
    try {
      const [statsRes, stateRes, gitRes] = await Promise.allSettled([
        this.pi.request("get_session_stats", {}, 5000).catch(() => null),
        this.pi.request("get_state", {}, 5000).catch(() => null),
        (async () => {
          try {
            const isTree = (await runCommand("git", ["rev-parse", "--is-inside-work-tree"], { cwd: this.cwd, timeout: 5000 })).trim();
            if (isTree !== "true") return null;

            const toplevel = (await runCommand("git", ["rev-parse", "--show-toplevel"], { cwd: this.cwd, timeout: 5000 })).trim();
            if (!toplevel) return null;

            let snap = (await runCommand("git", ["stash", "create"], { cwd: toplevel, timeout: 5000 })).trim();
            if (!snap) {
              snap = (await runCommand("git", ["rev-parse", "HEAD"], { cwd: toplevel, timeout: 5000 })).trim();
            }
            if (!snap) return null;

            const untrackedRaw = await runCommand("git", ["ls-files", "-z", "--others", "--exclude-standard"], { cwd: toplevel, timeout: 5000 }).catch(() => "");
            const untracked = new Set(untrackedRaw.split("\0").filter(Boolean));
            return { snap, toplevel, untracked };
          } catch {
            return null;
          }
        })(),
      ]);

      const stats = statsRes.status === "fulfilled" ? statsRes.value : null;
      const state = stateRes.status === "fulfilled" ? stateRes.value : null;
      const git = gitRes.status === "fulfilled" ? gitRes.value : null;

      if (state?.model?.provider && state?.model?.id) {
        this.lastModel = { provider: state.model.provider, modelId: state.model.id };
      }
      if (stats?.contextUsage?.percent != null) {
        this.currentCtxPercent = stats.contextUsage.percent;
      }

      return { stats, git, startedAt: Date.now() };
    } catch {
      return null;
    }
  }

  async sendRunCard(snapshotPromise, durationMs, origin = this.runOrigin) {
    try {
      const snapshot = snapshotPromise ? await snapshotPromise.catch(() => null) : null;
      const statsAfter = await this.pi.request("get_session_stats", {}, 5000).catch(() => null);

      const costBefore = snapshot?.stats?.cost;
      const costAfter = statsAfter?.cost;
      const costDelta = (typeof costAfter === "number" && typeof costBefore === "number")
        ? Math.max(0, costAfter - costBefore)
        : (typeof costAfter === "number" ? costAfter : null);

      const tokensBefore = snapshot?.stats?.tokens?.total;
      const tokensAfter = statsAfter?.tokens?.total;
      const tokensDelta = (typeof tokensAfter === "number" && typeof tokensBefore === "number")
        ? Math.max(0, tokensAfter - tokensBefore)
        : null;

      const ctxPercent = statsAfter?.contextUsage?.percent ?? this.currentCtxPercent;
      if (typeof ctxPercent === "number") this.currentCtxPercent = ctxPercent;

      let files = null;
      let trackedFilesChanged = [];
      let newUntrackedFiles = [];
      const snap = snapshot?.git?.snap;
      const toplevel = snapshot?.git?.toplevel;

      if (snap && toplevel) {
        try {
          // ref: git diff -z 输出 NUL 分隔的 verbatim 路径，中文路径不再被 core.quotePath 八进制转义
          const numstatRaw = await runCommand("git", ["diff", "-z", "--numstat", snap], { cwd: toplevel, timeout: 5000 }).catch(() => "");
          const parsedTracked = parseNumstat(numstatRaw);
          trackedFilesChanged = parsedTracked.map((f) => f.path);

          const untrackedRaw = await runCommand("git", ["ls-files", "-z", "--others", "--exclude-standard"], { cwd: toplevel, timeout: 5000 }).catch(() => "");
          const currentUntracked = untrackedRaw.split("\0").filter(Boolean);
          const startUntracked = snapshot.git.untracked || new Set();
          newUntrackedFiles = currentUntracked.filter((f) => !startUntracked.has(f));

          files = [
            ...parsedTracked,
            ...newUntrackedFiles.map((path) => ({ path, added: 0, deleted: 0, untracked: true })),
          ];
        } catch (err) {
          console.warn(`[run-card] git diff failed: ${err.message}`);
        }
      }

      const text = formatRunCard({ durationMs, costDelta, tokensDelta, ctxPercent, files });

      const silent = origin === "terminal" || this.gateway.isUserPresent();
      let extra = silent ? { disable_notification: true } : {};
      if (files && files.length > 0) {
        const ttl24h = 24 * 60 * 60 * 1000;
        extra = {
          ...extra,
          reply_markup: {
            inline_keyboard: [
              [
                { text: "📄 Diff", callback_data: this.action({ type: "run_diff", toplevel, snap, untrackedFiles: newUntrackedFiles }, ttl24h) },
                { text: "✅ Commit", callback_data: this.action({ type: "run_commit" }, ttl24h) },
                { text: "↩️ Undo run", callback_data: this.action({ type: "run_undo", toplevel, snap, trackedFiles: trackedFilesChanged, untrackedFiles: newUntrackedFiles }, ttl24h) },
              ],
            ],
          },
        };
      }

      await this.send(text, extra);
    } catch (error) {
      console.error(`[run-card] failed to send run card:`, error.message);
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
    if (config.cwd && !this.state.recentProjects.includes(config.cwd)) {
      this.state.recentProjects.unshift(config.cwd);
    }
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
    await this.saveState({ herdrPanes: this.state.herdrPanes, topics: this.state.topics });
  }

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
    return (data.result?.agents || data.agents || []).find((a) => a.agent === "pi" && resolveAgentSessionFile(a) === sessionFile)?.pane_id || null;
  }

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
    return true;
  }

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
    session.stop();
  }

  getSession(key) {
    return this.sessions.get(key);
  }

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
    return session;
  }

  getOwnedPaneIds(excludingSession = null) {
    const panes = new Set();
    for (const [key, session] of this.sessions.entries()) {
      if (session !== excludingSession && (!excludingSession?.binding.paneId || session.binding.paneId !== excludingSession.binding.paneId)) {
        if (session.pi?.herdrEnv?.HERDR_PANE_ID) panes.add(session.pi.herdrEnv.HERDR_PANE_ID);
        if (this.state.herdrPanes?.[key]) panes.add(this.state.herdrPanes[key].paneId || this.state.herdrPanes[key]);
      }
    }
    return [...panes];
  }

  async start() {
    const t0 = performance.now();
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
    console.log(`${new Date().toISOString()} @${me.username} ready in ${Math.round(performance.now() - t0)}ms; Pi ${sessionInfo}`);
    await this.completeRestart();
    await this.telegram.poll((update) => this.dispatchUpdate(update));
  }

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

  // 下载目录与 failed-reply 副本按 mtime 定期清理；0 天即关闭
  async cleanupDownloads() {
    const days = this.config.downloadRetentionDays;
    if (!days || days <= 0) return;
    const cutoff = Date.now() - days * 24 * 60 * 60_000;
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
      const stateEntries = await readdir(this.config.stateDir, { withFileTypes: true }).catch(() => []);
      for (const entry of stateEntries) {
        if (!entry.isFile() || !entry.name.startsWith("failed-reply-")) continue;
        const path = join(this.config.stateDir, entry.name);
        try {
          const s = await stat(path);
          if (s.mtimeMs < cutoff) {
            await unlink(path).catch(() => {});
            removed++;
          }
        } catch {}
      }
      if (removed > 0) console.log(`${new Date().toISOString()} [cleanup] removed ${removed} expired download(s)/failed-reply file(s)`);
    } catch (err) {
      console.warn(`[cleanup] download retention failed: ${err.message}`);
    }
  }

  isAllowed(from, chat) {
    return String(from?.id) === this.config.allowedUserId && (!chat || chat.type === "private");
  }

  dispatchUpdate(update) {
    const priority = getUpdatePriority(update);
    if (priority === "p0" || priority === "p1") {
      const p = this.handlePriorityUpdate(update, priority).catch((err) => console.error(`[${priority}] error:`, err));
      return p;
    }
    // 相册入站聚合：首条出现时立即在对应 session.updateChain 占位，保证后续普通消息排在相册之后 (ref: python-telegram-bot media_group)
    if (update.message?.media_group_id && this.isAllowed(update.message.from, update.message.chat)) {
      const m = update.message;
      this.chatReady = true;
      const session = this.getOrCreateSession(m);
      this.telegram.setReaction(this.chatId, m.message_id, this.config.ackEmoji);
      if (session.pendingUi) return;
      const key = `${this.chatId}:${m.media_group_id}`;
      let group = session.mediaGroups.get(key);
      if (!group) {
        let resolveReady;
        const ready = new Promise((r) => { resolveReady = r; });
        group = { messages: [], timer: null, ready, resolveReady, cancelled: false };
        session.mediaGroups.set(key, group);
        const groupTask = async () => {
          await group.ready;
          if (group.cancelled || !group.messages.length) return;
          session.runStartedAt = performance.now();
          session.runFirstTokenAt = null;
          session.runFirstUiAt = null;
          await session.handleMediaGroup(group.messages);
        };
        const next = session.updateChain.then(groupTask).catch((err) => {
          console.error("Media group error:", err);
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
    return Promise.resolve();
  }

  async handlePriorityUpdate(update, priority) {
    const t0 = performance.now();
    try {
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
      const session = this.getOrCreateSession(m);
      await session.handleCommand(cmd, m.text, update.update_id);
    } catch (error) {
      console.error(`[${priority}] error:`, error);
      const session = update.message ? this.getOrCreateSession(update.message) : this.mainSession;
      await session.send(`❌ ${error.message}`);
    } finally {
      console.log(`${new Date().toISOString()} [${priority}] finished in ${Math.round(performance.now() - t0)}ms`);
    }
  }

  async handleUpdate(update, session = this.mainSession) {
    const t0 = performance.now();
    try {
      if (update.message) {
        if (!this.isAllowed(update.message.from, update.message.chat)) return;
        this.chatReady = true;
        const m = update.message;
        const lag = m.date ? `${Date.now() - m.date * 1000}ms` : "0ms";
        const kind = m.text ? "text"
          : m.photo ? "photo"
          : m.voice ? "voice"
          : m.document ? "document"
          : m.video ? "video"
          : m.video_note ? "video_note"
          : m.audio ? "audio"
          : "other";
        const textLen = (m.text || m.caption || "").length;
        const meta = textLen ? `${kind}, ${textLen} chars` : kind;
        // ref: https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html — do not log user message content
        console.log(`${new Date().toISOString()} [update] msg #${m.message_id} (tg lag: ${lag}): ${meta}`);
        await this.handleMessage(update.message, session);
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

  async handleMessage(message, session = this.getOrCreateSession(message)) {
    if (session.pendingUi && !message.text?.startsWith("/")) {
      const pending = session.pendingUi;
      session.pendingUi = null;
      this.telegram.setReaction(this.chatId, message.message_id, this.config.ackEmoji);
      session.pi.write({ type: "extension_ui_response", id: pending.id, value: message.text || message.caption || "" });
      await session.send("Submitted.");
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
          session.runStartedAt = performance.now();
          session.runFirstTokenAt = null;
          session.runFirstUiAt = null;
          await session.prompt(`${transcript}${message.caption ? `\n\n${message.caption}` : ""}`);
          return;
        } catch (error) {
          return session.send(`❌ ${error.message}`);
        }
      }
      session.runStartedAt = performance.now();
      session.runFirstTokenAt = null;
      session.runFirstUiAt = null;
      await session.prompt(attachmentPrompt(message.caption || `User sent a ${media.label}.`, [media.saved]), media.image ? [media.image] : undefined);
      return;
    }

    const text = message.text?.trim();
    if (!text) return;

    this.telegram.setReaction(this.chatId, message.message_id, this.config.ackEmoji);

    const command = parseCommand(text);
    if (command) {
      await session.handleCommand(command, text);
    } else {
      session.runStartedAt = performance.now();
      session.runFirstTokenAt = null;
      session.runFirstUiAt = null;
      await session.prompt(text);
    }
  }

  async registerBotCommands() {
    const t0 = performance.now();
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
    console.log(`${new Date().toISOString()} [gateway] bot commands registered (${finalCommands.length}) in ${Math.round(performance.now() - t0)}ms`);
  }

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
    return next;
  }

  action(payload, ttl = 10 * 60_000) {
    const now = Date.now();
    for (const [key, value] of this.actions) if (value.expires < now) this.actions.delete(key);
    const token = randomBytes(6).toString("base64url");
    this.actions.set(token, { ...payload, expires: now + ttl });
    return `a:${token}`;
  }

  startHerdrWatcher() {
    if (this.herdrWatcher) return;
    const env = [...this.sessions.values()].find((s) => s.pi?.herdrEnv?.HERDR_BIN_PATH)?.pi?.herdrEnv
      || this.herdrEnvironment;
    if (!env?.HERDR_BIN_PATH || !env?.HERDR_SOCKET_PATH) return;
    this.herdrWatcher = new HerdrWatcher({
      bin: env.HERDR_BIN_PATH,
      socketPath: env.HERDR_SOCKET_PATH,
      // Own remote_ask dialogs already have buttons; other TUI dialogs only get Enter/Esc.
      isExcluded: (paneId) => [...this.sessions.values()].some((s) => s.binding.paneId === paneId && (s.pendingUi || s.uiMessages?.size)),
      onTransition: ({ paneId, status, agent }) => status === "blocked" ? this.sendHerdrAgent(paneId, status, agent) : undefined,
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
    }))));
  }

  async replyToHerdrAgent(paneId, message) {
    this.telegram.setReaction(this.chatId, message.message_id, this.config.ackEmoji);
    const target = [...this.sessions.values()].find((s) => s.binding.paneId === paneId && s.pi.proc);
    if (!target) return this.telegram.send(this.chatId, "Enable /remote-control in that Pi pane first. Prompts are never sent with terminal keystrokes.");
    return target.prompt(message.text.trim());
  }

  keyboard(items) {
    return { reply_markup: { inline_keyboard: items.map(({ label, action }) => [{ text: label.slice(0, 60), callback_data: this.action(action) }]) } };
  }

  async handleCallback(callback, session = this.mainSession) {
    const t0 = performance.now();
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
    } finally {
      console.log(`${new Date().toISOString()} [callback] ${action.type} finished in ${Math.round(performance.now() - t0)}ms`);
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
    return session.send(`Close topic "${basename(session.cwd)}"? ${session.binding.owned ? "This will quit its Pi and close its pane." : "This only detaches Telegram; your desktop Pi keeps running."} The topic will be removed.`, keyboard);
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
    if (this.downloadCleanupTimer) {
      clearInterval(this.downloadCleanupTimer);
      this.downloadCleanupTimer = null;
    }
    this.telegram?.stopPolling?.();
    this.telegram?.stopWakeMonitor?.();
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
  errorActions, expandableBlockquote, extensionFromMime, extractText,
  formatAssistantError, formatContextTokens, formatRunCard, formatSessionReset,
  getUpdatePriority, herdrOptedIn, herdrTail, isConnectPhaseError,
  loadConfig, loadState, nextFallbackModel, paneHasForegroundShell,
  parseCommand, parseNumberConfig, parseNumstat, pollBackoffMs,
  previewText, redactLog, renderReplyHtml, renderToolPanel,
  resolveAgentSessionFile, resolveHerdrEnvironment, resolvePath,
  retryableTelegramStatus, runCommand, runStt, scanDesktopSessions,
  sessionKeyOf, setTestMode, shellQuote, shouldRetryTelegram,
  telegramCommandName, telegramHtml, toolSummary,
};
