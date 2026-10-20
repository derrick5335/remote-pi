// Interactive Pi bridge; only Pi 1.3.0 public extension APIs are used.
// ref: Pi docs/extensions.md — extension types from @earendil-works/pi-coding-agent.
import net from "node:net";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext, ExtensionEvent, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import type { TObject, TArray, TString } from "typebox";

const TOOLS = ["remote_attach", "remote_ask"];
const INTERNAL_COMMANDS: Record<string, string> = { new_session: "remote-pi-new", switch_session: "remote-pi-switch" };
// ref: Pi docs/rpc.md#framing — LF only; setEncoding preserves split UTF-8 code points.
export function readJsonLines(socket: net.Socket, onMessage: (message: any) => void, requireType = true) {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string | Buffer) => {
    let index = buffer.length; // resume where the last scan stopped so large records are scanned once
    buffer += chunk;
    if (buffer.length > 64 * 1024 * 1024) return socket.destroy(new Error("Bridge record too large"));
    while ((index = buffer.indexOf("\n", index)) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      index = 0;
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
        if (!message || typeof message !== "object" || Array.isArray(message) || requireType && typeof message.type !== "string") throw new Error("Invalid bridge record");
      } catch (error: any) { return socket.destroy(error); }
      onMessage(message);
    }
  });
}

export function writeJsonLine(socket: net.Socket | null | undefined, message: unknown) {
  if (!socket || socket.destroyed || !socket.writable) return false;
  // ref: Node stream writableLength — bound queued output rather than blocking Pi's event loop on a slow view.
  if (socket.writableLength > 64 * 1024 * 1024) {
    socket.destroy(new Error("Bridge output backlog too large"));
    return false;
  }
  socket.write(`${JSON.stringify(message)}\n`);
  return true;
}
async function bridgePath(env: Record<string, string | undefined>) {
  const configPath = env.REMOTE_PI_CONFIG || join(homedir(), ".config", "remote-pi", "config.json");
  let config: { stateDir?: string } = {};
  try { config = JSON.parse(await readFile(configPath, "utf8")); } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
  const path = config.stateDir || join(homedir(), ".local", "var", "remote-pi");
  const stateDir = path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(2)) : resolve(dirname(configPath), path);
  return join(stateDir, "bridge.sock");
}
export function herdrRequest(env: Record<string, string | undefined>, method: string, params: Record<string, unknown> = {}): Promise<any> {
  return new Promise((resolveRequest, reject) => {
    const socket = net.createConnection(env.HERDR_SOCKET_PATH!);
    const id = randomUUID();
    // ref: Herdr AgentStartParams.timeout_ms — allow the native startup deadline plus transport grace.
    const timer = setTimeout(() => finish(new Error("Herdr did not respond")), typeof params.timeout_ms === "number" ? params.timeout_ms + 2000 : 2000);
    const finish = (error: Error | null, value?: any) => {
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
export const textOf = (content: string | { type: string; text?: string }[]) =>
  typeof content === "string" ? content : (content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
export const reconnectDelayMs = (attempt: number) => Math.min(10_000, 250 * 2 ** Math.min(attempt, 6));
// ref: Pi dist/modes/json-event.d.ts toJsonEvent — drop cumulative snapshots and tool output the gateway never reads.
function wireEvent({ type, ...event }: any) {
  if (type === "message_update") return event.assistantMessageEvent.type === "text_delta" ? { type, assistantMessageEvent: { type: "text_delta", delta: event.assistantMessageEvent.delta } } : null;
  if (type !== "tool_execution_end") return { type, ...event };
  return { type, toolName: event.toolName, isError: event.isError, ...(event.toolName === "remote_attach" ? { result: { details: event.result?.details } } : {}) };
}

// ref: Pi docs/extensions.md#context-and-session-changes; dist/core/extensions/types.d.ts.
// Lazy public import keeps the framing helpers usable by plain Node without a local Pi installation.
const listPiSessions = async (cwd: string, dir?: string) => (await import("@earendil-works/pi-coding-agent")).SessionManager.list(cwd, dir);
type BridgeOptions = {
  env?: Record<string, string | undefined>; metadata?: typeof herdrRequest;
  connect?: typeof net.createConnection; listSessions?: typeof listPiSessions;
};
export function createRemoteBridge(pi: ExtensionAPI, options: BridgeOptions = {}) {
  const { env = process.env, metadata = herdrRequest, connect = net.createConnection, listSessions = listPiSessions } = options;
  let ctx: ExtensionContext, socket: net.Socket | null = null, retryTimer: ReturnType<typeof setTimeout> | null = null;
  let path: string, terminalId: string | undefined, retries = 0, enabled = false, disposed = false, startEvent: Partial<SessionStartEvent> = {};
  const dialogs = new Map<string, { finish: (value?: string, error?: unknown) => void; request: { options: string[] } & Record<string, unknown> }>();
  const replacements = new Map<string, Record<string, any>>(), paneId = env.HERDR_PANE_ID;
  const send = (message: unknown) => message !== null && writeJsonLine(socket, message);
  const on = <K extends ExtensionEvent["type"]>(type: K, handler: (event: Extract<ExtensionEvent, { type: K }>) => unknown) => {
    const register = pi.on as (type: K, handler: (event: Extract<ExtensionEvent, { type: K }>, ctx: ExtensionContext) => unknown) => unknown;
    return register(type, (event, currentCtx) => {
      ctx = currentCtx;
      return handler(event);
    });
  };
  const response = (request: any, data?: any, error?: any) => send({ id: request.id, type: "response", command: request.type, success: !error, ...(error ? { error: error.message || String(error) } : { data }) });
  const setTools = (on: boolean) => pi.setActiveTools([...pi.getActiveTools().filter((name) => !TOOLS.includes(name)), ...(on ? TOOLS : [])]);
  const setOn = (on: boolean) => metadata(env, "pane.report_metadata", {
    pane_id: paneId!, source: "remote-pi",
    tokens: { remote_pi: on ? "on" : null, remote_pi_session: on ? ctx?.sessionManager.getSessionFile() : null },
  });
  // ref: Claude Code Remote Control shows persistent active indicator (https://code.claude.com/docs/en/remote-control)
  const setStatus = (text?: string) => {
    try { if (ctx?.hasUI || ctx?.mode === "tui") ctx.ui?.setStatus?.("remote-pi", text); } catch {}
  };
  const getRecent = () => {
    try {
      const branch = ctx?.sessionManager?.getBranch?.() || ctx?.sessionManager?.getEntries?.() || [];
      const texts = (role: "user" | "assistant") => branch.flatMap((e) => e.type === "message" && e.message.role === role ? [textOf(e.message.content).trim()] : []).filter(Boolean);
      const userTexts = texts("user"), assistantTexts = texts("assistant");
      return {
        firstUserText: userTexts[0]?.slice(0, 60) || undefined,
        lastUserText: userTexts.at(-1)?.slice(0, 300) || undefined,
        lastAssistantText: assistantTexts.at(-1)?.slice(0, 800) || undefined,
      };
    } catch { return {}; }
  };
  const identity = () => ({ sessionFile: ctx?.sessionManager.getSessionFile(), sessionId: ctx?.sessionManager.getSessionId() });
  const hello = () => send({
    type: "hello", paneId, terminalId, cwd: ctx?.cwd, ...identity(), pid: process.pid, version: 1,
    reason: startEvent.reason, previousSessionFile: startEvent.previousSessionFile, state: state(),
    sessionName: pi.getSessionName?.() || ctx?.sessionManager?.getSessionName?.() || undefined,
    recent: getRecent(),
  });
  // ref: https://nodejs.org/api/net.html#event-close — reconnect only after close, and cancel timers on explicit detach.
  const disconnect = (retry = false) => {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    if (!retry) for (const dialog of dialogs.values()) dialog.finish(undefined);
    const current = socket;
    socket = null;
    current?.end().setTimeout(2000, () => current.destroy());
    setTools(false);
    setStatus(enabled ? "📱 reconnecting…" : undefined);
    if (retry && enabled && !disposed) retryTimer = setTimeout(() => {
      retryTimer = null;
      open();
    }, reconnectDelayMs(retries++)).unref();
  };
  const open = () => {
    if (!enabled || disposed || socket || !path) return;
    const current = connect({ path });
    socket = current;
    current.on("connect", () => {
      if (socket !== current || disposed || !enabled) return current.destroy();
      retries = 0;
      setTools(true);
      hello();
      for (const dialog of dialogs.values()) send(dialog.request);
      setStatus("📱 remote");
    });
    current.on("error", () => {});
    current.on("close", () => {
      if (socket === current) disconnect(true);
    });
    readJsonLines(current, (message) => {
      if (message.type === "extension_ui_response") {
        const dialog = dialogs.get(message.id);
        if (dialog && (message.cancelled || dialog.request.options.includes(message.value))) dialog.finish(message.cancelled ? undefined : message.value);
        return;
      }
      if (typeof message.id !== "string" || !message.id) return current.destroy(new Error("Bridge request id required"));
      void dispatch(message).then((data) => {
        if (!INTERNAL_COMMANDS[message.type] && !["quit", "remote_off"].includes(message.type)) response(message, data);
      }).catch((error) => response(message, null, error));
    });
  };
  const setEnabled = async (on: boolean, pane?: any) => {
    if (on) terminalId = (pane || await metadata(env, "pane.get", { pane_id: paneId! }))?.pane?.terminal_id;
    enabled = on;
    await setOn(on);
    setStatus(on ? "📱 reconnecting…" : undefined);
    if (!on) return disconnect();
    path ||= await bridgePath(env);
    open();
  };
  const state = () => ({
    model: ctx?.model || null, thinkingLevel: pi.getThinkingLevel(), isStreaming: !ctx?.isIdle(),
    ...identity(), sessionName: pi.getSessionName(), cwd: ctx?.cwd,
  });
  const stats = () => {
    let cost = 0;
    for (const entry of ctx.sessionManager.getEntries()) {
      const usage = entry.type === "message" ? ("usage" in entry.message ? entry.message.usage : undefined) : "usage" in entry ? entry.usage : undefined;
      cost += usage?.cost?.total || 0;
    }
    return { ...identity(), cost, contextUsage: ctx?.getContextUsage() };
  };
  const levels = () => {
    if (!ctx?.model?.reasoning) return ["off"];
    const map = ctx.model.thinkingLevelMap;
    // ref: Pi docs/rpc-commands.md#set_thinking_level; a model's native map marks unsupported levels null.
    const supported = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
    return supported.filter((level) => map ? map[level] !== null && (level !== "max" && level !== "xhigh" || map[level] !== undefined) : !["xhigh", "max"].includes(level));
  };
  async function dispatch(request: any): Promise<any> {
    if (!ctx || disposed) throw new Error("Pi session is not ready");
    switch (request.type) {
      case "prompt": {
        if (typeof request.message !== "string" || request.images !== undefined && !Array.isArray(request.images)) throw new Error("Invalid prompt");
        if (request.images?.some((i: any) => i.type !== "image" || typeof i.data !== "string" || typeof i.mimeType !== "string")) throw new Error("Invalid image");
        const deliverAs = request.streamingBehavior;
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
      case "compact": return new Promise((done, reject) => ctx!.compact({ customInstructions: request.customInstructions, onComplete: done, onError: reject }));
      case "bash": {
        if (typeof request.command !== "string") throw new Error("Shell command required");
        const result = await pi.exec("bash", ["-lc", request.command], { cwd: ctx.cwd });
        return { output: result.stdout + result.stderr, exitCode: result.code, cancelled: result.killed };
      }
      // ref: Pi 1.3.0 dist/core/session-manager.d.ts — list respects the active native session directory.
      case "list_sessions": {
        const sessions = await listSessions(ctx.cwd, ctx.sessionManager.getSessionDir());
        return { sessions: sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime()).slice(0, 12)
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
      } catch (error: any) { ctx.ui.notify(`/remote-control failed: ${error?.message || error}`, "error"); }
    },
  });
  // ref: Pi ToolDefinition<TParams> — type-only TypeBox annotations keep the existing JSON schemas unchanged at runtime.
  pi.registerTool({
    name: "remote_attach", label: "Remote Attach", description: "Send local files to the user's chat as attachments with the current reply.",
    promptSnippet: "Deliver local files to the chat", promptGuidelines: ["Use remote_attach when the user asks for a file or generated artifact."],
    parameters: { type: "object", properties: { paths: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 10 } }, required: ["paths"] } as unknown as TObject<{ paths: TArray<TString> }>,
    async execute(_id, params, _signal, _update, toolCtx) {
      if (!socket || socket.readyState !== "open") throw new Error("Remote control is not connected");
      const paths = params.paths.map((p: string) => resolve(toolCtx.cwd, p));
      for (const path of paths) { if (!(await stat(path)).isFile()) throw new Error(`Not a file: ${path}`); }
      return { content: [{ type: "text", text: `Queued ${paths.length} attachment(s) for delivery.` }], details: { paths } };
    },
  });
  pi.registerTool({
    name: "remote_ask", label: "Remote Ask", description: "Ask a multiple-choice question in Telegram and the terminal; the first answer wins.",
    promptSnippet: "Ask the user a multiple-choice question with buttons", promptGuidelines: ["Use remote_ask only when user input is needed to unblock the next step."],
    parameters: { type: "object", properties: { question: { type: "string" }, options: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 8 } }, required: ["question", "options"] } as unknown as TObject<{ question: TString; options: TArray<TString> }>,
    async execute(_id, params, signal, _update, toolCtx) {
      if (!socket || socket.readyState !== "open") throw new Error("Remote control is not connected");
      const answer = await new Promise<string | undefined>((done, reject) => {
        const id = randomUUID();
        const controller = new AbortController();
        const finish = (value?: string, error?: any) => {
          if (!dialogs.delete(id)) return;
          clearTimeout(timer);
          signal?.removeEventListener("abort", cancel);
          controller.abort();
          send({ type: "extension_ui_resolved", id, value, cancelled: value === undefined });
          if (error) reject(error); else done(value);
        };
        const cancel = () => finish(undefined);
        const timer = setTimeout(cancel, 5 * 60_000);
        const request = { type: "extension_ui_request", id, method: "select", title: params.question, options: params.options, timeout: 5 * 60_000 };
        dialogs.set(id, { finish, request });
        signal?.addEventListener("abort", cancel, { once: true });
        if (signal?.aborted) return cancel();
        send(request);
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
    enabled = pane?.pane?.tokens?.remote_pi === "on";
    if (enabled) await setEnabled(true, pane); else setStatus(undefined);
  });
  pi.on("session_shutdown", async (event) => {
    disposed = true;
    if (event.reason === "quit" && enabled) await setOn(false).catch(() => {});
    setStatus(undefined);
    disconnect();
  });
  // Pi 1.3.0 exposes no public auto_retry_start/end hooks; retry notifications are unavailable here.
  for (const type of ["agent_start", "agent_settled", "message_start", "message_update", "message_end", "tool_execution_start", "tool_execution_end", "session_info_changed"] as const) on(type, (event) => send(wireEvent(event)));
  on("input", (event) => { if (event.source === "interactive") send({ type: "remote_user_input", text: event.text }); });
  on("session_before_switch", async (event) => {
    if (!enabled || event.reason !== "resume" || !event.targetSessionFile || !env.HERDR_SOCKET_PATH) return;
    // ref: Herdr agent.list exposes the native agent_session path; refuse another writer even from the desktop picker.
    let result: any;
    try { result = await metadata(env, "agent.list", {}); } catch {
      ctx?.ui.notify("Cannot verify whether that session is already open; try again when Herdr is reachable.", "error");
      return { cancel: true };
    }
    const other = result?.agents?.find((agent: any) => agent.pane_id !== paneId && agent.agent === "pi" && agent.agent_session?.value === event.targetSessionFile);
    if (other) {
      ctx?.ui.notify(`Session is already open in ${other.pane_id}. Switch to that pane instead.`, "error");
      return { cancel: true };
    }
  });
  on("session_compact", (event) => send({ type: "compaction_end", reason: event.reason, result: event.compactionEntry, aborted: false, willRetry: event.willRetry }));
  on("session_compact_failed", (event) => send({ ...event, type: "compaction_end", result: null }));
}
export default (pi: ExtensionAPI) => createRemoteBridge(pi);
