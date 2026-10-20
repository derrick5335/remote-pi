import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readlink, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import remoteExtension, { createRemoteBridge } from "./remote-pi.ts";
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
  const dir = join(tmpdir(), `rp-${randomBytes(4).toString("hex")}`);
  await mkdir(dir, { mode: 0o700 });
  const path = join(dir, "bridge.sock");
  const config = { allowedUserId: "1", botToken: "1:x", stateDir: dir, cwd: dir };
  let gateway = new Gateway(config);
  const outputs = [];
  const events = [];
  let messageId = 0;
  const mockGateway = (gw) => {
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
  const env = { HERDR_ENV: "1", HERDR_SOCKET_PATH: "/fake-herdr", HERDR_PANE_ID: "w1:p-test", REMOTE_PI_ATTACH: "1", REMOTE_PI_BRIDGE_SOCKET: path };
  const tokens = {};
  const prompts = [];
  const selections = [];
  let current;
  let runtimeCount = 0;
  let aborted = 0;
  let quit = 0;
  let slowExec;
  let cancelledReplacement = false;
  let otherAgents = [];
  const metadataCalls = [];
  const metadata = async (_env, method, params) => {
    if (method === "pane.get") return { pane: { tokens, terminal_id: "term-test" } };
    if (method === "pane.report_metadata") {
      metadataCalls.push(params);
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
      { type: "usage", usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 0.1 } } },
    ];
    const model = { provider: "fake", id: "m", reasoning: true, thinkingLevelMap: { minimal: null, xhigh: "xhigh", max: null } };
    const ctx = {
      cwd: dir, model, mode: "tui", hasUI: true, isIdle: () => idle, hasPendingMessages: () => false,
      sessionManager: {
        getSessionFile: () => { check(); return file; }, getSessionId: () => file,
        getEntries: () => entries, getBranch: () => entries, getSessionDir: () => join(dir, "native"),
      },
      modelRegistry: { getAvailable: () => [model], find: (provider, id) => provider === "fake" && id === "m" ? model : undefined },
      getContextUsage: () => ({ tokens: 50, contextWindow: 100, percent: 50 }),
      abort: () => { aborted++; }, shutdown: () => { quit++; },
      compact: ({ onComplete }) => onComplete({ tokensBefore: 100, estimatedTokensAfter: 20 }),
      ui: {
        setStatus: (key, text) => { statusCalls.push({ key, text }); },
        notify: (msg, type) => { notifyCalls.push({ msg, type }); },
        select: (_title, _options, { signal }) => new Promise((done) => {
          const selection = { done, cancelled: false };
          selections.push(selection);
          signal.addEventListener("abort", () => {
            selection.cancelled = true;
            done(undefined);
          }, { once: true });
          if (signal.aborted) {
            selection.cancelled = true;
            done(undefined);
          }
        }),
      },
    };
    const emit = async (type, fields = {}) => {
      let result;
      for (const handler of handlers.get(type) || []) result = await handler({ type, ...fields }, ctx);
      return result;
    };
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
      on: (type, handler) => { if (!handlers.has(type)) handlers.set(type, []); handlers.get(type).push(handler); },
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
      setModel: async () => true,
      exec: async (cmd, args, options) => {
        assert.equal(cmd, "bash"); assert.deepEqual(options, { cwd: dir });
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
    const bridge = createRemoteBridge(pi, { env, metadata, listSessions: async (cwd, sessionDir) => {
      assert.equal(cwd, dir);
      assert.equal(sessionDir, join(dir, "native"));
      return Array.from({ length: 15 }, (_, i) => ({
        path: join(dir, `s-${i}.jsonl`), modified: new Date(i),
        name: i === 14 ? "Named session" : "", firstMessage: i === 13 ? "a".repeat(80) + "\nsecond line" : "",
      }));
    } });
    return { pi, ctx, tools, commands, bridge, emit, statusCalls, notifyCalls, setIdle: (value) => { idle = value; } };
  };
  try {
    await gateway.bridge.start();
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    current = runtime(initialFile);
    await current.emit("session_start", { reason: "startup" });
    await until(() => gateway.mainSession.pi.proc);
    await until(() => current.statusCalls.at(-1)?.text === "📱 remote");
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
    assert.equal(conn.hello.terminalId, "term-test");
    assert.equal(conn.hello.sessionName, "test");
    assert.deepEqual(conn.hello.recent, { firstUserText: "hello", lastUserText: "hello", lastAssistantText: "answer" });
    const session = gateway.mainSession;
    assert.ok(session.pi instanceof PaneRpc, "all ChatSessions use PaneRpc");
    assert.deepEqual(current.pi.getActiveTools(), ["read", "bash", "remote_attach", "remote_ask"]);
    const { sessions } = await session.pi.request("list_sessions");
    assert.equal(sessions.length, 12);
    assert.equal(sessions[0].title, "Named session");
    assert.equal(sessions[1].title, "a".repeat(60));
    assert.equal(sessions[2].title, "s-12.jsonl");
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
    assert.ok(!outputs.some((text) => text === "🖥 idle" || text === "🖥 queued"));
    await current.emit("agent_start");
    await until(() => session.isStreaming);
    await current.emit("agent_end", { messages: [] });
    await session.eventChain;
    assert.equal(session.isStreaming, true, "agent_end is not the final boundary");
    await current.emit("agent_settled");
    await until(() => !session.isStreaming);
    assert.ok(events.some((e) => e.type === "agent_settled"));
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
      assert.equal((await result).details.answer, side === "telegram" ? "A" : "B");
      assert.equal(selections.at(-1).cancelled, true, "losing TUI dialog is aborted");
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
    assert.equal(runtimeCount, 2);
    assert.equal((await session.pi.request("get_state")).sessionFile, join(dir, "s2.jsonl"));
    assert.equal(session.binding.sessionFile, join(dir, "s2.jsonl"));
    const view = new ChatSession(gateway, { threadId: 321, cwd: dir });
    view.binding = { cwd: dir, sessionFile: session.binding.sessionFile };
    gateway.sessions.set(view.key, view);
    await Promise.all([view.pi.ensureStarted(), session.pi.ensureStarted()]);
    assert.equal(view.pi.proc, session.pi.proc, "served session binds the existing process, never starts Pi");
    assert.equal(runtimeCount, 2);
    view.stop();
    session.pi.stop();
    await gateway.bridge.stop();
    await until(() => !current.pi.getActiveTools().includes("remote_ask"));
    gateway = new Gateway(config);
    mockGateway(gateway);
    assert.equal(gateway.mainSession.binding.sessionFile, join(dir, "s2.jsonl"), "binding persists across gateway restart");
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
    await until(() => gateway.mainSession.pi.proc);
    await until(() => current.statusCalls.at(-1)?.text === "📱 remote");
    const askPending = current.tools.get("remote_ask").execute("ask", { question: "Drop?", options: ["A", "B"] }, undefined, undefined, current.ctx);
    await until(() => selections.length === 3);
    const dropRequest = events.filter((e) => e.type === "extension_ui_request").at(-1);
    assert.ok(dropRequest);
    const reqCount = events.filter((e) => e.type === "extension_ui_request" && e.id === dropRequest.id).length;

    // Assert connected -> reconnecting -> connected transition on socket drop
    const connBeforeDrop = [...gateway.bridge.connections.values()][0];
    connBeforeDrop?.socket?.destroy();
    await until(() => current.statusCalls.some((c) => c.text === "📱 reconnecting…"));
    await until(() => current.statusCalls.at(-1)?.text === "📱 remote");
    assert.equal(selections.at(-1).cancelled, false, "close keeps dialog pending");
    await until(() => events.filter((e) => e.type === "extension_ui_request" && e.id === dropRequest.id).length > reqCount);
    await current.commands.get("remote-control").handler("off", current.ctx);
    assert.equal(selections.at(-1).cancelled, true, "explicit off cancels pending dialog");
    assert.equal((await askPending).details.answer, null);
    await current.commands.get("remote-control").handler("on", current.ctx);
    await until(() => gateway.mainSession.pi.proc);
    await until(() => current.statusCalls.at(-1)?.text === "📱 remote");
    // /remote-control status consistent with footer
    await current.commands.get("remote-control").handler("status", current.ctx);
    assert.ok(current.notifyCalls.some((c) => c.msg?.includes("connected (📱 remote)")));
    assert.equal(gateway.mainSession.pi.stopping, false);
    gateway.mainSession.pi.stop();
    await gateway.bridge.stop();
    assert.equal(quit, 0, "detaching a view or gateway never quits Pi");
  } finally {
    if (current) await current.emit("session_shutdown", { reason: "quit" });
    for (const session of gateway.sessions.values()) session.stop();
    await gateway.bridge.stop();
    await rm(dir, { recursive: true, force: true });
  }
}

async function selfTest() {
  setTestMode(true);
  const fetchBefore = globalThis.fetch, connectBefore = net.connect, createBefore = net.createConnection;
  const dir = await mkdtemp(join(tmpdir(), "rp-tests-"));
  globalThis.fetch = async (url) => { throw new Error(`Unexpected network call: ${url}`); };
  net.connect = net.createConnection = function (...args) {
    const path = typeof args[0] === "string" ? args[0] : args[0]?.path;
    if (!path?.startsWith(`${tmpdir()}/`) || [process.env.HERDR_SOCKET_PATH, process.env.REMOTE_PI_BRIDGE_SOCKET].includes(path)) {
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
    const limits = { "gateway.mjs": 1540, "remote-pi.ts": 380, "install.sh": 140, "self-test.mjs": 1000 };
    let total = 0;
    for (const [file, limit] of Object.entries(limits)) {
      const count = (await readFile(join(root, file), "utf8")).split("\n").length - 1;
      assert.ok(count <= limit, `${file}: ${count} > ${limit}`);
      if (file !== "self-test.mjs") total += count;
    }
    assert.ok(total <= LINE_BUDGET, `Line budget exceeded: ${total} > ${LINE_BUDGET}`);
    await selfTestPaneBridge();
    assert.doesNotThrow(() => remoteExtension({ on() {}, registerCommand() {}, registerTool() {} },
      new Proxy({}, { get() { throw new Error("factory options must not come from the loader"); } })));

    // Auth is checked before topic creation or callback lookup; topics route independently.
    {
      const { gw, calls } = await fresh();
      for (const extra of [{ from: { id: 2 } }, { chat: { type: "group" } }, { chat: { type: "supergroup" } }]) {
        const m = message("intruder", { message_thread_id: 99, ...extra });
        await gw.dispatchUpdate({ message: m });
        await gw.dispatchUpdate({ callback_query: { id: "cb", from: m.from, message: m, data: "a:bad" } });
      }
      assert.equal(gw.sessions.size, 1);
      assert.equal(calls.length, 0);
      assert.equal(sessionKeyOf(null), "main");
      assert.equal(sessionKeyOf(message("main")), "main");
      assert.equal(sessionKeyOf(message("topic", { message_thread_id: 99 })), "t:99");
      assert.equal(sessionKeyOf({ message: message("topic", { message_thread_id: 99 }) }), "t:99");
      assert.equal(sessionKeyOf(message("not topic", { message_thread_id: 99, is_topic_message: false })), "main");
      gw.handleUpdate = async () => {};
      await gw.dispatchUpdate({ message: message("topic", { message_thread_id: 99 }) });
      assert.ok(gw.sessions.get("t:99").pi instanceof PaneRpc);
      assert.deepEqual(gw.state.topics[99], { cwd: gw.mainSession.cwd });
      const order = [], gate = Promise.withResolvers();
      gw.handleUpdate = async (u) => {
        order.push(u.message.text);
        if (u.message.text === "slow") await gate.promise;
      };
      gw.mainSession.handleCommand = async ({ name }) => { order.push(name); };
      const first = gw.dispatchUpdate({ message: message("slow") });
      await until(() => order.length);
      const ordinary = BOT_COMMANDS.filter((c) => !["abort", "restart"].includes(c.command)).map((c) => `/${c.command}`);
      const queued = [gw.dispatchUpdate({ message: message("queued") }), ...ordinary.map((text) => gw.dispatchUpdate({ message: message(text) }))];
      await gw.dispatchUpdate({ message: message("other", { message_thread_id: 99 }) });
      await gw.dispatchUpdate({ message: message("/abort") });
      assert.deepEqual(order, ["slow", "other", "abort"]);
      gate.resolve();
      await Promise.all([first, ...queued]);
      assert.deepEqual(order.slice(3), ["queued", ...ordinary], "only abort and restart bypass the update chain");
    }

    // Register and enqueue new-topic updates in arrival order even while persistence is pending.
    {
      const { gw } = await fresh(), gate = Promise.withResolvers(), handled = [];
      gw.persistPaneSession = () => gate.promise;
      gw.handleUpdate = async (u) => { handled.push(u.message.text); };
      const first = gw.dispatchUpdate({ message: message("first", { message_thread_id: 77 }) });
      const second = gw.dispatchUpdate({ message: message("second", { message_thread_id: 77 }) });
      gate.resolve();
      await Promise.all([first, second]);
      assert.deepEqual(handled, ["first", "second"]);
    }

    for (const owned of [true, false]) {
      const { gw, calls } = await fresh();
      const s = await gw.createTopic({ threadId: 99, cwd: dir, name: "deleted", binding: { owned, paneId: "gone" } });
      const requests = [];
      s.pi.proc = {};
      s.pi.request = owned
        ? async (type) => { requests.push(type); throw new Error("refused to quit"); }
        : async (type) => requests.push(type);
      gw.telegram.send = async () => Promise.reject(new Error("Bad Request: message thread not found"));
      await s.send("final output");
      assert.deepEqual(requests, [owned ? "quit" : "remote_off"]);
      const state = loadState(gw.config.stateDir);
      assert.deepEqual([gw.sessions.has(s.key), state.topics[99], state.herdrPanes[s.key]], [false, undefined, undefined]);
      assert.ok(!calls.some((c) => c.method === "deleteForumTopic"));
    }
    {
      const { gw, calls } = await fresh();
      const s = await gw.createTopic({ threadId: 77, cwd: dir, name: "gone", binding: { owned: true, paneId: "gone", terminalId: "t1" } });
      s.pi.proc = {};
      s.pi.request = async () => {};
      s.pi.herdrEnv = { HERDR_BIN_PATH: "/fake/herdr" };
      await gw.closeTopic(77, { deleteTopic: true });
      const state = loadState(gw.config.stateDir);
      assert.deepEqual([gw.sessions.has("t:77"), state.topics[77], state.herdrPanes["t:77"]], [false, undefined, undefined]);
      assert.ok(calls.some((c) => c.method === "deleteForumTopic"), "pane already gone still closes the topic");
    }
    // Attach-only startup never spawns; even a live Pi without hello must only be attached.
    {
      const { gw, s } = await fresh();
      await gw.bridge.start();
      try {
        s.binding = { paneId: "gone", sessionFile: join(dir, "gone.jsonl"), owned: true };
        assert.equal(await gw.ensurePaneSession(s.pi, { spawn: false }), false);
        assert.equal(s.pi.proc, null);
        const c = { socket: { destroyed: false, writable: true }, clients: new Set(), hello: { paneId: "live", cwd: dir, sessionFile: s.binding.sessionFile } };
        gw.liveSessionPane = async () => "live";
        let waited = false;
        gw.bridge.waitFor = async (predicate) => {
          waited = predicate(c);
          return c;
        };
        const runCmd = async () => JSON.stringify({ result: { process_info: { shell_pid: 1, foreground_process_group_id: 2 } } });
        assert.equal(await gw.startPaneSession(s.pi, { spawn: false, runCmd }), true);
        assert.equal(waited, true);
        assert.equal(s.pi.proc, c.socket);
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
      s.pi.herdrEnv.HERDR_BIN_PATH = "/fake/herdr";
      await gw.closePaneSession(s, async (_bin, args) => {
        if (args[1] !== "get") throw new Error(`unexpected command: ${args.join(" ")}`);
        return `{"result":{"pane":{"terminal_id":"new"}}}`;
      });
      attached.stop();
    }
    // Foreground-shell safety and persisted-pane reuse, without any real Herdr command.
    for (const mode of ["new", "saved", "gone", "pi", "busy", "reused", "attached"]) {
      const { gw, s } = await fresh(), commands = [];
      gw.herdrEnvironment = { HERDR_BIN_PATH: "/fake/herdr", HERDR_SOCKET_PATH: "/fake/socket" };
      s.binding = { cwd: s.cwd, owned: mode !== "attached", terminalId: "term-saved", ...(mode !== "new" ? { paneId: "saved" } : {}) };
      gw.bridge.server = {};
      gw.bridge.start = async () => {};
      gw.bridge.waitFor = async () => ({});
      s.pi.bind = () => {};
      const runCmd = async (_bin, args) => {
        commands.push(args);
        if (args[1] === "get") {
          if (mode === "gone") throw new Error("missing");
          return JSON.stringify({ result: { pane: { pane_id: "saved", terminal_id: mode === "reused" ? "other" : "term-saved", agent: mode === "pi" ? "pi" : "shell" } } });
        }
        if (args[0] === "workspace") return JSON.stringify({ result: { root_pane: { pane_id: "new", terminal_id: "term-new" } } });
        return JSON.stringify({ result: { process_info: { shell_pid: 10, foreground_process_group_id: ["busy", "pi"].includes(mode) ? 20 : 10 } } });
      };
      if (mode === "busy") await assert.rejects(() => gw.startPaneSession(s.pi, { runCmd }), /busy; no terminal input/);
      else assert.equal(await gw.startPaneSession(s.pi, { runCmd }), true);
      assert.equal(commands.some((a) => a[0] === "workspace"), ["new", "gone", "reused", "attached"].includes(mode));
      assert.equal(commands.some((a) => a[0] === "agent"), !["busy", "pi"].includes(mode));
      assert.equal(commands.some((a) => a[1] === "run"), mode === "saved");
      assert.ok(!commands.some((a) => a[1] === "list"));
    }
    assert.equal(paneHasForegroundShell({ shell_pid: 1, foreground_process_group_id: 1 }), true);
    assert.equal(paneHasForegroundShell({ shell_pid: 0, foreground_process_group_id: 0 }), false);

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

    const original = "a".repeat(8000) + "🎉";
    assert.equal(chunks(original).join(""), original);
    assert.ok(chunks(original).every((part) => [...part].length <= MAX_MESSAGE));
    const fenced = "```js\n" + "const a = 1;\n".repeat(10) + "```";
    const fencedChunks = chunks(fenced, 60);
    assert.ok(fencedChunks.length > 1);
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
    // Run lifecycle, temporary drafts, notifications, Retry, and internal provider recovery.
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
        assert.equal(of("sendMessageDraft")[0].body.text, "");
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
        assert.equal(s.run.tool, null);
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
        assert.equal(s.run, null);
        calls.length = 0;
        await start();
        await end("x".repeat(5000), "error", "Network failure");
        assert.equal(s.run.error, true);
        const replies = of("sendMessage");
        assert.equal(replies.length, 2);
        assert.equal(replies[0].body.reply_markup, undefined);
        const buttons = replies.at(-1).body.reply_markup.inline_keyboard.flat();
        assert.equal(buttons.length, 1);
        assert.equal(buttons[0].text, "🔁 Retry");
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
        assert.equal(s.run.error, false);
        await s.handleEvent({ type: "agent_settled" });
        assert.equal(reactions().at(-1), "👌");
        for (const abort of [false, true]) {
          await start();
          if (abort) await s.handleCommand({ name: "abort", argument: "" });
          await s.handleEvent({ type: "agent_settled" });
          assert.equal(reactions().at(-1), abort ? undefined : "🤷");
        }
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
        assert.equal(gw.isUserPresent(), true);
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
    // Preview failure is one-shot, per-topic pacing is independent, and uploads do not block events.
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

    // Blocked polling reads bound panes only; remote_ask and stale callbacks suppress keys.
    {
      const { gw, s, calls } = await fresh(), requests = [];
      s.binding.paneId = "bound";
      let status = "blocked";
      gw.herdr = async (args) => {
        requests.push(args);
        if (args[0] === "list") return JSON.stringify({ result: { agents: [
          { pane_id: "bound", agent_status: status }, { pane_id: "unbound", agent_status: "blocked" },
        ] } });
        if (args[0] === "get") return JSON.stringify({ result: { agent: { agent_status: status } } });
        return "screen";
      };
      await gw.pollBlocked();
      assert.equal(requests.length, 0);
      s.isStreaming = true;
      await gw.pollBlocked();
      assert.equal(requests.length, 0, "stale bindings never poll");
      s.pi.proc = {};
      s.pi.connection = { clients: new Set(), hello: { paneId: "bound" } };
      s.uiMessages = new Map([["q", 1]]);
      await gw.pollBlocked();
      assert.equal(calls.length, 0);
      status = "working";
      await gw.pollBlocked();
      s.uiMessages.clear();
      status = "blocked";
      await gw.pollBlocked();
      const alerts = () => calls.filter((c) => c.method === "sendMessage");
      assert.equal(alerts().length, 1);
      assert.equal(alerts()[0].body.disable_notification, false);
      assert.ok(!requests.some((a) => a.includes("unbound")));
      await gw.pollBlocked();
      assert.equal(alerts().length, 1);
      const callback = (button) => ({ id: "cb", data: button.callback_data, message: { chat: { id: 1 }, message_id: 8 } });
      status = "idle";
      await gw.handleCallback(callback(alerts()[0].body.reply_markup.inline_keyboard[0][0]));
      assert.ok(!requests.some((a) => a[0] === "send-keys"));
      await gw.pollBlocked();
      gw.isUserPresent = () => true;
      status = "blocked";
      await gw.pollBlocked();
      assert.equal(alerts().at(-1).body.disable_notification, true);
      await gw.handleCallback(callback(alerts().at(-1).body.reply_markup.inline_keyboard[1][0]));
      assert.ok(requests.some((a) => a.join(" ") === "send-keys bound esc"));
      assert.equal(calls.at(-1).method, "editMessageReplyMarkup");
      s.stop();
    }

    // Native command aliases, ambiguity, reserved names, and topic-local discovery.
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

    // At-least-once offsets: dispatch first, persist only after completion; /restart flushes its own offset.
    {
      const { gw } = await fresh(), tg = gw.telegram, gate = Promise.withResolvers();
      let polls = 0;
      tg.call = async (_method, body) => {
        assert.equal(body.timeout, 25);
        assert.deepEqual(body.allowed_updates, ["message", "callback_query"]);
        if (!polls++) return [{ update_id: 7 }];
        tg.stopPolling();
        return [];
      };
      await tg.poll(() => gate.promise);
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
        assert.equal(restart.telegram.savedOffset, 889);
        earlier.resolve();
        await late;
        assert.equal(await readFile(restart.telegram.offsetPath, "utf8"), "889");
        await Promise.all([restart.telegram.saveOffset(890), restart.telegram.saveOffset(891), restart.telegram.saveOffset(889)]);
        assert.equal(await readFile(restart.telegram.offsetPath, "utf8"), "891");
        await sleep(150);
      } finally { process.exit = exitBefore; }
      const ready = new Gateway(restart.config), edits = [];
      assert.ok(ready.state.pendingRestartMessageId);
      ready.telegram.edit = async (...args) => { edits.push(args); };
      await ready.completeRestart();
      assert.equal(edits[0][2], "✅ Gateway restarted");
      assert.equal(loadState(ready.config.stateDir).pendingRestartMessageId, null);
      await ready.completeRestart();
      assert.equal(edits.length, 1);
    }

    // Retry policy distinguishes connection failures from ambiguous writes, and honors retry_after.
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
        assert.ok(Date.now() - started >= 45, "use retry_after, not the default 1s delay");
        assert.ok(Date.now() - started < 900);
      } finally { globalThis.fetch = guardedFetch; }
      assert.equal(pollBackoffMs(1, () => 0), 500);
      assert.equal(pollBackoffMs(2, () => 1), 2000);
      assert.equal(pollBackoffMs(10, () => 1), 60_000);
    }

    // Conflict waits are abortable, distinct from network-outage backoff.
    {
      const tg = new Telegram("1:x", join(dir, "conflict-offset"));
      let attempts = 0;
      tg.call = async () => {
        attempts++;
        setTimeout(() => tg.stopPolling(), 20);
        throw new Error("Conflict: another poller");
      };
      await tg.poll(() => assert.fail("no update on conflict"));
      assert.equal(attempts, 1);
      assert.equal(tg.inConflict, true);
      assert.equal(tg.pollFailures, 0);
    }
    // Shared HTML fallback preserves threads, notifications, and final-only buttons.
    {
      const { gw, calls } = await fresh(), tg = gw.telegram;
      tg.call = async (method, body) => {
        calls.push({ method, body });
        if (body.parse_mode) throw new Error("can't parse entities");
        return { message_id: 1 };
      };
      await tg.sendOne(1, "x".repeat(5000), { message_thread_id: 9, disable_notification: true, reply_markup: { inline_keyboard: [] } });
      assert.equal(calls.length, 3);
      assert.equal(calls[1].body.reply_markup, undefined);
      assert.ok(calls[2].body.reply_markup);
      assert.ok(calls.every((c) => c.body.message_thread_id === 9 && c.body.disable_notification));
      await tg.edit(1, 2, "x".repeat(5000));
      assert.equal(calls.at(-1).body.text.length, 4000);
      tg.call = async () => { throw new Error("message is not modified"); };
      await tg.edit(1, 2, "unchanged");
    }
    // RPC startup coalesces, failed writes clean pending requests, and resume refuses a second writer.
    {
      const { gw, s, calls } = await fresh();
      s.pi.proc = { destroyed: false, writable: true };
      s.pi.write = (rec) => { setTimeout(() => s.pi.receive({ id: rec.id, type: "response", command: rec.type, success: true, data: {} }), 50); };
      await s.handleCommand(parseCommand("/new"));
      assert.match(calls.at(-1).body.text, /✅ New session started/, "a slow bridge still completes /new");
      s.pi.request = async (type) => { throw new Error(`Pi bridge ${type} timed out; not retried`); };
      await s.handleCommand(parseCommand("/new"));
      assert.match(calls.at(-1).body.text, /❌ Pi bridge new_session timed out/);
      await gw.handleCallback(null, s, { type: "resume", path: "/timeout.jsonl" });
      assert.match(calls.at(-1).body.text, /❌ Pi bridge switch_session timed out/);
      const uiReq = { method: "select", id: "dedup-q", title: "Q", options: ["A", "B"] };
      await s.handleUiRequest(uiReq);
      const count = calls.filter((c) => c.method === "sendMessage").length;
      await s.handleUiRequest(uiReq);
      assert.equal(calls.filter((c) => c.method === "sendMessage").length, count, "duplicate ui request not posted");
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
    // Config validation preserves accepted inputs and its user-facing diagnostics.
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

    // Installer link safety only: never execute its service entry point.
    {
      const installer = await readFile(join(root, "install.sh"), "utf8");
      const definition = installer.match(/^install_command\(\) \{[\s\S]*?^\}/m)?.[0];
      assert.ok(definition);
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
      assert.equal(spawnSync("node", ["--check", "--experimental-strip-types", join(root, "remote-pi.ts")]).status, 0);
    }
    console.log("self-test: ok");
  } finally {
    globalThis.fetch = fetchBefore;
    net.connect = connectBefore;
    net.createConnection = createBefore;
    setTestMode(false);
    await rm(dir, { recursive: true, force: true });
  }
}
export { selfTest, selfTestPaneBridge };
if (import.meta.main) await selfTest();
