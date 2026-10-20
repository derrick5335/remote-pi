// Interactive Pi bridge; only Pi 1.3.0 public extension APIs are used.
// @ts-nocheck
import net from "node:net";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const TOOLS = ["remote_attach", "remote_ask"];
const INTERNAL_COMMANDS = { new_session: "remote-pi-new", switch_session: "remote-pi-switch" };
// ref: Pi docs/rpc.md#framing — LF only; setEncoding preserves split UTF-8 code points.
export function readJsonLines(socket, onMessage, requireType = true) {
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
      try {
        message = JSON.parse(line);
        if (!message || typeof message !== "object" || Array.isArray(message) || requireType && typeof message.type !== "string") throw new Error("Invalid bridge record");
      } catch (error) { return socket.destroy(error); }
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
  try { config = JSON.parse(await readFile(configPath, "utf8")); } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
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
    readJsonLines(socket, (result) => {
      if (result.id === id) finish(result.error ? new Error(result.error.message || result.error.code) : null, result.result);
    }, false);
  });
}
const textOf = (content) => typeof content === "string" ? content : (content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");

// ref: Pi docs/extensions.md#context-and-session-changes; dist/core/extensions/types.d.ts.
// Lazy public import keeps the framing helpers usable by plain Node without a local Pi installation.
const listPiSessions = async (cwd, dir) => (await import("@earendil-works/pi-coding-agent")).SessionManager.list(cwd, dir);
export function createRemoteBridge(pi, { env = process.env, metadata = herdrRequest, connect = net.createConnection, listSessions = listPiSessions } = {}) {
  let ctx, socket, retryTimer, path, retries = 0, enabled = false, disposed = false, startEvent = {};
  const dialogs = new Map(), replacements = new Map(), paneId = env.HERDR_PANE_ID;
  const send = (message) => writeJsonLine(socket, message);
  const on = (type, handler) => pi.on(type, (event, currentCtx) => {
    ctx = currentCtx;
    return handler(event);
  });
  const response = (request, data, error) => send({ id: request.id, type: "response", command: request.type, success: !error, ...(error ? { error: error.message || String(error) } : { data }) });
  const setTools = (on) => pi.setActiveTools([...pi.getActiveTools().filter((name) => !TOOLS.includes(name)), ...(on ? TOOLS : [])]);
  const setOn = (on) => metadata(env, "pane.report_metadata", {
    pane_id: paneId, source: "remote-pi",
    tokens: { remote_pi: on ? "on" : null, remote_pi_session: on ? ctx.sessionManager.getSessionFile() : null },
  });
  // ref: Claude Code Remote Control shows persistent active indicator (https://code.claude.com/docs/en/remote-control)
  const setStatus = (text) => {
    try { if (ctx?.hasUI || ctx?.mode === "tui") ctx.ui?.setStatus?.("remote-pi", text); } catch {}
  };
  const getRecent = () => {
    try {
      const branch = ctx?.sessionManager?.getBranch?.() || ctx?.sessionManager?.getEntries?.() || [];
      const texts = (role) => branch.filter((e) => e?.type === "message" && e.message?.role === role).map((e) => textOf(e.message.content).trim()).filter(Boolean);
      const userTexts = texts("user"), assistantTexts = texts("assistant");
      return {
        firstUserText: userTexts[0]?.slice(0, 60) || undefined,
        lastUserText: userTexts.at(-1)?.slice(0, 300) || undefined,
        lastAssistantText: assistantTexts.at(-1)?.slice(0, 800) || undefined,
      };
    } catch { return {}; }
  };
  const identity = () => ({ sessionFile: ctx.sessionManager.getSessionFile(), sessionId: ctx.sessionManager.getSessionId() });
  const hello = () => send({
    type: "hello", paneId, cwd: ctx.cwd, ...identity(), pid: process.pid, version: 1,
    reason: startEvent.reason, previousSessionFile: startEvent.previousSessionFile, state: state(),
    sessionName: pi.getSessionName?.() || ctx?.sessionManager?.getSessionName?.() || undefined,
    recent: getRecent(),
  });
  // ref: https://nodejs.org/api/net.html#event-close — reconnect only after close, and cancel timers on explicit detach.
  const disconnect = (retry = false) => {
    clearTimeout(retryTimer);
    retryTimer = null;
    for (const dialog of dialogs.values()) dialog.finish(undefined);
    const current = socket;
    socket = null;
    current?.end().setTimeout(2000, () => current.destroy());
    setTools(false);
    setStatus(enabled ? "📱 reconnecting…" : undefined);
    if (retry && enabled && !disposed) retryTimer = setTimeout(() => {
      retryTimer = null;
      open();
    }, Math.min(10_000, 250 * 2 ** Math.min(retries++, 6))).unref();
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
      setStatus("📱 remote");
    });
    current.on("error", () => {});
    current.on("close", () => {
      if (socket === current) disconnect(true);
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
  const setEnabled = async (on) => {
    enabled = on;
    await setOn(on);
    setStatus(on ? "📱 reconnecting…" : undefined);
    if (!on) return disconnect();
    path ||= await bridgePath(env);
    open();
  };
  const state = () => ({
    model: ctx.model || null, thinkingLevel: pi.getThinkingLevel(), isStreaming: !ctx.isIdle(),
    ...identity(), sessionName: pi.getSessionName(), cwd: ctx.cwd,
  });
  const stats = () => {
    const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
    let cost = 0;
    for (const entry of ctx.sessionManager.getEntries()) {
      const usage = entry.type === "message" ? entry.message.usage : entry.usage;
      if (!usage) continue;
      for (const key of ["input", "output", "cacheRead", "cacheWrite"]) tokens[key] += usage[key] || 0;
      cost += usage.cost?.total || 0;
    }
    // ref: Pi AgentSession.getSessionStats — sum all four token buckets, including compaction/branch usage.
    tokens.total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
    return { ...identity(), tokens, cost, contextUsage: ctx.getContextUsage() };
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
      // ref: Pi 1.3.0 dist/core/session-manager.d.ts — list respects the active native session directory.
      case "list_sessions": {
        const sessions = await listSessions(ctx.cwd, ctx.sessionManager.getSessionDir());
        return { sessions: sessions.sort((a, b) => b.modified - a.modified).slice(0, 12)
          .map((s) => ({ path: s.path, title: s.name || s.firstMessage?.split("\n")[0].slice(0, 60) || basename(s.path) })) };
      }
      case "get_commands": return { commands: pi.getCommands().filter((c) => !Object.values(INTERNAL_COMMANDS).includes(c.name)) };
      case "set_session_name":
        if (typeof request.name !== "string") throw new Error("Session name required");
        pi.setSessionName(request.name); return {};
      case "new_session": case "switch_session": {
        if (replacements.size) throw new Error("Session replacement already pending");
        if (request.type === "switch_session" && (typeof request.sessionPath !== "string" || !request.sessionPath.startsWith("/"))) throw new Error("Absolute session path required");
        replacements.set(request.id, request);
        // ref: Pi docs/extensions.md#context-and-session-changes; examples/extensions/reload-runtime.ts.
        try {
          pi.sendUserMessage(`/${INTERNAL_COMMANDS[request.type]} ${request.id}`, { expandPromptTemplates: true, ...(!ctx.isIdle() ? { deliverAs: "followUp" } : {}) });
        } catch (error) { replacements.delete(request.id); throw error; }
        return;
      }
      case "remote_off":
        enabled = false;
        await setOn(false);
        try { if (ctx?.hasUI || ctx?.mode === "tui") ctx.ui?.notify?.("Remote control turned off from Telegram.", "info"); } catch {}
        response(request, {});
        disconnect();
        return {};
      case "quit":
        response(request, {});
        ctx.abort();
        ctx.shutdown();
        return {};
      default: throw new Error(`Unsupported bridge command: ${request.type}`);
    }
  }
  for (const [type, command] of Object.entries(INTERNAL_COMMANDS)) {
    pi.registerCommand(command, {
      handler: async (id, commandCtx) => {
        const request = replacements.get(id.trim());
        if (!request || request.type !== type) return;
        replacements.delete(id.trim());
        send({ type: "session_replacing", id: request.id, command: type });
        try {
          // Only plain request data survives replacement; the new runtime's hello completes the request.
          const result = type === "new_session" ? await commandCtx.newSession({ parentSession: request.parentSession })
            : await commandCtx.switchSession(request.sessionPath);
          if (result.cancelled) response(request, { cancelled: true });
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
      if (arg === "status") return ctx.ui.notify(`Remote control: ${enabled ? socket?.readyState === "open" ? "connected (📱 remote)" : "reconnecting (📱 reconnecting…)" : "off"}`, "info");
      try {
        await setEnabled(arg === "on" || arg !== "off" && !enabled);
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
        const finish = (value, error) => {
          if (!dialogs.delete(id)) return;
          clearTimeout(timer);
          signal?.removeEventListener("abort", cancel);
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
        Promise.resolve().then(() => toolCtx.ui.select(params.question, params.options, { signal: controller.signal }))
          .then((value) => finish(value), (error) => finish(undefined, error));
      });
      return { content: [{ type: "text", text: answer ? `User selected: ${answer}` : "(User did not answer within 5 minutes, or cancelled)" }], details: { answer: answer ?? null } };
    },
  });
  on("session_start", async (event) => {
    startEvent = event;
    setTools(false);
    if (env.HERDR_ENV !== "1" || !env.HERDR_SOCKET_PATH || !paneId) return;
    const pane = await metadata(env, "pane.get", { pane_id: paneId }).catch(() => null);
    enabled = pane?.pane?.tokens?.remote_pi === "on" || env.REMOTE_PI_ATTACH === "1" && event.reason === "startup";
    if (enabled) await setEnabled(true); else setStatus(undefined);
  });
  pi.on("session_shutdown", async (event) => {
    disposed = true;
    if (event.reason === "quit" && enabled) await setOn(false).catch(() => {});
    setStatus(undefined);
    disconnect();
  });
  // Pi 1.3.0 exposes no public auto_retry_start/end hooks; retry notifications are unavailable here.
  for (const type of ["agent_start", "agent_settled", "message_start", "message_update", "message_end", "tool_execution_start", "tool_execution_end", "session_info_changed"]) on(type, send);
  on("input", (event) => { if (event.source === "interactive") send({ type: "remote_user_input", text: event.text }); });
  on("session_before_switch", async (event) => {
    if (!enabled || event.reason !== "resume" || !event.targetSessionFile || !env.HERDR_SOCKET_PATH) return;
    // ref: Herdr agent.list exposes the native agent_session path; refuse another writer even from the desktop picker.
    let result;
    try { result = await metadata(env, "agent.list", {}); } catch {
      ctx.ui.notify("Cannot verify whether that session is already open; try again when Herdr is reachable.", "error");
      return { cancel: true };
    }
    const other = result?.agents?.find((agent) => agent.pane_id !== paneId && agent.agent === "pi" && agent.agent_session?.value === event.targetSessionFile);
    if (other) {
      ctx.ui.notify(`Session is already open in ${other.pane_id}. Switch to that pane instead.`, "error");
      return { cancel: true };
    }
  });
  on("session_compact", (event) => send({ type: "compaction_end", reason: event.reason, result: event.compactionEntry, aborted: false, willRetry: event.willRetry }));
  on("session_compact_failed", (event) => send({ ...event, type: "compaction_end", result: null }));
  return { dispatch };
}
export default (pi) => createRemoteBridge(pi);
