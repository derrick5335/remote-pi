// Interactive Pi bridge; only Pi 1.3.0 public extension APIs are used.
// @ts-nocheck
import net from "node:net";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const TOOLS = ["remote_attach", "remote_ask"];
const INTERNAL_COMMANDS = { new_session: "remote-pi-new", switch_session: "remote-pi-switch", fork: "remote-pi-fork" };

// ref: Pi docs/rpc.md#framing — LF only; setEncoding preserves split UTF-8 code points.
export function readJsonLines(socket, onMessage) {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buffer += chunk;
    if (buffer.length > 64 * 1024 * 1024) return socket.destroy(new Error("Bridge record too large"));
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); }
      catch { socket.destroy(new Error("Invalid bridge JSON")); return; }
      if (!message || typeof message !== "object" || Array.isArray(message) || typeof message.type !== "string") {
        socket.destroy(new Error("Invalid bridge record"));
        return;
      }
      onMessage(message);
    }
  });
}

export function writeJsonLine(socket, message) {
  if (!socket || socket.destroyed || !socket.writable) return false;
  // ref: Node stream writableLength — bound queued output rather than blocking Pi's event loop on a slow view.
  if (socket.writableLength > 64 * 1024 * 1024) {
    socket.destroy(new Error("Bridge output backlog too large"));
    return false;
  }
  socket.write(`${JSON.stringify(message)}\n`);
  return true;
}

async function bridgePath(env) {
  if (env.REMOTE_PI_BRIDGE_SOCKET) return env.REMOTE_PI_BRIDGE_SOCKET;
  const configPath = env.REMOTE_PI_CONFIG || join(homedir(), ".config", "remote-pi", "config.json");
  let config = {};
  try { config = JSON.parse(await readFile(configPath, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const path = config.stateDir || join(homedir(), ".local", "var", "remote-pi");
  const stateDir = path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(2)) : resolve(dirname(configPath), path);
  return join(stateDir, "bridge.sock");
}

function herdrRequest(env, method, params) {
  return new Promise((resolveRequest, reject) => {
    const socket = net.createConnection(env.HERDR_SOCKET_PATH);
    const id = randomUUID();
    const timer = setTimeout(() => finish(new Error("Herdr did not respond")), 2000);
    const finish = (error, value) => {
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error); else resolveRequest(value);
    };
    socket.on("error", (error) => finish(error));
    socket.on("connect", () => socket.write(`${JSON.stringify({ id, method, params })}\n`));
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      const index = buffer.indexOf("\n");
      if (index < 0) return;
      try {
        const result = JSON.parse(buffer.slice(0, index));
        if (result.id !== id) return;
        finish(result.error ? new Error(result.error.message || result.error.code) : null, result.result);
      } catch (error) { finish(error); }
    });
  });
}

function textOf(content) {
  return typeof content === "string" ? content : (content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
}

// ref: Pi docs/extensions.md#context-and-session-changes; dist/core/extensions/types.d.ts.
export function createRemoteBridge(pi, { env = process.env, metadata = herdrRequest, connect = net.createConnection } = {}) {
  let ctx;
  let socket;
  let retryTimer;
  let retries = 0;
  let enabled = false;
  let disposed = false;
  let path;
  let startEvent = {};
  let compacting = false;
  const dialogs = new Map();
  const replacements = new Map();
  const paneId = env.HERDR_PANE_ID;
  const send = (message) => writeJsonLine(socket, message);
  const response = (request, data, error) => send({ id: request.id, type: "response", command: request.type, success: !error, ...(error ? { error: error.message || String(error) } : { data }) });
  const setTools = (on) => pi.setActiveTools([...pi.getActiveTools().filter((name) => !TOOLS.includes(name)), ...(on ? TOOLS : [])]);
  const setOn = (on) => metadata(env, "pane.report_metadata", {
    pane_id: paneId, source: "remote-pi",
    tokens: { remote_pi: on ? "on" : null, remote_pi_session: on ? ctx.sessionManager.getSessionFile() : null },
  });
  const hello = () => send({
    type: "hello", paneId, cwd: ctx.cwd, sessionFile: ctx.sessionManager.getSessionFile(),
    sessionId: ctx.sessionManager.getSessionId(), pid: process.pid, version: 1,
    reason: startEvent.reason, previousSessionFile: startEvent.previousSessionFile, state: state(),
  });
  const disconnect = () => {
    clearTimeout(retryTimer);
    retryTimer = null;
    for (const dialog of dialogs.values()) dialog.finish(undefined);
    const current = socket;
    socket = null;
    current?.end();
    current?.setTimeout(2000, () => current.destroy());
    setTools(false);
  };
  const reconnect = () => {
    if (!enabled || disposed || retryTimer) return;
    retryTimer = setTimeout(() => { retryTimer = null; open(); }, Math.min(10_000, 250 * 2 ** Math.min(retries++, 6)));
    retryTimer.unref?.();
  };
  const open = () => {
    if (!enabled || disposed || socket) return;
    const current = connect({ path });
    socket = current;
    current.on("connect", () => {
      if (socket !== current || disposed || !enabled) return current.destroy();
      retries = 0;
      setTools(true);
      hello();
    });
    current.on("error", () => {});
    current.on("close", () => {
      if (socket !== current) return;
      socket = null;
      setTools(false);
      for (const dialog of dialogs.values()) dialog.finish(undefined);
      reconnect();
    });
    readJsonLines(current, (message) => {
      if (message.type === "extension_ui_response") {
        const dialog = dialogs.get(message.id);
        if (dialog && (message.cancelled || dialog.options.includes(message.value))) dialog.finish(message.cancelled ? undefined : message.value);
        return;
      }
      if (typeof message.id !== "string" || !message.id) return current.destroy(new Error("Bridge request id required"));
      void dispatch(message).then((data) => {
        if (!INTERNAL_COMMANDS[message.type] && !["quit", "remote_off"].includes(message.type)) response(message, data);
      }).catch((error) => response(message, null, error));
    });
  };
  const state = () => ({
    model: ctx.model || null, thinkingLevel: pi.getThinkingLevel(), isStreaming: !ctx.isIdle(), isCompacting: compacting,
    sessionFile: ctx.sessionManager.getSessionFile(), sessionId: ctx.sessionManager.getSessionId(), sessionName: pi.getSessionName(),
    cwd: ctx.cwd, messageCount: ctx.sessionManager.getBranch().filter((entry) => entry.type === "message").length,
  });
  const stats = () => {
    const entries = ctx.sessionManager.getEntries();
    const messages = entries.filter((entry) => entry.type === "message").map((entry) => entry.message);
    const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
    let cost = 0;
    for (const entry of entries) {
      const usage = entry.type === "message" ? entry.message.usage : entry.usage;
      if (!usage) continue;
      for (const key of ["input", "output", "cacheRead", "cacheWrite"]) tokens[key] += usage[key] || 0;
      cost += usage.cost?.total || 0;
    }
    // ref: Pi AgentSession.getSessionStats — sum all four token buckets, including compaction/branch usage.
    tokens.total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
    return {
      sessionFile: ctx.sessionManager.getSessionFile(), sessionId: ctx.sessionManager.getSessionId(),
      userMessages: messages.filter((m) => m.role === "user").length,
      assistantMessages: messages.filter((m) => m.role === "assistant").length,
      toolCalls: messages.reduce((n, m) => n + (Array.isArray(m.content) ? m.content.filter((b) => b.type === "toolCall").length : 0), 0),
      toolResults: messages.filter((m) => m.role === "toolResult").length, totalMessages: messages.length,
      tokens, cost, contextUsage: ctx.getContextUsage(),
    };
  };
  const levels = () => {
    if (!ctx.model?.reasoning) return ["off"];
    const map = ctx.model.thinkingLevelMap;
    // ref: Pi docs/rpc-commands.md#set_thinking_level; a model's native map marks unsupported levels null.
    return ["off", "minimal", "low", "medium", "high", "xhigh", "max"].filter((level) => map ? map[level] !== null && (level !== "max" && level !== "xhigh" || map[level] !== undefined) : !["xhigh", "max"].includes(level));
  };
  async function dispatch(request) {
    if (!ctx || disposed) throw new Error("Pi session is not ready");
    switch (request.type) {
    case "prompt": case "steer": case "follow_up": {
      if (typeof request.message !== "string" || request.images !== undefined && !Array.isArray(request.images)) throw new Error("Invalid prompt");
      if (request.images?.some((i) => i.type !== "image" || typeof i.data !== "string" || typeof i.mimeType !== "string")) throw new Error("Invalid image");
      const deliverAs = request.type === "steer" ? "steer" : request.type === "follow_up" ? "followUp" : request.streamingBehavior;
      if (deliverAs !== undefined && !["steer", "followUp"].includes(deliverAs)) throw new Error("Invalid streaming behavior");
      if (!ctx.isIdle() && !deliverAs) throw new Error("Agent is streaming; specify streamingBehavior");
      const content = request.images?.length ? [{ type: "text", text: request.message }, ...request.images] : request.message;
      // ref: Pi 1.3.0 ExtensionAPI.sendUserMessage — expansion is opt-in, including extension command dispatch.
      pi.sendUserMessage(content, { expandPromptTemplates: true, ...(!ctx.isIdle() ? { deliverAs } : {}) });
      return {};
    }
    case "abort": ctx.abort(); return {};
    case "clear_queue":
      // shortcut: Pi 1.3.0 has no public queue inspection/clear API; use a native API when exposed.
      return { steering: [], followUp: [] };
    case "get_state": return state();
    case "get_session_stats": return stats();
    case "get_available_models": return { models: ctx.modelRegistry.getAvailable() };
    case "set_model": {
      const model = ctx.modelRegistry.find(request.provider, request.modelId);
      if (!model || !await pi.setModel(model)) throw new Error("Model unavailable or missing credentials");
      return model;
    }
    case "get_available_thinking_levels": return { levels: levels() };
    case "set_thinking_level":
      if (!levels().includes(request.level)) throw new Error("Unsupported thinking level");
      pi.setThinkingLevel(request.level); return {};
    case "compact": return new Promise((done, reject) => ctx.compact({ customInstructions: request.customInstructions, onComplete: done, onError: reject }));
    case "bash": {
      if (typeof request.command !== "string") throw new Error("Shell command required");
      const result = await pi.exec("bash", ["-lc", request.command], { cwd: ctx.cwd });
      return { output: result.stdout + result.stderr, exitCode: result.code, cancelled: result.killed };
    }
    case "get_commands": return { commands: pi.getCommands().filter((c) => !Object.values(INTERNAL_COMMANDS).includes(c.name)) };
    case "set_session_name":
      if (typeof request.name !== "string") throw new Error("Session name required");
      pi.setSessionName(request.name); return {};
    case "get_last_assistant_text": {
      const last = ctx.sessionManager.getBranch().filter((e) => e.type === "message" && e.message.role === "assistant").at(-1);
      return { text: last ? textOf(last.message.content) : null };
    }
    case "get_fork_messages": return { messages: ctx.sessionManager.getBranch().filter((e) => e.type === "message" && e.message.role === "user").map((e) => ({ entryId: e.id, text: textOf(e.message.content) })) };
    case "new_session": case "switch_session": case "fork": {
      if (replacements.size) throw new Error("Session replacement already pending");
      if (request.type === "switch_session" && (typeof request.sessionPath !== "string" || !request.sessionPath.startsWith("/"))) throw new Error("Absolute session path required");
      if (request.type === "fork" && typeof request.entryId !== "string") throw new Error("Fork entry id required");
      replacements.set(request.id, request);
      // ref: Pi docs/extensions.md#context-and-session-changes; examples/extensions/reload-runtime.ts.
      try {
        pi.sendUserMessage(`/${INTERNAL_COMMANDS[request.type]} ${request.id}`, { expandPromptTemplates: true, ...(!ctx.isIdle() ? { deliverAs: "followUp" } : {}) });
      } catch (error) { replacements.delete(request.id); throw error; }
      return;
    }
    case "export_html": {
      const file = ctx.sessionManager.getSessionFile();
      if (!file) throw new Error("No persisted session to export");
      const out = request.outputPath || join(dirname(file), `export-${randomUUID()}.html`);
      const result = await pi.exec("pi", ["--export", file, out], { cwd: ctx.cwd });
      if (result.code !== 0) throw new Error(result.stderr || "Export failed");
      return { path: out };
    }
    case "remote_off": enabled = false; await setOn(false); response(request, {}); disconnect(); return {};
    case "quit":
      response(request, {});
      ctx.abort(); ctx.shutdown(); return {};
    default: throw new Error(`Unsupported bridge command: ${request.type}`);
    }
  }

  for (const [type, command] of Object.entries(INTERNAL_COMMANDS)) {
    pi.registerCommand(command, {
      handler: async (id, commandCtx) => {
        const request = replacements.get(id.trim());
        if (!request || request.type !== type) return;
        replacements.delete(id.trim());
        const text = type === "fork" ? textOf(commandCtx.sessionManager.getBranch().find((e) => e.id === request.entryId)?.message?.content) : undefined;
        send({ type: "session_replacing", id: request.id, command: type, text });
        try {
          // Only plain request data is captured. A successful replacement tears down this runtime;
          // the new runtime's hello completes the gateway request, never the stale pi/ctx below.
          const result = type === "new_session" ? await commandCtx.newSession({ parentSession: request.parentSession })
            : type === "switch_session" ? await commandCtx.switchSession(request.sessionPath)
            : await commandCtx.fork(request.entryId);
          if (result.cancelled) response(request, { cancelled: true, ...(text !== undefined ? { text } : {}) });
        } catch (error) { if (!disposed) response(request, null, error); }
      },
    });
  }

  pi.registerCommand("remote-control", {
    description: "Attach this Pi to Telegram (on | off | status; no argument toggles)",
    handler: async (argument, currentCtx) => {
      ctx = currentCtx;
      if (env.HERDR_ENV !== "1" || !paneId || !env.HERDR_SOCKET_PATH) return ctx.ui.notify("/remote-control only works inside a Herdr pane.", "error");
      const arg = argument.trim().toLowerCase();
      if (arg && !["on", "off", "status"].includes(arg)) return ctx.ui.notify("Usage: /remote-control [on|off|status]", "error");
      if (arg === "status") return ctx.ui.notify(`Remote control: ${enabled ? socket?.readyState === "open" ? "connected" : "reconnecting" : "off"}`, "info");
      try {
        enabled = arg === "on" || arg !== "off" && !enabled;
        await setOn(enabled);
        if (enabled) { path ||= await bridgePath(env); open(); } else disconnect();
        ctx.ui.notify(`Remote control ${enabled ? "on" : "off"}.`, "info");
      } catch (error) { ctx.ui.notify(`/remote-control failed: ${error.message}`, "error"); }
    },
  });

  pi.registerTool({
    name: "remote_attach", label: "Remote Attach", description: "Send local files to the user's chat as attachments with the current reply.",
    promptSnippet: "Deliver local files to the chat", promptGuidelines: ["Use remote_attach when the user asks for a file or generated artifact."],
    parameters: { type: "object", properties: { paths: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 10 } }, required: ["paths"] },
    async execute(_id, params, _signal, _update, toolCtx) {
      if (!socket || socket.readyState !== "open") throw new Error("Remote control is not connected");
      const paths = params.paths.map((p) => resolve(toolCtx.cwd, p));
      for (const path of paths) { if (!(await stat(path)).isFile()) throw new Error(`Not a file: ${path}`); }
      return { content: [{ type: "text", text: `Queued ${paths.length} attachment(s) for delivery.` }], details: { paths } };
    },
  });
  pi.registerTool({
    name: "remote_ask", label: "Remote Ask", description: "Ask a multiple-choice question in Telegram and the terminal; the first answer wins.",
    promptSnippet: "Ask the user a multiple-choice question with buttons", promptGuidelines: ["Use remote_ask only when user input is needed to unblock the next step."],
    parameters: { type: "object", properties: { question: { type: "string" }, options: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 8 } }, required: ["question", "options"] },
    async execute(_id, params, signal, _update, toolCtx) {
      if (!socket || socket.readyState !== "open") throw new Error("Remote control is not connected");
      const answer = await new Promise((done, reject) => {
        const id = randomUUID();
        const controller = new AbortController();
        let finished = false;
        const finish = (value, error) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", cancel);
          dialogs.delete(id);
          controller.abort();
          send({ type: "extension_ui_resolved", id, value, cancelled: value === undefined });
          if (error) reject(error); else done(value);
        };
        const cancel = () => finish(undefined);
        const timer = setTimeout(cancel, 5 * 60_000);
        dialogs.set(id, { finish, options: params.options });
        signal?.addEventListener("abort", cancel, { once: true });
        if (signal?.aborted) return cancel();
        send({ type: "extension_ui_request", id, method: "select", title: params.question, options: params.options, timeout: 5 * 60_000 });
        // ref: Pi examples/extensions/timed-confirm.ts — AbortSignal dismisses the losing TUI dialog.
        Promise.resolve().then(() => toolCtx.ui.select(params.question, params.options, { signal: controller.signal })).then((value) => finish(value), (error) => finish(undefined, error));
      });
      return { content: [{ type: "text", text: answer ? `User selected: ${answer}` : "(User did not answer within 5 minutes, or cancelled)" }], details: { answer: answer ?? null } };
    },
  });

  pi.on("session_start", async (event, currentCtx) => {
    ctx = currentCtx;
    startEvent = event;
    setTools(false);
    if (env.HERDR_ENV !== "1" || !env.HERDR_SOCKET_PATH || !paneId) return;
    const pane = await metadata(env, "pane.get", { pane_id: paneId }).catch(() => null);
    enabled = pane?.pane?.tokens?.remote_pi === "on" || env.REMOTE_PI_ATTACH === "1" && event.reason === "startup";
    if (!enabled) return;
    await setOn(true);
    path = await bridgePath(env);
    open();
  });
  pi.on("session_shutdown", async (event) => {
    disposed = true;
    if (event.reason === "quit" && enabled) await setOn(false).catch(() => {});
    disconnect();
  });
  // Pi 1.3.0 exposes no public auto_retry_start/end hooks; retry notifications are unavailable here.
  for (const type of ["agent_start", "agent_end", "agent_settled", "turn_start", "turn_end", "message_start", "message_update", "message_end", "tool_execution_start", "tool_execution_update", "tool_execution_end"]) {
    pi.on(type, (event, currentCtx) => { ctx = currentCtx; send(event); });
  }
  pi.on("input", (event, currentCtx) => {
    ctx = currentCtx;
    if (event.source === "interactive") send({ type: "remote_user_input", text: event.text });
  });
  pi.on("session_before_switch", async (event, currentCtx) => {
    ctx = currentCtx;
    if (!enabled || event.reason !== "resume" || !event.targetSessionFile || !env.HERDR_SOCKET_PATH) return;
    // ref: Herdr agent.list exposes the native agent_session path; refuse another writer even from the desktop picker.
    let result;
    try { result = await metadata(env, "agent.list", {}); }
    catch {
      ctx.ui.notify("Cannot verify whether that session is already open; try again when Herdr is reachable.", "error");
      return { cancel: true };
    }
    const other = result?.agents?.find((agent) => agent.pane_id !== paneId && agent.agent === "pi" && agent.agent_session?.value === event.targetSessionFile);
    if (other) {
      ctx.ui.notify(`Session is already open in ${other.pane_id}. Switch to that pane instead.`, "error");
      return { cancel: true };
    }
  });
  pi.on("session_before_compact", (event, currentCtx) => {
    ctx = currentCtx; compacting = true;
    send({ type: "compaction_start", reason: event.reason });
  });
  pi.on("session_compact", (event, currentCtx) => {
    ctx = currentCtx; compacting = false;
    send({ type: "compaction_end", reason: event.reason, result: event.compactionEntry, aborted: false, willRetry: event.willRetry });
  });
  pi.on("session_compact_failed", (event, currentCtx) => {
    ctx = currentCtx; compacting = false;
    send({ ...event, type: "compaction_end", result: null });
  });
  return { dispatch };
}

export default function (pi) {
  createRemoteBridge(pi);
}
