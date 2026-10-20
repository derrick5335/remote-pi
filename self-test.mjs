import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, writeSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readlink, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { Duplex } from "node:stream";
import { basename, dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createRemoteBridge } from "./remote-pi.ts";
import {
  BOT_COMMANDS, ChatSession, Gateway, HELP, MAX_MESSAGE, PaneRpc, Telegram,
  chunks, expandableBlockquote, formatAssistantError, loadConfig, loadState, paneHasForegroundShell, parseCommand,
  pollBackoffMs, sessionKeyOf, setTestMode, shouldRetryTelegram, telegramCommandName, telegramHtml,
} from "./gateway.mjs";

const LINE_BUDGET = 2000;
const until = async (predicate) => {
  for (let i = 0; i < 300; i++) {
    if (await predicate()) return;
    await sleep(10);
  }
  assert.fail("Timed out waiting for self-test");
};
const message = (text, extra = {}) => ({ message_id: 42, text, from: { id: 1 }, chat: { type: "private" }, ...extra });

async function selfTestPaneBridge() {
  const dir = await mkdtemp(join(tmpdir(), "rp-"));
  const path = join(dir, "bridge.sock");
  const config = { allowedUserId: "1", botToken: "1:x", stateDir: dir, cwd: dir };
  await writeFile(join(dir, "config.json"), JSON.stringify(config));
  let gateway = new Gateway(config);
  const outputs = [];
  const events = [];
  let messageId = 0;
  const mockGateway = (gw) => {
    gw.chatReady = true;
    gw.telegram.send = async (_chat, text) => {
      outputs.push(text);
      return { message_id: ++messageId };
    };
    gw.telegram.call = async () => true;
    const handle = gw.mainSession.handleEvent.bind(gw.mainSession);
    gw.mainSession.handleEvent = async (event) => {
      events.push(event);
      await handle(event);
    };
  };
  mockGateway(gateway);
  const initialFile = join(dir, "s1.jsonl");
  gateway.mainSession.binding = { paneId: "w1:p-test", sessionFile: initialFile, cwd: dir, owned: true };
  const env = { HERDR_ENV: "1", HERDR_SOCKET_PATH: "/fake-herdr", HERDR_PANE_ID: "w1:p-test", REMOTE_PI_CONFIG: join(dir, "config.json") };
  const tokens = { remote_pi: "on" };
  const prompts = [];
  const selections = [];
  let current;
  let runtimeCount = 0;
  let aborted = 0;
  let quit = 0;
  let slowExec;
  let cancelledReplacement = false;
  let otherAgents = [];
  const metadata = async (_env, method, params) => {
    if (method === "pane.get") return { pane: { tokens, terminal_id: "term-test" } };
    if (method === "pane.report_metadata") {
      Object.assign(tokens, params.tokens);
      return {};
    }
    if (method === "agent.list") return { agents: [{ pane_id: "w1:p-test", agent: "pi", name: "test-agent" }, ...otherAgents] };
    assert.fail(`Unexpected Herdr call ${method}`);
  };
  const runtime = (file) => {
    runtimeCount++;
    const handlers = new Map();
    const commands = new Map();
    const tools = new Map();
    let active = ["read", "bash"];
    let live = true;
    let idle = true;
    const statusCalls = [];
    const notifyCalls = [];
    const check = () => { assert.ok(live, "replacement must not access stale Pi/ctx"); };
    const entries = [
      { id: "u1", type: "message", message: { role: "user", content: "hello" } },
      { id: "a1", type: "message", message: { role: "assistant", content: [{ type: "text", text: "answer" }], usage: { input: 10, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 19, cost: { total: 0.2 } } } },
      { id: "a2", type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "bash", arguments: {} }] } },
    ];
    const model = { provider: "fake", id: "m", reasoning: true, thinkingLevelMap: { minimal: null, xhigh: "xhigh", max: null } };
    const ctx = {
      cwd: dir, model, mode: "tui", hasUI: true, isIdle: () => idle, hasPendingMessages: () => false,
      sessionManager: {
        getSessionFile: () => { check(); return file; }, getSessionId: () => file,
        getEntries: () => entries, getBranch: () => entries, getSessionDir: () => join(dir, "native"),
      },
      abort: () => { aborted++; }, shutdown: () => { quit++; },
      ui: {
        setStatus: (key, text) => { statusCalls.push({ key, text }); },
        notify: (msg, type) => { notifyCalls.push({ msg, type }); },
        select: (_title, _options, { signal }) => new Promise((done) => {
          const selection = { done, cancelled: false };
          selections.push(selection);
          const cancel = () => {
            selection.cancelled = true;
            done(undefined);
          };
          signal.addEventListener("abort", cancel, { once: true });
          if (signal.aborted) cancel();
        }),
      },
    };
    const emit = async (type, fields = {}) => handlers.get(type)?.({ type, ...fields }, ctx);
    const replace = async (reason, nextFile) => {
      if (cancelledReplacement) return { cancelled: true };
      await emit("session_shutdown", { reason, targetSessionFile: nextFile });
      live = false;
      current = runtime(nextFile);
      await current.emit("session_start", { reason, previousSessionFile: file });
      return { cancelled: false };
    };
    ctx.newSession = async () => replace("new", join(dir, "s2.jsonl"));
    ctx.switchSession = async (nextFile) => replace("resume", nextFile);
    const pi = {
      on: (type, handler) => handlers.set(type, handler),
      registerCommand: (name, command) => commands.set(name, command),
      registerTool: (tool) => { tools.set(tool.name, tool); active.push(tool.name); },
      getActiveTools: () => {
        check();
        return active;
      }, setActiveTools: (names) => {
        check();
        active = names;
      },
      getThinkingLevel: () => "high", setThinkingLevel: () => {},
      getSessionName: () => "test", setSessionName: () => {},
      getCommands: () => [...commands.keys()].map((name) => ({ name, source: "extension" })),
      exec: async (cmd, args, options) => {
        assert.deepEqual([cmd, options], ["bash", { cwd: dir }]);
        if (args[1] === "slow") await new Promise((done) => { slowExec = done; });
        return { stdout: "out", stderr: "err", code: 7, killed: false };
      },
      sendUserMessage: (content, options) => {
        check(); prompts.push({ content, options });
        if (typeof content === "string" && content.startsWith("/remote-pi-")) {
          assert.equal(options.expandPromptTemplates, true);
          const [command, id] = content.slice(1).split(" ");
          queueMicrotask(() => commands.get(command).handler(id, ctx).catch((error) => { throw error; }));
        } else void emit("input", { text: typeof content === "string" ? content : "image", source: "extension" });
      },
    };
    createRemoteBridge(pi, { env, metadata, listSessions: async (cwd, sessionDir) => {
      assert.deepEqual([cwd, sessionDir], [dir, join(dir, "native")]);
      return Array.from({ length: 15 }, (_, i) => ({
        path: join(dir, `s-${i}.jsonl`), modified: new Date(i),
        name: i === 14 ? "Named session" : "", firstMessage: i === 13 ? "a".repeat(80) + "\nsecond line" : "",
      }));
    } });
    return { pi, ctx, tools, commands, emit, statusCalls, notifyCalls, setIdle: (value) => { idle = value; } };
  };
  try {
    await gateway.bridge.start();
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    current = runtime(initialFile);
    await current.emit("session_start", { reason: "startup" });
    await until(() => gateway.mainSession.pi.proc && current.statusCalls.at(-1)?.text === "📱 remote");
    const conn = [...gateway.bridge.connections.values()][0];
    // Invalid or duplicate hellos must not replace the established session owner.
    for (const hello of [
      { ...conn.hello, version: 2 }, { ...conn.hello, cwd: "relative" },
      { ...conn.hello, sessionFile: "relative" }, { ...conn.hello, pid: 0 },
      { ...conn.hello, sessionId: null }, { ...conn.hello, paneId: "" },
      { ...conn.hello, paneId: "other-pane" }, { ...conn.hello, terminalId: 1 },
    ]) {
      const socket = net.connect(path);
      socket.on("error", () => {});
      socket.write(`${JSON.stringify(hello)}\n`);
      await until(() => socket.destroyed);
      assert.equal(gateway.bridge.connections.size, 1);
    }
    assert.deepEqual([conn.hello.terminalId, conn.hello.sessionName], ["term-test", "test"]);
    assert.deepEqual(conn.hello.recent, { firstUserText: "hello", lastUserText: "hello", lastAssistantText: "answer" });
    const session = gateway.mainSession;
    assert.deepEqual(current.pi.getActiveTools(), ["read", "bash", "remote_attach", "remote_ask"]);
    const { sessions } = await session.pi.request("list_sessions");
    assert.equal(sessions.length, 12);
    assert.deepEqual(sessions.slice(0, 3).map((s) => s.title), ["Named session", "a".repeat(60), "s-12.jsonl"]);
    assert.equal(sessions[0].path, join(dir, "s-14.jsonl"));
    assert.ok(!(await session.pi.request("get_commands")).commands.some((c) => c.name.startsWith("remote-pi-")));
    await assert.rejects(session.pi.request("unsupported"), /Unsupported bridge command/);
    const slow = session.pi.request("bash", { command: "slow" });
    await until(() => slowExec);
    assert.equal((await session.pi.request("get_state")).sessionFile, initialFile, "out-of-order responses correlate by id");
    slowExec();
    assert.deepEqual(await slow, { output: "outerr", exitCode: 7, cancelled: false });
    await current.emit("input", { text: "desktop \u2028 prompt", source: "interactive" });
    await current.emit("input", { text: "do not echo", source: "extension" });
    await until(() => outputs.includes("🖥 desktop \u2028 prompt"));
    assert.ok(!outputs.some((text) => text.includes("do not echo")));
    await current.emit("agent_start");
    await until(() => session.isStreaming);
    await current.emit("agent_end", { messages: [] });
    await session.eventChain;
    assert.equal(session.isStreaming, true, "agent_end is not the final boundary");
    await current.emit("agent_settled");
    await until(() => !session.isStreaming);
    otherAgents = [{ pane_id: "w1:p-other", agent: "pi", agent_session: { kind: "path", value: "/busy.jsonl" } }];
    assert.deepEqual(await current.emit("session_before_switch", { reason: "resume", targetSessionFile: "/busy.jsonl" }), { cancel: true }, "desktop picker refuses a second writer");
    otherAgents = [];

    for (const side of ["telegram", "terminal"]) {
      const count = selections.length;
      const result = current.tools.get("remote_ask").execute("ask", { question: "Pick?", options: ["A", "B"] }, undefined, undefined, current.ctx);
      await until(() => selections.length > count && events.some((e) => e.type === "extension_ui_request" && !events.some((r) => r.type === "extension_ui_resolved" && r.id === e.id)));
      const request = events.filter((e) => e.type === "extension_ui_request").at(-1);
      if (side === "telegram") session.pi.write({ type: "extension_ui_response", id: request.id, value: "A" });
      else selections.at(-1).done("B");
      assert.deepEqual([(await result).details.answer, selections.at(-1).cancelled], [side === "telegram" ? "A" : "B", true], "losing TUI dialog is aborted");
      await until(() => events.some((e) => e.type === "extension_ui_resolved" && e.id === request.id));
      await session.eventChain;
      assert.ok(![...gateway.actions.values()].some((a) => a.type === "ui" && a.requestId === request.id));
      session.pi.write({ type: "extension_ui_response", id: request.id, value: "A" });
    }
    cancelledReplacement = true;
    assert.equal((await session.pi.request("new_session")).cancelled, true);
    cancelledReplacement = false;
    current.setIdle(false);
    assert.equal((await session.pi.request("new_session")).cancelled, false);
    assert.equal(prompts.at(-1).options.deliverAs, "followUp", "session command queues while streaming");
    assert.ok(prompts.at(-1).content.startsWith("/remote-pi-new "));
    assert.deepEqual([(await session.pi.request("get_state")).sessionFile, session.binding.sessionFile], [join(dir, "s2.jsonl"), join(dir, "s2.jsonl")]);
    const view = new ChatSession(gateway, { threadId: 321, cwd: dir });
    view.binding = { cwd: dir, sessionFile: session.binding.sessionFile };
    gateway.sessions.set(view.key, view);
    await Promise.all([view.pi.ensureStarted(), session.pi.ensureStarted()]);
    assert.equal(view.pi.proc, session.pi.proc, "served session binds the existing process, never starts Pi");
    await gateway.dispatchUpdate({ stopped_message_generation: { chat: { id: 2, type: "private" }, message_thread_id: 321, draft_id: 1 } });
    await gateway.dispatchUpdate({ stopped_message_generation: { chat: { id: 1, type: "group" }, message_thread_id: 321, draft_id: 1 } });
    await gateway.dispatchUpdate({ stopped_message_generation: { chat: { id: 1, type: "private" }, message_thread_id: 999, draft_id: 1 } });
    assert.equal(aborted, 0, "unauthorized chats and unknown threads do not abort Pi");
    await gateway.dispatchUpdate({ stopped_message_generation: { chat: { id: 1, type: "private" }, message_thread_id: 321, draft_id: 1 } });
    assert.equal(aborted, 1, "topic Stop reaches the native Pi abort API");
    view.stop();
    session.pi.stop();
    await gateway.bridge.stop();
    await until(() => !current.pi.getActiveTools().includes("remote_ask"));
    gateway = new Gateway(config);
    mockGateway(gateway);
    await gateway.bridge.start();
    await until(() => gateway.mainSession.pi.proc);
    assert.equal((await gateway.mainSession.pi.request("get_state")).sessionFile, join(dir, "s2.jsonl"));
    assert.equal(runtimeCount, 2, "gateway restart does not start a replacement Pi");
    for (const [key, view] of gateway.sessions) {
      if (view === gateway.mainSession) continue;
      view.stop();
      gateway.sessions.delete(key);
    }
    gateway.mainSession.binding.owned = false;
    await gateway.closePaneSession(gateway.mainSession);
    await until(() => !current.pi.getActiveTools().includes("remote_ask"));
    assert.equal(quit, 0, "closing a desktop view only turns remote off");
    assert.equal(tokens.remote_pi, null);
    assert.equal(current.statusCalls.at(-1)?.text, undefined, "setStatus cleared when remote is off");
    assert.ok(current.notifyCalls.some((c) => c.msg === "Remote control turned off from Telegram."), "notify user when remote is turned off from Telegram");
    await current.commands.get("remote-control").handler("on", current.ctx);
    await until(() => gateway.mainSession.pi.proc && current.statusCalls.at(-1)?.text === "📱 remote");
    await current.commands.get("remote-control").handler("status", current.ctx);
    assert.ok(current.notifyCalls.some((c) => c.msg?.includes("connected (📱 remote)")));
    assert.equal(gateway.mainSession.pi.stopping, false);
    const askPending = current.tools.get("remote_ask").execute("ask", { question: "Drop?", options: ["A", "B"] }, undefined, undefined, current.ctx);
    await until(() => selections.length === 3);
    const dropRequest = events.filter((e) => e.type === "extension_ui_request").at(-1);
    const reqCount = events.filter((e) => e.type === "extension_ui_request" && e.id === dropRequest.id).length;

    // Assert connected -> reconnecting -> connected transition on socket drop
    const connBeforeDrop = [...gateway.bridge.connections.values()][0];
    connBeforeDrop?.socket?.destroy();
    await until(() => current.statusCalls.some((c) => c.text === "📱 reconnecting…"));
    await until(() => current.statusCalls.at(-1)?.text === "📱 remote");
    assert.equal(selections.at(-1).cancelled, false, "close keeps dialog pending");
    await until(() => events.filter((e) => e.type === "extension_ui_request" && e.id === dropRequest.id).length > reqCount);
    await gateway.mainSession.eventChain;
    assert.equal(outputs.filter((text) => text === "Drop?").length, 1, "replayed UI request does not duplicate the Telegram question");
    await current.commands.get("remote-control").handler("off", current.ctx);
    assert.equal(selections.at(-1).cancelled, true, "explicit off cancels pending dialog");
    assert.equal((await askPending).details.answer, null);
    gateway.mainSession.pi.stop();
    await gateway.bridge.stop();
  } finally {
    if (current) await current.emit("session_shutdown", { reason: "quit" });
    for (const session of gateway.sessions.values()) session.stop();
    await gateway.bridge.stop();
    await rm(dir, { recursive: true, force: true });
  }
}

// ref: https://nodejs.org/api/timers.html — a referenced deadline also covers unresolved promises with no live handles.
async function pollFake(tg, call, handler) {
  let failure;
  const guard = (fake) => async (...args) => {
    try { return await fake(...args); } catch (error) {
      if (error.code === "ERR_ASSERTION") {
        failure = error;
        tg.stopPolling();
      }
      throw error;
    }
  };
  tg.call = guard(call);
  await tg.poll(guard(handler));
  if (failure) throw failure;
}
async function selfTest() {
  let activeTest = "setup";
  const exit = process.exit.bind(process);
  const watchdog = setTimeout(() => {
    writeSync(2, `self-test: timed out after 60s in ${activeTest}\n`);
    exit(1);
  }, 60_000);
  setTestMode(true);
  const fetchBefore = globalThis.fetch, connectBefore = net.connect, createBefore = net.createConnection;
  const dir = await mkdtemp(join(tmpdir(), "rp-tests-"));
  globalThis.fetch = async (url) => { throw new Error(`Unexpected network call: ${url}`); };
  net.connect = net.createConnection = function (...args) {
    const path = typeof args[0] === "string" ? args[0] : args[0]?.path;
    if (!path?.startsWith(`${tmpdir()}/`) || path === process.env.HERDR_SOCKET_PATH) {
      throw new Error(`Self-test only permits temporary sockets: ${path}`);
    }
    return connectBefore.apply(this, args);
  };
  const fresh = async () => {
    const stateDir = await mkdtemp(join(dir, "case-"));
    const gw = new Gateway({ allowedUserId: "1", botToken: "1:x", stateDir, cwd: stateDir });
    gw.chatReady = true;
    const calls = [];
    gw.telegram.call = async (method, body) => {
      calls.push({ method, body });
      return { message_id: calls.length };
    };
    return { gw, s: gw.mainSession, calls };
  };
  try {
    const root = dirname(fileURLToPath(import.meta.url));
    activeTest = "Pi pane bridge";
    await selfTestPaneBridge();

    activeTest = "Auth is checked before topic creation or callback lookup; topics route independently.";
    {
      const { gw, calls } = await fresh();
      for (const extra of [{ from: { id: 2 } }, { chat: { type: "group" } }, { chat: { type: "supergroup" } }]) {
        const m = message("intruder", { message_thread_id: 99, ...extra });
        await gw.dispatchUpdate({ message: m });
        await gw.dispatchUpdate({ callback_query: { id: "cb", from: m.from, message: m, data: "a:bad" } });
      }
      assert.deepEqual([gw.sessions.size, calls.length], [1, 0]);
      assert.equal(sessionKeyOf(message("main")), "main");
      assert.equal(sessionKeyOf(message("topic", { message_thread_id: 99 })), "t:99");
      assert.equal(sessionKeyOf(message("not topic", { message_thread_id: 99, is_topic_message: false })), "main");
      const order = [], gate = Promise.withResolvers(), topicMessage = (text) => message(text, { message_thread_id: 99 });
      gw.persistPaneSession = () => gate.promise;
      gw.handleUpdate = async (u) => {
        order.push(u.message.text);
        if (u.message.text === "slow") await gate.promise;
      };
      const first = gw.dispatchUpdate({ message: topicMessage("slow") });
      await until(() => order.length);
      const topic = gw.sessions.get("t:99");
      assert.ok(topic.pi instanceof PaneRpc);
      assert.equal(topic.cwd, gw.mainSession.cwd);
      topic.handleCommand = async ({ name }) => { order.push(name); };
      const ordinary = BOT_COMMANDS.filter((c) => !["abort", "restart"].includes(c.command)).map((c) => `/${c.command}`);
      const queued = ["queued", ...ordinary].map((text) => gw.dispatchUpdate({ message: topicMessage(text) }));
      await gw.dispatchUpdate({ message: message("other") });
      await gw.dispatchUpdate({ message: topicMessage("/abort") });
      assert.deepEqual(order, ["slow", "other", "abort"]);
      gate.resolve();
      await Promise.all([first, ...queued]);
      assert.deepEqual(order.slice(3), ["queued", ...ordinary], "only abort and restart bypass the update chain");
    }

    for (const [owned, deleteTopic] of [[true, false], [false, false], [true, true]]) {
      const { gw, calls } = await fresh();
      const s = await gw.createTopic({ threadId: 99, cwd: dir, name: "deleted", binding: { owned, paneId: "gone" } });
      const requests = [];
      s.pi.proc = {};
      s.pi.request = async (type) => {
        requests.push(type);
        if (owned && !deleteTopic) throw new Error("refused to quit");
      };
      gw.herdrSocketPath = "/fake/socket";
      gw.herdr = async () => { throw new Error("pane already gone"); };
      gw.telegram.send = async () => Promise.reject(new Error("Bad Request: message thread not found"));
      if (deleteTopic) await gw.closeTopic(99, { deleteTopic }); else await s.send("final output");
      assert.deepEqual(requests, [owned ? "quit" : "remote_off"]);
      const state = loadState(gw.config.stateDir);
      assert.deepEqual([gw.sessions.has(s.key), state.topics[99], state.herdrPanes[s.key]], [false, undefined, undefined]);
      assert.equal(calls.some((c) => c.method === "deleteForumTopic"), deleteTopic);
    }
    activeTest = "Attach-only startup never spawns; even a live Pi without hello must only be attached.";
    {
      const { gw, s } = await fresh();
      await gw.bridge.start();
      try {
        s.binding = { paneId: "gone", sessionFile: join(dir, "gone.jsonl"), owned: true };
        assert.deepEqual([await gw.ensurePaneSession(s.pi, { spawn: false }), s.pi.proc], [false, null]);
        const c = { socket: { destroyed: false, writable: true }, clients: new Set(), hello: { paneId: "live", cwd: dir, sessionFile: s.binding.sessionFile } };
        gw.liveSessionPane = async () => "live";
        let waited = false;
        gw.bridge.waitFor = async (predicate) => {
          waited = predicate(c);
          return c;
        };
        gw.herdr = async () => ({ process_info: { shell_pid: 1, foreground_process_group_id: 2 } });
        assert.deepEqual([await gw.startPaneSession(s.pi, { spawn: false }), waited, s.pi.proc], [true, true, c.socket]);
        s.stop();
      } finally { await gw.bridge.stop(); }
    }
    {
      const { gw, s } = await fresh();
      gw.me = { has_topics_enabled: true };
      s.binding = { paneId: "reused", terminalId: "old", sessionFile: "/old.jsonl", owned: true };
      const connection = { socket: { writable: true }, clients: new Set(), hello: { paneId: "reused", terminalId: "new", sessionFile: "/new.jsonl", cwd: dir } };
      gw.bridge.connections.set("reused", connection);
      assert.equal(gw.bridge.find(s.binding), undefined);
      await gw.onPaneHello(connection);
      const attached = [...gw.sessions.values()].find((view) => view !== s);
      assert.deepEqual([s.pi.proc, attached.binding.owned, attached.binding.terminalId], [null, false, "new"], "reused pane id binds a new topic");
      gw.herdrSocketPath = "/fake/socket";
      gw.herdr = async (method, params) => {
        assert.deepEqual([method, params], ["pane.get", { pane_id: "reused" }]);
        return { type: "pane_info", pane: { terminal_id: "new" } };
      };
      await gw.closePaneSession(s);
      attached.stop();
    }
    activeTest = "Socket lifecycle: foreground-shell safety, persisted-pane reuse, native startup arguments and close.";
    for (const mode of ["new", "saved", "gone", "pi", "busy", "reused", "attached"]) {
      const { gw, s } = await fresh(), requests = [], file = mode === "saved" ? join(dir, "saved.jsonl") : undefined;
      gw.herdrSocketPath = "/fake/socket";
      s.binding = { cwd: s.cwd, sessionFile: file, owned: mode !== "attached", terminalId: "term-saved", ...(mode !== "new" ? { paneId: "saved" } : {}) };
      gw.bridge.server = {};
      gw.bridge.start = async () => {};
      gw.bridge.waitFor = async () => ({});
      s.pi.bind = () => {};
      gw.herdr = async (method, params) => {
        requests.push({ method, params });
        if (method === "agent.list") return { type: "agent_list", agents: [] };
        if (method === "pane.get") {
          if (mode === "gone") throw new Error("missing");
          return { type: "pane_info", pane: { pane_id: "saved", terminal_id: mode === "reused" ? "other" : "term-saved", agent: mode === "pi" ? "pi" : "shell" } };
        }
        if (method === "workspace.create") {
          assert.deepEqual(params, { cwd: s.cwd, label: basename(s.cwd), focus: false });
          return { type: "workspace_created", root_pane: { pane_id: "new", terminal_id: "term-new", workspace_id: "w-new", tab_id: "w-new:t1" } };
        }
        if (method === "pane.process_info") return { process_info: { shell_pid: 10, foreground_process_group_id: ["busy", "pi"].includes(mode) ? 20 : 10 } };
        assert.ok(["pane.report_metadata", "agent.start", "pane.close"].includes(method), `unexpected Herdr method: ${method}`);
        return { type: method === "agent.start" ? "agent_started" : "ok" };
      };
      if (mode === "busy") await assert.rejects(() => gw.startPaneSession(s.pi), /busy; no terminal input/);
      else assert.equal(await gw.startPaneSession(s.pi), true);
      assert.equal(requests.some((r) => r.method === "workspace.create"), ["new", "gone", "reused", "attached"].includes(mode));
      const start = requests.find((r) => r.method === "agent.start");
      assert.equal(Boolean(start), !["busy", "pi"].includes(mode));
      if (start) {
        assert.match(start.params.name, /^remote-[a-f0-9]{12}$/);
        assert.deepEqual(start.params, { name: start.params.name, kind: "pi", pane_id: s.binding.paneId, args: file ? ["--session", file] : [], timeout_ms: 45_000 });
        assert.deepEqual(requests.at(-2), { method: "pane.report_metadata", params: { pane_id: s.binding.paneId, source: "remote-pi", tokens: { remote_pi: "on" } } });
      }
      if (mode === "saved") {
        requests.length = 0;
        await gw.closePaneSession(s);
        assert.deepEqual(requests, ["pane.get", "pane.process_info", "pane.close"].map((method) => ({ method, params: { pane_id: "saved" } })));
      }
    }
    assert.equal(paneHasForegroundShell({ shell_pid: 0, foreground_process_group_id: 0 }), false);

    activeTest = "HTML format checks (markdown-it renderer)";
    // ref: https://nodejs.org/api/assert.html — share the equality assertion across rendering fixtures.
    for (const [input, expected] of [
      ["### Status!\n- **ready** and `a_b`", "<b>Status!</b>\n\n• <b>ready</b> and <code>a_b</code>"],
      ["```js\na_b();\n```", '<pre><code class="language-js">a_b();</code></pre>'],
      ["| A | B |\n|---|---|\n| 1 | 2 |", "<b>A · B</b>\n• 1 — 2"],
      [expandableBlockquote("line 1\nline 2"), "<blockquote expandable>line 1\nline 2</blockquote>"],
      ["> quote 1\n> quote 2", "<blockquote>quote 1\nquote 2</blockquote>"],
      ["✨ fresh.\n\n◆ Model: m", "✨ fresh.\n◆ Model: m"],
      ["**`code`**", "<b><code>code</code></b>"],
      ["- a\n  - nested\n\n1. first\n2. second", "• a\n  • nested\n\n1. first\n2. second"],
      ["nested **bold _inner_ end**", "nested <b>bold <i>inner</i> end</b>"],
      ["A & B < C > D", "A &amp; B &lt; C &gt; D"],
      ["[link](https://example.com) and https://t.me", '<a href="https://example.com">link</a> and <a href="https://t.me">https://t.me</a>'],
    ]) assert.equal(telegramHtml(input), expected);

    assert.ok(formatAssistantError("Codex error: The usage limit has been reached").includes("quota is exhausted"));
    assert.ok(formatAssistantError("Rate limit exceeded").includes("rate limit"));
    assert.equal(formatAssistantError("Network failure"), "❌ Network failure");

    const original = "a".repeat(8000) + "🎉";
    assert.equal(chunks(original).join(""), original);
    assert.ok(chunks(original).every((part) => [...part].length <= MAX_MESSAGE));
    const fenced = "```js\n" + "const a = 1;\n".repeat(10) + "```";
    const fencedChunks = chunks(fenced, 60);
    assert.ok(fencedChunks[0].endsWith("```"));
    assert.ok(fencedChunks[1].startsWith("```js\n"));

    for (const type of ["message_start", "message_update", "tool_execution_start", "message_end"]) {
      const { s, calls } = await fresh();
      const message = { role: "assistant", content: [{ type: "text", text: "reconnected reply" }], stopReason: "stop" };
      await s.handleEvent({ type, message, toolName: "bash", assistantMessageEvent: { type: "text_delta", delta: "live" } });
      assert.deepEqual([s.isStreaming, s.run.trigger], [true, null]);
      if (type !== "message_end") await s.handleEvent({ type: "message_end", message });
      assert.equal(calls.find((c) => c.method === "sendMessage").body.disable_notification, false);
      await s.handleEvent({ type: "agent_settled" });
      assert.deepEqual([s.run, s.isStreaming], [null, false]);
    }
    {
      const { gw, s, calls } = await fresh();
      for (const type of ["message_start", "message_end"]) await s.handleEvent({ type, message: { role: "custom", content: "x" } });
      assert.deepEqual([s.run, s.isStreaming], [null, false], "non-assistant messages never start a run");
      s.binding.sessionFile = "/s.jsonl";
      await s.handleEvent({ type: "agent_start" });
      const timer = s.run.timer;
      await gw.onPaneHello({ socket: { destroyed: false, writable: true }, clients: new Set(),
        hello: { paneId: "p1", cwd: s.cwd, sessionFile: "/s.jsonl", state: { isStreaming: false } } });
      assert.deepEqual([timer._destroyed, s.run, s.isStreaming], [true, null, false], "idle reconnect clears a stale run");
    }
    activeTest = "Run lifecycle, temporary drafts, notifications, Retry, and internal provider recovery.";
    {
      const { gw, s, calls } = await fresh();
      s.pi.request = async () => ({});
      const of = (method) => calls.filter((c) => c.method === method);
      const reactions = () => of("setMessageReaction").map((c) => c.body.reaction[0]?.emoji);
      const start = async () => {
        s.lastDraftAt = -Infinity;
        await gw.handleMessage(message("hello"));
        await s.handleEvent({ type: "agent_start" });
        await s.run.pending;
      };
      const end = (text, stopReason = "stop", errorMessage) => s.handleEvent({
        type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], stopReason, errorMessage },
      });
      try {
        await start();
        assert.deepEqual(reactions(), ["👀", "👨‍💻"]);
        assert.deepEqual([of("sendMessageDraft")[0].body.text, of("sendMessageDraft")[0].body.can_stop], ["", true]);
        const t0 = s.lastDraftAt;
        await s.handleEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "live" } });
        await s.tickRun(t0 + 1499);
        assert.equal(of("sendMessageDraft").length, 1);
        await s.tickRun(t0 + 1500);
        assert.equal(of("sendMessageDraft").at(-1).body.text, "live");
        await s.tickRun(t0 + 21_499);
        assert.equal(of("sendMessageDraft").length, 2);
        await s.tickRun(t0 + 21_500);
        assert.equal(of("sendMessageDraft").length, 3);
        await s.handleEvent({ type: "tool_execution_start", toolName: "bash", args: { command: "echo ok" } });
        await s.tickRun(t0 + 23_000);
        assert.ok(of("sendMessageDraft").at(-1).body.text.includes("⚙️ bash"));
        await s.handleEvent({ type: "tool_execution_end", toolName: "bash" });
        await end("tool explanation", "toolUse");
        assert.equal(of("sendMessage").at(-1).body.disable_notification, true);
        await end("final");
        assert.equal(of("sendMessage").at(-1).body.disable_notification, false);
        const count = of("sendMessageDraft").length;
        await s.tickRun(t0 + 25_000);
        await s.tickRun(t0 + 60_000);
        assert.equal(of("sendMessageDraft").length, count, "no trailing empty Thinking draft");
        await s.handleEvent({ type: "agent_settled" });
        assert.deepEqual(reactions(), ["👀", "👨‍💻", "👌"]);
        calls.length = 0;
        await start();
        await end("x".repeat(5000), "error", "Network failure");
        const replies = of("sendMessage");
        assert.equal(replies.length, 2);
        assert.equal(replies[0].body.reply_markup, undefined);
        const buttons = replies.at(-1).body.reply_markup.inline_keyboard.flat();
        assert.deepEqual(buttons.map((b) => b.text), ["🔁 Retry"]);
        await s.handleEvent({ type: "agent_settled" });
        assert.equal(reactions().at(-1), "💔");
        let retried;
        s.pi.request = async (_type, fields) => {
          retried = fields;
          return {};
        };
        await gw.handleCallback({ id: "retry", data: buttons[0].callback_data });
        assert.equal(retried.message, "hello");
        calls.length = 0;
        await start();
        await end("", "error", "temporary failure");
        await end("internal retry succeeded");
        await s.handleEvent({ type: "agent_settled" });
        assert.equal(reactions().at(-1), "👌");
        for (const abort of [false, true]) {
          await start();
          if (abort) await s.handleCommand({ name: "abort", argument: "" });
          await s.handleEvent({ type: "agent_settled" });
          assert.equal(reactions().at(-1), abort ? undefined : "🤷");
        }
        await start();
        await gw.dispatchUpdate({ stopped_message_generation: { chat: { id: 1, type: "private" }, draft_id: 1 } });
        assert.deepEqual([s.run, s.isStreaming], [null, false]);
        assert.ok(of("sendMessage").at(-1).body.text.includes("Stopped"));
        await s.handleEvent({ type: "agent_settled" });
        calls.length = 0;
        await s.handleEvent({ type: "remote_user_input", text: "terminal" });
        await s.handleEvent({ type: "agent_start" });
        await end("terminal final");
        await s.handleEvent({ type: "agent_settled" });
        assert.deepEqual(reactions(), []);
        assert.equal(of("sendMessage").at(-1).body.disable_notification, true);
        gw.config.presenceFile = join(dir, "presence");
        assert.equal(gw.isUserPresent(), false);
        await writeFile(gw.config.presenceFile, "here");
        await start();
        await end("desk final");
        assert.equal(of("sendMessage").at(-1).body.disable_notification, true);
        for (const present of [true, false]) {
          gw.isUserPresent = () => present;
          await s.handleUiRequest({ method: "select", id: `q-${present}`, title: "Choose", options: ["A", "B"] });
          assert.equal(of("sendMessage").at(-1).body.disable_notification, present);
        }
      } finally { s.stop(); }
    }
    activeTest = "Preview failure is one-shot, per-topic pacing is independent, and uploads do not block events.";
    {
      const { gw, s, calls } = await fresh(), other = new ChatSession(gw, { threadId: 22, cwd: dir });
      try {
        await Promise.all([s, other].map((v) => v.handleEvent({ type: "agent_start" })));
        await Promise.all([s.run.pending, other.run.pending]);
        assert.equal(calls.length, 2);
        assert.equal(calls[1].body.message_thread_id, 22);
        gw.telegram.call = async () => { throw new Error("draft unavailable"); };
        s.run.text = "fail";
        await s.tickRun(s.lastDraftAt + 1500);
        assert.equal(s.run.disabled, true);
        gw.telegram.call = async () => assert.fail("disabled drafts never retry or fall back to edits");
        await s.tickRun(s.lastDraftAt + 30_000);
        const gate = Promise.withResolvers(), order = [];
        gw.telegram.sendDocument = async (_chat, path) => {
          order.push(path);
          if (path === "a") await gate.promise;
        };
        const attach = (paths) => ({ type: "tool_execution_end", toolName: "remote_attach", result: { details: { paths } } });
        await s.handleEvent(attach(["a", "b"]));
        await other.handleEvent(attach(["c"]));
        await other.uploadChain;
        assert.deepEqual(order, ["a", "c"]);
        gate.resolve();
        await s.uploadChain;
        assert.deepEqual(order, ["a", "c", "b"]);
      } finally {
        s.stop();
        other.stop();
      }
    }

    activeTest = "Herdr push: bound panes, remote_ask suppression, stale callbacks, reconciliation, rebinding and reconnect";
    {
      const { gw, s, calls } = await fresh(), sockets = [], writes = [], requests = [];
      let status = "blocked", lists = 0;
      gw.herdrSocketPath = "/fake/socket";
      gw.herdr = async (method, params) => {
        requests.push({ method, params });
        if (method === "agent.list") {
          lists++;
          return { agents: [{ pane_id: "bound", agent_status: "working" }] };
        }
        return method === "agent.get" ? { agent: { agent_status: status } } : { read: { text: "screen" } };
      };
      gw.syncBlockedSubscription();
      assert.equal(gw.herdrSubSocket, null, "no real subscription in self-test");
      const connect = () => {
        const socket = new Duplex({ read() {}, write(chunk, _encoding, done) {
          writes.push(JSON.parse(String(chunk)));
          done();
        } });
        sockets.push(socket);
        return socket;
      };
      const sync = gw.syncBlockedSubscription.bind(gw);
      gw.syncBlockedSubscription = () => sync(connect);
      const emit = (socket, record) => socket.emit("data", `${JSON.stringify(record)}\n`);
      const push = async (pane_id, agent_status) => {
        emit(sockets.at(-1), { event: "pane.agent_status_changed", data: { pane_id, agent_status } });
        await sleep(0);
      };
      const alerts = () => calls.filter((c) => c.method === "sendMessage");
      const callback = (button) => ({ id: "cb", data: button.callback_data, message: { chat: { id: 1 }, message_id: 8 } });
      s.binding.paneId = "bound";
      gw.syncBlockedSubscription();
      assert.equal(sockets.length, 0, "disconnected bindings are not subscribed");
      s.pi.proc = {};
      s.pi.connection = { clients: new Set(), hello: { paneId: "bound" } };
      try {
        gw.syncBlockedSubscription();
        const first = sockets[0];
        first.emit("connect");
        assert.deepEqual(writes[0].params.subscriptions, [{ type: "pane.agent_status_changed", pane_id: "bound" }]);
        emit(first, { id: writes[0].id, result: { type: "subscription_started" } });
        await until(() => gw.blockedStatuses.get("bound") === "working");
        await push("bound", "blocked");
        assert.equal(alerts().length, 0, "idle views do not alert");
        s.isStreaming = true;
        s.uiMessages = new Map([["q", 1]]);
        await push("bound", "working");
        await push("bound", "blocked");
        assert.equal(alerts().length, 0, "remote_ask suppresses blocked alerts");
        s.uiMessages.clear();
        await push("bound", "working");
        await push("bound", "blocked");
        await push("unbound", "blocked");
        await push("bound", "blocked");
        assert.equal(alerts().length, 1, "only a bound transition alerts, once");
        assert.equal(alerts()[0].body.disable_notification, false);
        assert.ok(!requests.some((r) => r.params?.target === "unbound"));
        status = "idle";
        await gw.handleCallback(callback(alerts()[0].body.reply_markup.inline_keyboard[0][0]));
        assert.ok(!requests.some((r) => r.method === "agent.send_keys"));
        gw.isUserPresent = () => true;
        await push("bound", "working");
        status = "blocked";
        await push("bound", "blocked");
        assert.equal(alerts().at(-1).body.disable_notification, true);
        await gw.handleCallback(callback(alerts().at(-1).body.reply_markup.inline_keyboard[1][0]));
        assert.ok(requests.some((r) => r.method === "agent.send_keys" && r.params?.target === "bound" && r.params?.keys?.[0] === "esc"));
        assert.equal(calls.at(-1).method, "editMessageReplyMarkup");
        first.destroy();
        await until(() => sockets.length === 2);
        sockets[1].emit("connect");
        emit(sockets[1], { id: writes[1].id, result: { type: "subscription_started" } });
        await until(() => lists === 2);
        gw.syncBlockedSubscription();
        assert.equal(sockets.length, 2, "unchanged bindings reuse the subscription");
        s.binding.paneId = "other";
        gw.syncBlockedSubscription();
        assert.deepEqual([sockets[1].destroyed, sockets.length], [true, 3]);
        s.stop();
        assert.deepEqual([gw.herdrSubSocket, sockets[2].destroyed], [null, true]);
      } finally { gw.stop(); }
      await sleep(300);
      assert.equal(sockets.length, 3, "shutdown cancels reconnection");
    }
    activeTest = "Native command aliases, ambiguity, reserved names, and topic-local discovery.";
    {
      const { gw, s, calls } = await fresh(), prompts = [], sent = [];
      let commands = [
        { name: "status", source: "prompt" }, { name: "foo-bar", source: "extension" }, { name: "foo_bar", source: "prompt" },
        { name: "skill:check-a", source: "skill" }, { name: "skill_check_a", source: "extension" }, { name: "git-review", source: "extension" },
        ...["one", "two"].map((suffix) => ({ name: "a".repeat(32) + suffix, source: "prompt" })),
      ];
      s.pi.proc = {};
      s.pi.request = async () => ({ commands });
      s.send = async (text) => { sent.push(text); };
      s.prompt = async (text) => { prompts.push(text); };
      await gw.registerBotCommands();
      assert.deepEqual(calls.filter((c) => c.method === "setMyCommands").map((c) => c.body.scope), [{ type: "all_private_chats" }]);
      const menu = calls.at(-1).body.commands;
      for (const name of ["foo_bar", "skill_check_a", "a".repeat(32)]) {
        assert.ok(!menu.some((c) => c.command === name));
        await s.handleCommand(parseCommand(`/${name}`));
        assert.match(sent.at(-1), /Ambiguous command/);
      }
      assert.deepEqual(prompts, []);
      assert.equal(menu.find((c) => c.command === "status").description, BOT_COMMANDS.find((c) => c.command === "status").description);
      assert.equal(telegramCommandName({ name: "skill:check-a", source: "skill" }), "skill_check_a");
      for (const [text, target] of [["/foo-bar arg", "/foo-bar arg"], ["/skill-check-a", "/skill:check-a"], ["/git_review@bot Keep CASE", "/git-review Keep CASE"]]) {
        await s.handleCommand(parseCommand(text));
        assert.equal(prompts.at(-1), target);
      }
      const other = new ChatSession(gw, { threadId: 9, cwd: dir });
      other.pi.request = async () => ({ commands: [{ name: "git_review", source: "prompt" }] });
      other.prompt = s.prompt;
      other.send = s.send;
      await other.handleCommand(parseCommand("/git_review"));
      assert.equal(prompts.at(-1), "/git_review");
      commands = [];
      const count = prompts.length;
      await s.handleCommand(parseCommand("/git_review"));
      assert.match(sent.at(-1), /Unknown command/);
      assert.equal(prompts.length, count);
      s.pi.proc = null;
      s.pi.request = async () => assert.fail("help must not start Pi");
      await s.handleCommand(parseCommand("/start"));
      assert.equal(sent.at(-1), HELP);
    }

    activeTest = "At-least-once offsets: dispatch first, persist only after completion; /restart flushes its own offset.";
    {
      const { gw } = await fresh(), tg = gw.telegram, gate = Promise.withResolvers();
      let polls = 0;
      await pollFake(tg, async (_method, body) => {
        assert.equal(body.timeout, 25);
        assert.deepEqual(body.allowed_updates, ["message", "callback_query", "stopped_message_generation"]);
        if (!polls++) return [{ update_id: 7 }];
        tg.stopPolling();
        return [];
      }, () => gate.promise);
      assert.equal(existsSync(tg.offsetPath), false);
      gate.resolve();
      await until(() => existsSync(tg.offsetPath));
      assert.equal(await readFile(tg.offsetPath, "utf8"), "8");
      const { gw: restart } = await fresh(), exitBefore = process.exit;
      const earlier = Promise.withResolvers(), late = earlier.promise.then(() => restart.telegram.saveOffset(8));
      let stopped = false;
      restart.stop = () => { stopped = true; };
      restart.mainSession.updateChain = new Promise(() => {});
      process.exit = () => {};
      try {
        const result = restart.dispatchUpdate({ update_id: 888, message: message("/restart") });
        await until(() => stopped);
        await result;
        earlier.resolve();
        await late;
        assert.equal(await readFile(restart.telegram.offsetPath, "utf8"), "889");
        await Promise.all([restart.telegram.saveOffset(890), restart.telegram.saveOffset(891), restart.telegram.saveOffset(889)]);
        assert.equal(await readFile(restart.telegram.offsetPath, "utf8"), "891");
        await sleep(150);
      } finally { process.exit = exitBefore; }
      const ready = new Gateway(restart.config), edits = [];
      ready.telegram.edit = async (...args) => { edits.push(args); };
      await ready.completeRestart();
      assert.equal(edits[0][2], "✅ Gateway restarted");
      assert.equal(loadState(ready.config.stateDir).pendingRestartMessageId, null);
      await ready.completeRestart();
      assert.equal(edits.length, 1);
    }

    activeTest = "Retry policy distinguishes connection failures from ambiguous writes, and honors retry_after.";
    {
      for (const method of ["sendMessage", "sendDocument", "sendPhoto", "sendMediaGroup", "copyMessage", "forwardMessage", "editMessageText", "getUpdates"]) {
        const safe = ["editMessageText", "getUpdates"].includes(method);
        assert.equal(shouldRetryTelegram(method, { status: 429 }), true);
        assert.equal(shouldRetryTelegram(method, { status: 500 }), safe);
        assert.equal(shouldRetryTelegram(method, { status: 400 }), false);
        assert.equal(shouldRetryTelegram(method, { error: { cause: { code: "ECONNRESET" } } }), safe);
        for (const code of ["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT"]) {
          assert.equal(shouldRetryTelegram(method, { error: { code } }), true);
        }
      }
      const guardedFetch = globalThis.fetch, tg = new Telegram("1:x", "unused");
      try {
        let attempts = 0;
        globalThis.fetch = async () => {
          attempts++;
          return { ok: false, status: 500, json: async () => ({ ok: false, description: "failure" }) };
        };
        await assert.rejects(() => tg.call("sendMessage", {}, 1000, 3, null, true), /failure/);
        assert.equal(attempts, 1);
        attempts = 0;
        const started = Date.now();
        globalThis.fetch = async () => ++attempts === 1
          ? { ok: false, status: 429, json: async () => ({ ok: false, parameters: { retry_after: 0.05 } }) }
          : { ok: true, json: async () => ({ ok: true, result: true }) };
        assert.equal(await tg.call("sendMessage", {}, 1000, 2, null, true), true);
        assert.equal(attempts, 2);
        assert.ok(Date.now() - started >= 45 && Date.now() - started < 900, "use retry_after, not the default 1s delay");
      } finally { globalThis.fetch = guardedFetch; }
      assert.deepEqual([pollBackoffMs(1, () => 0), pollBackoffMs(2, () => 1), pollBackoffMs(10, () => 1)], [500, 2000, 60_000]);
    }

    activeTest = "Conflict waits are abortable, distinct from network-outage backoff.";
    {
      const tg = new Telegram("1:x", join(dir, "conflict-offset"));
      let attempts = 0;
      await pollFake(tg, async () => {
        attempts++;
        setTimeout(() => tg.stopPolling(), 20);
        throw new Error("Conflict: another poller");
      }, () => assert.fail("no update on conflict"));
      assert.deepEqual([attempts, tg.inConflict, tg.pollFailures], [1, true, 0]);
      await assert.rejects(() => pollFake(tg, () => assert.fail("fake failed"), () => {}), /fake failed/);
      await assert.rejects(() => pollFake(tg, () => [{ update_id: 1 }], () => assert.fail("handler failed")), /handler failed/);
    }
    activeTest = "Shared HTML fallback preserves threads, notifications, and final-only buttons.";
    {
      const { gw, calls } = await fresh(), tg = gw.telegram;
      tg.call = async (method, body) => {
        calls.push({ method, body });
        if (body.parse_mode) throw new Error("can't parse entities");
        return { message_id: 1 };
      };
      await tg.sendOne(1, "x".repeat(5000), { message_thread_id: 9, disable_notification: true, reply_markup: { inline_keyboard: [] } });
      assert.deepEqual(calls.map((c) => c.body.reply_markup), [{ inline_keyboard: [] }, undefined, { inline_keyboard: [] }]);
      assert.ok(calls.every((c) => c.body.message_thread_id === 9 && c.body.disable_notification));
      await tg.edit(1, 2, "x".repeat(5000));
      assert.equal(calls.at(-1).body.text.length, 4000);
      tg.call = async () => { throw new Error("message is not modified"); };
      await tg.edit(1, 2, "unchanged");
    }
    activeTest = "RPC startup coalesces, failed writes clean pending requests, and resume refuses a second writer.";
    {
      const { gw, s, calls } = await fresh();
      s.pi.request = async (type) => { throw new Error(`Pi bridge ${type} timed out; not retried`); };
      await s.handleCommand(parseCommand("/new"));
      assert.match(calls.at(-1).body.text, /❌ Pi bridge new_session timed out/);
      await gw.handleCallback(null, s, { type: "resume", path: "/timeout.jsonl" });
      assert.match(calls.at(-1).body.text, /❌ Pi bridge switch_session timed out/);
    }
    {
      const { gw, s, calls } = await fresh();
      let starts = 0;
      gw.ensurePaneSession = async () => {
        starts++;
        await sleep(10);
        s.pi.proc = { destroyed: false };
      };
      await Promise.all([s.pi.ensureStarted(), s.pi.ensureStarted()]);
      assert.equal(starts, 1);
      s.pi.write = () => { throw new Error("socket broke"); };
      await assert.rejects(() => s.pi.request("test", {}, 100), /socket broke/);
      assert.equal(s.pi.pending.size, 0);
      gw.liveSessionPane = async () => "another-pane";
      s.pi.request = async () => assert.fail("resume must not replace an already open session");
      await gw.handleCallback(null, s, { type: "resume", path: "/busy.jsonl" });
      assert.match(calls.at(-1).body.text, /already open/);
      s.binding.sessionFile = join(dir, "old.jsonl");
      await gw.persistPaneSession(s);
      s.pi.proc = null;
      const requests = [];
      s.pi.request = async (type) => {
        requests.push(type);
        return {};
      };
      await s.handleCommand(parseCommand("/new"));
      assert.deepEqual(requests, ["new_session", "get_state"], "offline /new must replace the persisted session");
    }
    activeTest = "Config validation preserves accepted inputs and its user-facing diagnostics.";
    {
      const configPath = join(dir, "config.json"), previous = process.env.REMOTE_PI_CONFIG;
      const config = { cwd: dir, stateDir: join(dir, "config-state"), telegram: { botToken: "123:abc", allowedUserId: 1 } };
      process.env.REMOTE_PI_CONFIG = configPath;
      try {
        await writeFile(configPath, JSON.stringify(config));
        assert.equal(loadConfig().allowedUserId, "1");
        for (const [patch, error] of [
          [{ telegram: { ...config.telegram, botToken: "bad" } }, /Invalid telegram.botToken/],
          [{ telegram: { ...config.telegram, allowedUserId: "bad" } }, /Invalid telegram.allowedUserId/],
          [{ cwd: configPath }, /Pi working directory does not exist or is not a directory/],
          [{ cwd: null }, /"cwd" is required/],
        ]) {
          await writeFile(configPath, JSON.stringify({ ...config, ...patch }));
          assert.throws(() => loadConfig(), error);
        }
        await mkdir(config.stateDir);
        const statePath = join(config.stateDir, "state.json");
        await writeFile(statePath, JSON.stringify({ herdrPanes: "malformed", topics: { 1: { cwd: dir }, 2: { cwd: "/missing" } } }));
        assert.deepEqual(loadState(config.stateDir).herdrPanes, {});
        assert.deepEqual(loadState(config.stateDir).topics, { 1: { cwd: dir } });
        await writeFile(statePath, JSON.stringify({ herdrPanes: { main: "legacy-pane", "t:1": { cwd: dir, paneId: "pane", owned: true } } }));
        assert.deepEqual(loadState(config.stateDir).herdrPanes, { "t:1": { cwd: dir, paneId: "pane", owned: true } });
      } finally {
        if (previous === undefined) delete process.env.REMOTE_PI_CONFIG;
        else process.env.REMOTE_PI_CONFIG = previous;
      }
    }

    activeTest = "Installer link safety only: never execute its service entry point.";
    {
      const installer = await readFile(join(root, "install.sh"), "utf8");
      const definition = installer.match(/^install_command\(\) \{[\s\S]*?^\}/m)?.[0];
      const extensionDir = join(dir, "extensions"), extension = join(extensionDir, "remote-pi.ts"), checkout = join(dir, "checkout with spaces");
      await mkdir(extensionDir);
      await mkdir(checkout);
      await writeFile(join(checkout, "remote-pi.ts"), "// extension\n");
      const installLink = () => spawnSync("bash", ["-c", `set -euo pipefail\n${definition}\ninstall_command`], {
        env: { ...process.env, ROOT: checkout, COMMAND: join(dir, "bin", "pi-remote-gateway"), PI_EXTENSION_DIR: extensionDir, PI_EXTENSION: extension },
      });
      await symlink(join(checkout, "retired.ts"), extension);
      for (let i = 0; i < 2; i++) {
        assert.equal(installLink().status, 0);
        assert.equal(await readlink(extension), join(checkout, "remote-pi.ts"));
      }
      await unlink(extension);
      await writeFile(extension, "user-owned\n");
      assert.equal(installLink().status, 1);
      assert.equal(await readFile(extension, "utf8"), "user-owned\n");
      assert.equal(spawnSync("bash", ["-n", join(root, "install.sh")]).status, 0);
    }
    activeTest = "line budget";
    let total = 0;
    for (const file of ["gateway.mjs", "remote-pi.ts", "install.sh"]) total += (await readFile(join(root, file), "utf8")).split("\n").length - 1;
    // Soft budget: AGENTS.md allows justified overruns, so warn instead of failing.
    if (total > LINE_BUDGET) console.warn(`self-test: core is ${total} lines, over the ${LINE_BUDGET}-line budget`);
    console.log("self-test: ok");
  } finally {
    globalThis.fetch = fetchBefore;
    net.connect = connectBefore;
    net.createConnection = createBefore;
    setTestMode(false);
    activeTest = "cleanup";
    await rm(dir, { recursive: true, force: true });
    activeTest = "waiting for process exit after cleanup";
    watchdog.unref();
  }
}
export { selfTest, selfTestPaneBridge };
if (import.meta.main) await selfTest();
