import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, readFile, readdir, readlink, realpath, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import net from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createRemoteBridge } from "./remote-pi.ts";
import {
  BOT_COMMANDS,
  ChatSession,
  Gateway,
  HELP,
  HerdrWatcher,
  MAX_MESSAGE,
  PaneRpc,
  RESERVED_COMMANDS,
  Telegram,
  attachmentPrompt,
  buildDevPath,
  chunks,
  encodeCwdSessionDir,
  errorActions,
  expandableBlockquote,
  extensionFromMime,
  extractText,
  formatAssistantError,
  formatContextTokens,
  formatRunCard,
  formatSessionReset,
  getUpdatePriority,
  herdrOptedIn,
  herdrTail,
  isConnectPhaseError,
  loadConfig,
  loadState,
  nextFallbackModel,
  paneHasForegroundShell,
  parseCommand,
  parseNumberConfig,
  parseNumstat,
  pollBackoffMs,
  previewText,
  redactLog,
  renderReplyHtml,
  renderToolPanel,
  resolveAgentSessionFile,
  resolveHerdrEnvironment,
  resolvePath,
  retryableTelegramStatus,
  runCommand,
  runStt,
  scanDesktopSessions,
  sessionKeyOf,
  setTestMode,
  shellQuote,
  shouldRetryTelegram,
  telegramCommandName,
  telegramHtml,
  toolSummary,
} from "./gateway.mjs";

const LINE_BUDGET = 4600;

async function selfTestPaneBridge() {
  const dir = join(tmpdir(), `rp-${randomBytes(4).toString("hex")}`);
  await mkdir(dir, { mode: 0o700 });
  const path = join(dir, "bridge.sock");
  const config = { allowedUserId: "1", botToken: "1:x", stateDir: dir, cwd: dir, doneCard: false };
  let gateway = new Gateway(config);
  const outputs = [];
  const events = [];
  let messageId = 0;
  const mockGateway = (gw) => {
    gw.telegram.send = async (_chat, text) => { outputs.push(text); return { message_id: ++messageId }; };
    gw.telegram.call = async () => true;
    gw.mainSession.startTyping = () => {};
    gw.mainSession.takeRunSnapshot = async () => null;
    const handle = gw.mainSession.handleEvent.bind(gw.mainSession);
    gw.mainSession.handleEvent = async (event) => { events.push(event); await handle(event); };
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
    if (method === "pane.get") return { pane: { tokens } };
    if (method === "pane.report_metadata") { metadataCalls.push(params); Object.assign(tokens, params.tokens); return {}; }
    if (method === "agent.list") return { agents: [{ pane_id: "w1:p-test", agent: "pi", name: "test-agent" }, ...otherAgents] };
    assert.fail(`Unexpected Herdr call ${method}`);
  };
  const badgeCalls = () => metadataCalls.filter((p) => "display_agent" in p || p.clear_display_agent === true);
  const until = async (predicate) => {
    for (let i = 0; i < 300; i++) { if (predicate()) return; await sleep(10); }
    assert.fail("Timed out waiting for fake bridge");
  };
  const runtime = (file) => {
    runtimeCount++;
    const handlers = new Map();
    const commands = new Map();
    const tools = new Map();
    let active = ["read", "bash"];
    let live = true;
    let idle = true;
    let autocompleteFactory;
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
        getEntries: () => entries, getBranch: () => entries,
      },
      modelRegistry: { getAvailable: () => [model], find: (provider, id) => provider === "fake" && id === "m" ? model : undefined },
      getContextUsage: () => ({ tokens: 50, contextWindow: 100, percent: 50 }),
      abort: () => { aborted++; }, shutdown: () => { quit++; },
      compact: ({ onComplete }) => onComplete({ tokensBefore: 100, estimatedTokensAfter: 20 }),
      ui: {
        setStatus: (key, text) => { statusCalls.push({ key, text }); },
        addAutocompleteProvider: (factory) => { autocompleteFactory = factory; },
        notify: (msg, type) => { notifyCalls.push({ msg, type }); },
        select: (_title, _options, { signal }) => new Promise((done) => {
          const selection = { done, cancelled: false };
          selections.push(selection);
          signal.addEventListener("abort", () => { selection.cancelled = true; done(undefined); }, { once: true });
          if (signal.aborted) { selection.cancelled = true; done(undefined); }
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
    ctx.fork = async () => replace("fork", join(dir, "fork.jsonl"));
    const pi = {
      on: (type, handler) => { if (!handlers.has(type)) handlers.set(type, []); handlers.get(type).push(handler); },
      registerCommand: (name, command) => commands.set(name, command),
      registerTool: (tool) => { tools.set(tool.name, tool); active.push(tool.name); },
      getActiveTools: () => { check(); return active; }, setActiveTools: (names) => { check(); active = names; },
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
    const bridge = createRemoteBridge(pi, { env, metadata });
    return { pi, ctx, tools, commands, bridge, emit, statusCalls, notifyCalls, get autocompleteFactory() { return autocompleteFactory; }, setIdle: (value) => { idle = value; } };
  };
  try {
    await gateway.bridge.start();
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    current = runtime(initialFile);
    await current.emit("session_start", { reason: "startup" });
    {
      let suggestions = { prefix: "/remo", items: ["remote-pi-new", "remote-pi-switch", "remote-pi-fork", "remote-control", "restart"].map((value) => ({ value, label: value })) };
      const args = [["/remo"], 0, 5, { signal: new AbortController().signal }];
      const completion = { lines: ["/restart "], cursorLine: 0, cursorCol: 9 };
      const provider = current.autocompleteFactory({
        triggerCharacters: ["#"],
        async getSuggestions(...received) { assert.deepEqual(received, args); return suggestions; },
        applyCompletion: (...received) => { assert.deepEqual(received, args); return completion; },
        shouldTriggerFileCompletion: (...received) => { assert.deepEqual(received, args); return false; },
      });
      assert.deepEqual((await provider.getSuggestions(...args)).items.map((item) => item.value), ["remote-control", "restart"], "only internal commands are hidden from terminal completion");
      assert.equal(suggestions.items.length, 5, "do not mutate the underlying provider's results");
      assert.equal(provider.applyCompletion(...args), completion);
      assert.equal(provider.shouldTriggerFileCompletion(...args), false);
      assert.deepEqual(provider.triggerCharacters, ["#"]);
      suggestions = { prefix: "/remo", items: suggestions.items.slice(0, 3) };
      assert.equal(await provider.getSuggestions(...args), null, "all hidden means no suggestions");
      suggestions = { prefix: "remote", items: [{ value: "remote-pi-new", label: "file or argument" }] };
      assert.equal(await provider.getSuggestions(...args), suggestions, "file and argument completions are unchanged");
      suggestions = null;
      assert.equal(await provider.getSuggestions(...args), null);
    }
    await until(() => gateway.mainSession.pi.proc);
    await until(() => badgeCalls().at(-1)?.display_agent === "📱 test-agent");
    await until(() => current.statusCalls.at(-1)?.text === "📱 remote");
    const conn = [...gateway.bridge.connections.values()][0];
    assert.equal(conn.hello.sessionName, "test");
    assert.deepEqual(conn.hello.recent, { firstUserText: "hello", lastUserText: "hello", lastAssistantText: "answer" });
    const session = gateway.mainSession;
    assert.ok(session.pi instanceof PaneRpc, "all ChatSessions use PaneRpc");
    assert.deepEqual(current.pi.getActiveTools(), ["read", "bash", "remote_attach", "remote_ask"]);
    const state = await session.pi.request("get_state");
    assert.equal(state.sessionFile, initialFile);
    assert.equal(state.sessionName, "test");
    assert.equal(state.model.provider, "fake");
    assert.equal(state.cwd, dir);
    assert.equal(state.isStreaming, false);
    const stats = await session.pi.request("get_session_stats");
    assert.deepEqual(stats.tokens, { input: 11, output: 3, cacheRead: 3, cacheWrite: 4, total: 21 });
    assert.ok(Math.abs(stats.cost - 0.3) < 1e-10);
    assert.deepEqual(stats.contextUsage, { tokens: 50, contextWindow: 100, percent: 50 });
    assert.deepEqual((await session.pi.request("get_available_thinking_levels")).levels, ["off", "low", "medium", "high", "xhigh"]);
    assert.deepEqual(await session.pi.request("clear_queue"), { steering: [], followUp: [] });
    await session.pi.request("abort");
    assert.equal(aborted, 1);
    assert.equal((await session.pi.request("get_last_assistant_text")).text, "answer");
    assert.deepEqual((await session.pi.request("get_fork_messages")).messages, [{ entryId: "u1", text: "hello" }]);
    assert.ok(!(await session.pi.request("get_commands")).commands.some((c) => c.name.startsWith("remote-pi-")));
    await assert.rejects(session.pi.request("unsupported"), /Unsupported bridge command/);
    const slow = session.pi.request("bash", { command: "slow" });
    await until(() => slowExec);
    assert.equal((await session.pi.request("get_state")).sessionFile, initialFile, "out-of-order responses correlate by id");
    slowExec();
    assert.deepEqual(await slow, { output: "outerr", exitCode: 7, cancelled: false });
    const image = { type: "image", data: "abc", mimeType: "image/png" };
    await session.pi.request("prompt", { message: "idle", images: [image] });
    assert.deepEqual(prompts.at(-1), { content: [{ type: "text", text: "idle" }, image], options: { expandPromptTemplates: true } });
    current.setIdle(false);
    for (const [type, fields, deliverAs] of [["prompt", { streamingBehavior: "steer" }, "steer"], ["prompt", { streamingBehavior: "followUp" }, "followUp"], ["steer", {}, "steer"], ["follow_up", {}, "followUp"]]) {
      await session.pi.request(type, { message: "queued", ...fields });
      assert.equal(prompts.at(-1).options.deliverAs, deliverAs);
    }
    await assert.rejects(session.pi.request("prompt", { message: "busy" }), /streaming/);
    current.setIdle(true);
    await current.emit("input", { text: "desktop \u2028 prompt", source: "interactive" });
    await current.emit("input", { text: "do not echo", source: "extension" });
    await until(() => outputs.includes("🖥 desktop \u2028 prompt"));
    assert.ok(!outputs.some((text) => text.includes("do not echo")));
    assert.ok(!outputs.some((text) => text === "🖥 idle" || text === "🖥 queued"));
    await current.emit("agent_start");
    await until(() => session.isStreaming);
    session.repliedInRun = true;
    await current.emit("agent_end", { messages: [] });
    await session.eventChain;
    assert.equal(session.isStreaming, true, "agent_end is not the final boundary");
    await current.emit("agent_settled");
    await until(() => !session.isStreaming);
    assert.ok(events.some((e) => e.type === "agent_settled"));
    await current.emit("session_before_compact", { reason: "threshold" });
    await current.emit("session_compact", { reason: "threshold", willRetry: false, compactionEntry: { tokensBefore: 100, summary: "short" } });
    await until(() => events.some((e) => e.type === "compaction_end"));
    assert.ok(events.some((e) => e.type === "compaction_start" && e.reason === "threshold"));
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
    await until(() => badgeCalls().at(-1)?.display_agent === "📱 test-agent");
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
    await until(() => badgeCalls().at(-1)?.clear_display_agent === true);
    gateway = new Gateway(config);
    mockGateway(gateway);
    assert.equal(gateway.mainSession.binding.sessionFile, join(dir, "s2.jsonl"), "binding persists across gateway restart");
    await gateway.bridge.start();
    await until(() => gateway.mainSession.pi.proc);
    await until(() => badgeCalls().at(-1)?.display_agent === "📱 test-agent");
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
    await until(() => badgeCalls().at(-1)?.clear_display_agent === true);
    assert.equal(current.statusCalls.at(-1)?.text, undefined, "setStatus cleared when remote is off");
    assert.ok(current.notifyCalls.some((c) => c.msg === "Remote control turned off from Telegram."), "notify user when remote is turned off from Telegram");
    await current.commands.get("remote-control").handler("on", current.ctx);
    await until(() => gateway.mainSession.pi.proc);
    await until(() => badgeCalls().at(-1)?.display_agent === "📱 test-agent");
    await until(() => current.statusCalls.at(-1)?.text === "📱 remote");
    // Assert connected -> reconnecting -> connected transition on socket drop
    const connBeforeDrop = [...gateway.bridge.connections.values()][0];
    connBeforeDrop?.socket?.destroy();
    await until(() => current.statusCalls.some((c) => c.text === "📱 reconnecting…"));
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
  const origGlobalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    throw new Error(`self-test: unexpected network call to ${url}`);
  };
  const origNetConnect = net.connect;
  const origNetCreateConnection = net.createConnection;
  net.connect = net.createConnection = function (...args) {
    const target = typeof args[0] === "string" ? args[0] : args[0]?.path;
    if (!target || !target.startsWith(`${tmpdir()}/`) || target === process.env.HERDR_SOCKET_PATH || target === process.env.REMOTE_PI_BRIDGE_SOCKET) {
      throw new Error(`Self-test only permits temporary test sockets: ${target}`);
    }
    return origNetConnect.apply(this, args);
  };
  try {
  const rootDir = dirname(fileURLToPath(import.meta.url));
  let totalLines = 0;
  for (const file of ["gateway.mjs", "remote-pi.ts", "install.sh"]) {
    const content = await readFile(join(rootDir, file), "utf8");
    let count = 0;
    for (let i = 0; i < content.length; i++) {
      if (content[i] === "\n") count++;
    }
    totalLines += count;
  }
  assert.ok(
    totalLines <= LINE_BUDGET,
    `Line budget exceeded: ${totalLines} > ${LINE_BUDGET}`,
  );

  await selfTestPaneBridge();

  // Startup attach-only: a persisted main binding whose pane no longer exists must not spawn anything.
  {
    const dir = join(tmpdir(), `rp-attach-${randomBytes(4).toString("hex")}`);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const config = { allowedUserId: "1", botToken: "1:x", stateDir: dir, cwd: dir, doneCard: false };
    const gwDead = new Gateway(config);
    await gwDead.bridge.start();
    // Persisted binding points at a closed pane; no bridge peer ever reconnects. Reaching the spawn
    // branch here would reject ("Herdr is required") under HERDR_DISABLED_FOR_TEST, failing the assert.
    gwDead.mainSession.binding = { paneId: "w_gone:p0", sessionFile: join(dir, "gone.jsonl"), cwd: dir, owned: true };
    assert.equal(await gwDead.ensurePaneSession(gwDead.mainSession.pi, { spawn: false }), false, "attach-only reports unbound");
    assert.equal(gwDead.mainSession.pi.proc, null, "main session stays unbound until a message arrives");
    await gwDead.bridge.stop();

    // A still-running Pi pane binds through the same attach-only path.
    const gwLive = new Gateway(config);
    await gwLive.bridge.start();
    const fakeSocket = { destroyed: false, writable: true, write: () => true };
    const connection = {
      socket: fakeSocket,
      clients: new Set(),
      hello: { paneId: "w_live:p1", cwd: dir, sessionFile: join(dir, "live.jsonl"), sessionId: "s1", pid: 4242 },
    };
    gwLive.bridge.connections.set("w_live:p1", connection);
    gwLive.mainSession.binding = { paneId: "w_live:p1", sessionFile: join(dir, "live.jsonl"), cwd: dir, owned: true };
    assert.equal(await gwLive.ensurePaneSession(gwLive.mainSession.pi, { spawn: false }), true, "attach-only binds a live pane");
    assert.equal(gwLive.mainSession.pi.proc, fakeSocket, "main session bound to the running Pi connection");
    await gwLive.bridge.stop();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }

  assert.equal(paneHasForegroundShell(undefined), false);
  assert.equal(paneHasForegroundShell({}), false);
  assert.equal(paneHasForegroundShell({ shell_pid: 0, foreground_process_group_id: 0 }), false);
  assert.equal(paneHasForegroundShell({ shell_pid: 100, foreground_process_group_id: 200 }), false);
  assert.equal(paneHasForegroundShell({ shell_pid: 100, foreground_process_group_id: 100 }), true);
  assert.deepEqual(parseCommand("/model openai/gpt-5"), { name: "model", argument: "openai/gpt-5" });
  assert.deepEqual(parseCommand("/help@my_bot"), { name: "help", argument: "" });
  assert.deepEqual(parseCommand("/sh ls -la"), { name: "sh", argument: "ls -la" });
  assert.deepEqual(parseCommand("/get README.md"), { name: "get", argument: "README.md" });
  assert.deepEqual(parseCommand("/followup check tests"), { name: "followup", argument: "check tests" });
  assert.equal(parseCommand("hello"), null);
  assert.ok(buildDevPath("/usr/bin:/bin").includes("/opt/homebrew/bin"));
  assert.ok(buildDevPath("/usr/bin:/bin").includes(join(homedir(), ".local", "bin")));
  assert.equal(await runCommand("echo", ["ok"]), "ok");
  assert.deepEqual(await resolveHerdrEnvironment(tmpdir()), {});
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
    await gw.mainSession.flushDraft(draft);
    assert.equal(draft.messageId, 123);
    assert.equal(sendOneCalls.length, 1);
    assert.equal(sendOneCalls[0].extra.disable_notification, true);
    assert.equal(editCalls.length, 0);

    // 2. 后续流式刷新原地编辑同一消息
    draft.text = "hello world";
    await gw.mainSession.flushDraft(draft);
    assert.equal(editCalls.length, 1);
    assert.equal(editCalls[0].messageId, 123);
    assert.equal(editCalls[0].text, "hello world");
    assert.equal(editCalls[0].ephemeral, true);

    // 3. 预览内容不变时跳过重复编辑
    await gw.mainSession.flushDraft(draft);
    assert.equal(editCalls.length, 1);

    // 4. 原地交付最终回复：首段 edit，无多余 sendOne
    await gw.mainSession.finishDraft(draft);
    assert.equal(editCalls.length, 2);
    assert.equal(editCalls[1].messageId, 123);
    assert.equal(editCalls[1].text, "hello world");
    assert.equal(editCalls[1].ephemeral, false);
    assert.equal(sendOneCalls.length, 1);

    // 5. closed 拦截过期刷新
    await gw.mainSession.flushDraft({ text: "stale", closed: true });
    assert.equal(editCalls.length, 2);

    // 6. 未曾触发流式（无 messageId），finishDraft 直接 sendOne 交付
    const unstreamed = { text: "direct send", messageId: null };
    await gw.mainSession.finishDraft(unstreamed);
    assert.equal(sendOneCalls.length, 2);
    assert.equal(sendOneCalls[1].text, "direct send");

    // 回归：最终交付失败时文本落盘为可恢复副本
    {
      const tmpUi = join(tmpdir(), `test-remote-pi-ui-${Date.now()}`);
      await mkdir(tmpUi, { recursive: true, mode: 0o700 });
      const gwFail = new Gateway({ allowedUserId: "1", botToken: "1:x", stateDir: tmpUi });
      gwFail.telegram.sendOne = async () => { throw new Error("network down"); };
      gwFail.mainSession.send = async () => {};
      await gwFail.mainSession.finishDraft({ text: "recover me", messageId: null, draftId: null });
      const copies = (await readdir(tmpUi)).filter((f) => f.startsWith("failed-reply-"));
      assert.equal(copies.length, 1);
      assert.equal(await readFile(join(tmpUi, copies[0]), "utf8"), "recover me");
    }

    // Phase 3：超长回复改为 HTML 文档附件；发送失败回退分段
    {
      const tmpLong = join(tmpdir(), `test-remote-pi-long-${Date.now()}`);
      await mkdir(tmpLong, { recursive: true, mode: 0o700 });
      const gwLong = new Gateway({ allowedUserId: "1", botToken: "1:x", stateDir: tmpLong, downloadsDir: tmpLong, longReplyChars: 100 });
      const longEdits = [];
      const longSends = [];
      let docCalls = 0;
      gwLong.telegram.edit = async (_c, id, text) => { longEdits.push({ id, text }); return true; };
      gwLong.telegram.sendOne = async (_c, text) => { longSends.push(text); return { message_id: 1 }; };
      gwLong.telegram.sendDocument = async () => { docCalls++; return { message_id: 2 }; };
      const longText = `# Big\n\n${"word ".repeat(80)}`;
      await gwLong.mainSession.finishDraft({ text: longText, messageId: 7 });
      assert.equal(docCalls, 1, "long reply sent as document");
      assert.ok(longEdits[0].text.includes("(full reply attached"), "first chunk kept with note");
      assert.equal(longSends.length, 0, "no extra plain chunks");
      const savedHtml = (await readdir(tmpLong)).find((f) => f.startsWith("reply-") && f.endsWith(".html"));
      assert.ok(savedHtml, "reply html file written");
      assert.ok((await readFile(join(tmpLong, savedHtml), "utf8")).includes("<h1>Big</h1>"), "html rendered from markdown");
      // 发送文档失败 → 回退全量分段（原地 edit 回完整首段）
      let failDoc = true;
      gwLong.telegram.sendDocument = async () => { if (failDoc) throw new Error("upload failed"); };
      await gwLong.mainSession.finishDraft({ text: longText, messageId: 8 });
      assert.ok(!longEdits.at(-1).text.includes("(full reply attached"), "fallback drops the note");
      assert.ok(longEdits.at(-1).text.startsWith("# Big"), "fallback edits full first chunk");
      // longReplyChars: 0 → 关闭，直接分段
      gwLong.config.longReplyChars = 0;
      failDoc = false; docCalls = 0;
      longSends.length = 0;
      await gwLong.mainSession.finishDraft({ text: longText, messageId: null });
      assert.equal(docCalls, 0, "disabled via 0");
      assert.ok(longSends.length >= 1);
    }

    // Phase 3：错误恢复按钮 errorActions + retry 回调
    {
      const gwErr = new Gateway({
        allowedUserId: "1", botToken: "1:x", stateDir: tmpdir(),
        fallbackModels: ["anthropic/claude", "google/gemini"],
      });
      const s = gwErr.mainSession;
      assert.ok(errorActions(s, "boom").reply_markup.inline_keyboard.length >= 3, "static buttons always present");
      assert.ok(!JSON.stringify(errorActions(s, "boom")).includes("Retry"), "no lastPrompt → no retry");
      s.lastPrompt = { message: "do it", images: undefined };
      s.lastModel = { provider: "anthropic", modelId: "claude" };
      const kb = errorActions(s, "boom").reply_markup.inline_keyboard;
      assert.equal(kb[0][0].text, "🔁 Retry");
      assert.ok(kb[1][0].text.includes("google/gemini"), "next fallback after current");
      const kb429 = errorActions(s, "429 rate limit exceeded").reply_markup.inline_keyboard;
      assert.ok(kb429[0][0].text.includes("Retry with"), "rate limit puts fallback first");
      const kbWrap = errorActions(s, "boom", { endedRun: false }).reply_markup.inline_keyboard;
      s.isStreaming = true;
      assert.ok(!JSON.stringify(errorActions(s, "boom")).includes("Retry"), "streaming → retry omitted");
      assert.ok(kbWrap.length >= 3);
      // retry 回调：重发上一次 prompt
      s.isStreaming = false;
      const sent = [];
      s.send = async (text) => { sent.push(text); };
      s.startTyping = () => {};
      s.stopTyping = () => {};
      const rpcCalls = [];
      s.pi.request = async (type, fields) => { rpcCalls.push({ type, fields }); };
      await s.handleCallbackAction({ type: "retry" }, { id: "c1" });
      assert.equal(rpcCalls.at(-1).type, "prompt");
      assert.equal(rpcCalls.at(-1).fields.message, "do it");
      assert.ok(sent.some((t) => t.includes("Retrying")), "retry notifies");
      // retry_fallback：先 set_model 再 prompt
      await s.handleCallbackAction({ type: "retry_fallback", model: "google/gemini" }, { id: "c2" });
      assert.equal(rpcCalls.at(-2).type, "set_model");
      assert.deepEqual(rpcCalls.at(-2).fields, { provider: "google", modelId: "gemini" });
      assert.equal(rpcCalls.at(-1).type, "prompt");
    }

    // Test remote_attach auto delivery via tool_execution_end
    gw.chatReady = true;
    const docs = [];
    gw.telegram.sendDocument = async (_chat, path) => docs.push(path);
    await gw.mainSession.handleEvent({
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "remote_attach",
      isError: false,
      result: { details: { paths: ["/tmp/file1.png", "/tmp/file2.pdf"] } },
    });
    await Promise.all([gw.telegramChain, gw.uploadChain]);
    assert.deepEqual(docs, ["/tmp/file1.png", "/tmp/file2.pdf"]);

    // Test priority command classification and preemptive dispatch
    assert.equal(getUpdatePriority({ message: { text: "/abort" } }), "p0");
    assert.equal(getUpdatePriority({ message: { text: "/new" } }), "p0");
    assert.equal(getUpdatePriority({ message: { text: "/restart" } }), "p0");
    assert.equal(getUpdatePriority({ message: { text: "/status" } }), "p1");
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
    gw.dispatchUpdate({ message: { from: { id: 1 }, text: "/sh sleep 10" } });
    await sleep(5);
    assert.equal(p2Started, true);
    assert.equal(p2Finished, false);

    // P0 should execute immediately without waiting for P2 to finish
    gw.dispatchUpdate({ message: { from: { id: 1 }, text: "/abort" } });
    assert.equal(p0Executed, true);
    assert.equal(p2Finished, false);

    await gw.mainSession.updateChain;
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

    // 回归（审计修复 M2）：预览更新失败不再静默，必须留错误日志
    {
      const errs = [];
      const origError = console.error;
      console.error = (...a) => errs.push(a.map(String).join(" "));
      const prevSendOne = gw.telegram.sendOne;
      gw.telegram.sendOne = async () => { throw new Error("preview boom"); };
      await gw.mainSession.flushDraft({ text: "boom draft", flushing: false, messageId: null });
      console.error = origError;
      gw.telegram.sendOne = prevSendOne;
      assert.ok(errs.some((e) => e.includes("preview update failed")), "flushDraft 失败应留日志");
    }

    // poll allowed_updates only includes message and callback_query
    {
      assert.equal(Telegram.prototype.poll.toString().match(/allowed_updates:\s*(\[[^\]]+\])/)?.[1], '["message", "callback_query"]');
    }

    // Test /new preserves last effective model
    let mockModel = { provider: "openai", id: "gpt-4o" };
    const mockRequests = [];
    gw.mainSession.pi.proc = {};
    gw.mainSession.pi.request = async (command, params) => {
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
    await gw.mainSession.handleCommand({ name: "new", argument: "" });
    assert.deepEqual(mockRequests.find((r) => r.command === "set_model"), {
      command: "set_model",
      params: { provider: "openai", modelId: "gpt-4o" },
    });
    assert.ok(newSessionSent.includes("◆ Model: gpt-4o"));
    assert.deepEqual(gw.mainSession.lastModel, { provider: "openai", modelId: "gpt-4o" });
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

    const validCfgPath = join(tmpCfgDir, "config.json");
    writeFileSync(
      validCfgPath,
      JSON.stringify({
        telegram: { botToken: "123456:abcdef", allowedUserId: "999" },
        cwd: tmpCfgDir,
        stateDir: tmpCfgDir,
      })
    );

    const prevEnvCfg = process.env.REMOTE_PI_CONFIG;
    process.env.REMOTE_PI_CONFIG = validCfgPath;
    try {
      const cfg = loadConfig();
      assert.equal(cfg.botToken, "123456:abcdef");
      assert.equal(cfg.allowedUserId, "999");
      assert.equal(cfg.cwd, tmpCfgDir);
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
    await gwNoHistory.mainSession.showCwds();
    assert.ok(sentMsg.includes("No recent projects yet"), "showCwds should guide usage when history is empty");

    // verify switchCwd reports error for nonexistent dir and keeps cwd
    const gwSwitch = new Gateway({ allowedUserId: "1", botToken: "1:x", stateDir: tmpCfgDir, cwd: tmpCfgDir });
    let switchMsg = "";
    gwSwitch.telegram.send = async (_chat, text) => { switchMsg = text; };
    await gwSwitch.mainSession.switchCwd(join(tmpCfgDir, "no-such-dir"), null);
    assert.ok(switchMsg.includes("Directory missing"), "switchCwd should report error for missing dir");
    assert.equal(gwSwitch.config.cwd, tmpCfgDir);

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
    await tg.setReaction(123, 456, "👀");
    assert.deepEqual(calls[0], {
      method: "setMessageReaction",
      body: { chat_id: 123, message_id: 456, reaction: [{ type: "emoji", emoji: "👀" }] },
    });
    assert.equal(await tg.setReaction(123, 0, "👀"), null);
    assert.equal(calls.length, 1);
  }

  // Receipt reactions stay unchanged; completion is delivered by the run card.
  {
    const gwAck = new Gateway({ allowedUserId: "1", botToken: "1:x", stateDir: tmpdir(), ackEmoji: "👀", doneCard: true });
    gwAck.chatReady = true;
    const session = gwAck.mainSession;
    const reactions = [];
    const sent = [];
    gwAck.telegram.setReaction = async (_chat, id, emoji) => { reactions.push({ id, emoji }); };
    gwAck.telegram.send = async (_chat, text) => { sent.push(text); };
    session.prompt = async () => {};
    session.handleCommand = async () => {};
    session.pi.write = () => {};
    session.pi.request = async () => ({ cost: 0 });
    const message = (id, text) => ({ message_id: id, text, from: { id: 1 }, chat: { type: "private" } });

    await gwAck.handleMessage(message(1, "hello"));
    session.repliedInRun = true;
    let cardPromise;
    const sendRunCard = session.sendRunCard.bind(session);
    session.sendRunCard = (...args) => (cardPromise = sendRunCard(...args));
    await session.handleEvent({ type: "agent_settled" });
    await cardPromise;
    await gwAck.telegramChain;
    assert.ok(sent.some((text) => text.startsWith("✅ Done")), "Completion must still send a run card");

    await gwAck.handleMessage(message(2, "/status"));
    await gwAck.handleMessage(message(3, "/followup next"));
    await gwAck.handlePriorityUpdate({ message: message(4, "/abort") }, "p0");
    session.pendingUi = { id: "ack-ui" };
    await gwAck.handleMessage(message(5, "answer"));
    gwAck.extractMedia = async () => ({ saved: { path: "/tmp/ack.jpg" }, label: "photo" });
    await gwAck.handleMessage(message(6, "photo"));
    gwAck.herdrWatcher = {
      cliJson: async () => ({ agent: { agent_status: "idle" } }),
      cli: async () => {},
      label: () => "agent",
    };
    await gwAck.replyToHerdrAgent("w1:p1", message(7, "next"));
    assert.deepEqual(reactions, Array.from({ length: 7 }, (_, i) => ({ id: i + 1, emoji: "👀" })), "Each input gets only its receipt reaction, never a completion reaction");
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
      gwRestart.telegram.send = async (_c, text) => { sentMsg = text; return { message_id: 42 }; };
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

      const gwReady = new Gateway({ allowedUserId: "1", botToken: "1:x", stateDir: tmpState });
      assert.equal(gwReady.state.pendingRestartMessageId, 42, "restart message must survive process replacement");
      const edits = [];
      gwReady.telegram.edit = async (...args) => { edits.push(args); };
      await gwReady.completeRestart();
      assert.deepEqual(edits, [["1", 42, "✅ Gateway restarted"]]);
      assert.equal(loadState(tmpState).pendingRestartMessageId, null, "successful notice must be cleared on disk");
      await gwReady.completeRestart();
      assert.equal(edits.length, 1, "ordinary startup must not repeat the notice");

      await gwReady.saveState({ pendingRestartMessageId: 43 });
      gwReady.telegram.edit = async () => { throw new Error("offline"); };
      await gwReady.completeRestart();
      assert.equal(loadState(tmpState).pendingRestartMessageId, 43, "failed notice must remain for a later startup");
      gwReady.telegram.edit = async (...args) => { edits.push(args); };
      await gwReady.completeRestart();
      assert.deepEqual(edits.at(-1), ["1", 43, "✅ Gateway restarted"]);
      await rm(tmpState, { recursive: true, force: true });
    }

    // A bridge disconnect is not proof of process exit.
    {
      const gwExit = new Gateway({ allowedUserId: "1", botToken: "1:x", stateDir: tmpdir() });
      gwExit.mainSession.isStreaming = true;
      let exitNotice = "";
      gwExit.telegram.send = async (_c, text) => { exitNotice = text; };
      await gwExit.mainSession.handlePiExit({ expected: false });
      assert.equal(gwExit.mainSession.isStreaming, false, "异常退出后 isStreaming 必须重置为 false");
      await gwExit.telegramChain;
      assert.equal(exitNotice, "", "A bridge disconnect is not proof that Pi exited");
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
      gwMedia.mainSession.prompt = async (text) => { prompts.push(text); };

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
      await gwMedia.mainSession.updateChain;

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
      await gwAbort.mainSession.handleCommand({ name: "abort", argument: "" }, "/abort");
      // Pi RPC 随后响应 agent_settled
      await gwAbort.mainSession.handleEvent({ type: "agent_settled" });
      await gwAbort.telegramChain;
      assert.equal(sentWarning, false, "/abort 后 agent_settled 不应误报未返回文本回复");
    }

    // 回归（架构审查 Issue 6）：UI 选项点击时同一 requestId 的所有 token 立即作废
    {
      const gwUi = new Gateway({ allowedUserId: "1", botToken: "1:x", stateDir: tmpdir() });
      gwUi.mainSession.pi.write = () => {};
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
      await gwRate.mainSession.flushDraft({ text: "test rate limit", flushing: false, closed: false, messageId: null });
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
  // Exercise only link installation in a temp directory, never the installer's service entry point.
  {
    const installer = await readFile(join(dirname(fileURLToPath(import.meta.url)), "install.sh"), "utf8");
    const definition = installer.match(/^install_command\(\) \{[\s\S]*?^\}/m)?.[0];
    assert.ok(definition, "installer link function exists");
    const dir = join(tmpdir(), `test-install-link-${randomBytes(4).toString("hex")}`);
    const root = join(dir, "checkout with spaces");
    const extensionDir = join(dir, "extensions");
    const extension = join(extensionDir, "remote-pi.ts");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "remote-pi.ts"), "// fake extension\n");
    await mkdir(extensionDir);
    const installLink = () => spawnSync("bash", ["-c", `set -euo pipefail\n${definition}\ninstall_command`], {
      env: { ...process.env, ROOT: root, COMMAND: join(dir, "bin", "pi-remote-gateway"), PI_EXTENSION_DIR: extensionDir, PI_EXTENSION: extension },
    });
    try {
      await symlink(join(root, "retired.ts"), extension);
      for (let i = 0; i < 2; i++) {
        const result = installLink();
        assert.equal(result.status, 0, `replace dangling link and repeat safely: ${result.stderr}`);
        assert.equal(await readlink(extension), join(root, "remote-pi.ts"));
      }
      assert.equal(await readlink(join(dir, "bin", "pi-remote-gateway")), join(root, "install.sh"));
      await unlink(extension);
      await writeFile(extension, "user-owned extension\n");
      assert.equal(installLink().status, 1, "refuse to replace an unrelated regular file");
      assert.equal(await readFile(extension, "utf8"), "user-owned extension\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  // Herdr notifications: opt-in, blocked-only delivery and duplicate suppression.
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
    assert.deepEqual(notified, ["w1:p1:blocked"], "Only blocked transitions notify; initial, repeated, completed and excluded states do not");
  }
  assert.ok(HELP.includes("/agents") && BOT_COMMANDS.some((c) => c.command === "agents"), "/agents registered");
  {
    const r = spawnSync("node", ["--check", "--experimental-strip-types", join(dirname(fileURLToPath(import.meta.url)), "remote-pi.ts")]);
    assert.equal(r.status, 0, `remote-pi.ts syntax check: ${r.stderr}`);
  }
  assert.ok(HELP.includes("/upgrade"), "HELP mentions /upgrade");
  assert.deepEqual(BOT_COMMANDS.find((c) => c.command === "status"), { command: "status", description: "Session status, tokens & cost" });
  assert.deepEqual(BOT_COMMANDS.find((c) => c.command === "restart"), { command: "restart", description: "Restart the gateway" });
  assert.deepEqual(BOT_COMMANDS.find((c) => c.command === "git_commit_push"), { command: "git_commit_push", description: "Stage, commit and push" });
  assert.ok(HELP.includes("/git_commit_push"), "HELP mentions /git_commit_push");
  for (const name of ["name", "restart", "upgrade"]) {
    if (name !== "restart") assert.ok(!BOT_COMMANDS.some((c) => c.command === name), `${name} hidden from menu`);
    assert.ok(HELP.split("\nAdmin\n")[1].includes(`/${name}`), `${name} listed under Admin`);
  }
  assert.ok(!BOT_COMMANDS.some((c) => c.command === "commands"), "command discovery folded into help");

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

  // PaneRpc startup coalescing and failed-write cleanup
  {
    let startCalls = 0;
    const gwRace = new Gateway({ allowedUserId: "1", botToken: "1:x", cwd: tmpdir(), stateDir: tmpdir() });
    const rpc = gwRace.mainSession.pi;
    rpc.start = async () => {
      startCalls++;
      await sleep(20);
      rpc.proc = { destroyed: false };
    };

    await Promise.all([rpc.ensureStarted(), rpc.ensureStarted(), rpc.ensureStarted()]);
    assert.equal(startCalls, 1, "ensureStarted 并发调用时 start 仅应执行一次");

    rpc.write = () => { throw new Error("socket broke"); };
    await assert.rejects(
      () => rpc.request("test_cmd", {}, 1000),
      /socket broke/,
      "write 抛出异常时 request 应立即 reject",
    );
    assert.equal(rpc.pending.size, 0, "write 异常后 pending 不应泄露");
  }

  // Multi-session & Topics in private chats (ref: Telegram Bot API 9.3 & 9.4)
  assert.equal(sessionKeyOf({ message_id: 1, text: "main msg", chat: { type: "private" } }), "main");
  assert.equal(sessionKeyOf({ message_id: 2, message_thread_id: 99, is_topic_message: true, chat: { type: "private" } }), "t:99");
  assert.equal(sessionKeyOf({ message_id: 2, message_thread_id: 99 }), "t:99");
  assert.equal(sessionKeyOf({ id: "cb1", message: { message_id: 3, message_thread_id: 99, is_topic_message: true, chat: { type: "private" } } }), "t:99");
  assert.equal(sessionKeyOf({ id: "cb2", message: { message_id: 4, chat: { type: "private" } } }), "main");
  assert.equal(sessionKeyOf(null), "main");

  // loadState keeps valid topics and drops ones whose cwd is missing
  {
    const tmpStateDir = join(tmpdir(), `test-topics-state-${Date.now()}`);
    await mkdir(tmpStateDir, { recursive: true, mode: 0o700 });
    const validDir = join(tmpStateDir, "valid-proj");
    await mkdir(validDir, { recursive: true, mode: 0o700 });
    const missingDir = join(tmpStateDir, "nonexistent-proj");
    await writeFile(join(tmpStateDir, "state.json"), JSON.stringify({
      cwd: validDir,
      recentProjects: [validDir],
      topics: {
        "10": { cwd: validDir },
        "20": { cwd: missingDir },
      },
    }), { mode: 0o600 });
    const stateWithTopics = loadState(tmpStateDir);
    assert.deepEqual(stateWithTopics.topics["10"], { cwd: validDir });
    assert.equal(stateWithTopics.topics["20"], undefined);
  }

  // Session updateChain concurrency & ordering (ref: review issue 3 & 6)
  {
    const gwChains = new Gateway({ allowedUserId: "1", botToken: "1:x", stateDir: tmpdir() });
    gwChains.chatReady = true;
    const sessionA = gwChains.mainSession;
    const sessionB = new ChatSession(gwChains, { threadId: 200, cwd: tmpdir() });
    gwChains.sessions.set("t:200", sessionB);

    const log = [];
    let releaseA;
    const hangingPromise = new Promise((resolve) => { releaseA = resolve; });

    sessionA.updateChain = sessionA.updateChain.then(async () => {
      log.push("A1:start");
      await hangingPromise;
      log.push("A1:end");
    });

    sessionA.updateChain = sessionA.updateChain.then(async () => {
      log.push("A2");
    });

    sessionB.updateChain = sessionB.updateChain.then(async () => {
      log.push("B1");
    });

    await sleep(20);
    assert.deepEqual(log, ["A1:start", "B1"], "Session B must not be blocked by hanging task in Session A");

    releaseA();
    await sessionA.updateChain;
    assert.deepEqual(log, ["A1:start", "B1", "A1:end", "A2"], "Tasks within Session A must execute in order");
  }

  // close_topic callback single answer (ref: review issue 5)
  {
    const gwClose = new Gateway({ allowedUserId: "1", botToken: "1:x", stateDir: tmpdir() });
    const answers = [];
    gwClose.telegram.answer = async (_id, text) => { answers.push(text); };
    gwClose.telegram.edit = async () => {};
    gwClose.telegram.call = async () => ({});
    const tid = 789;
    gwClose.state.topics[tid] = { cwd: tmpdir() };
    const closeSession = new ChatSession(gwClose, { threadId: tid, cwd: tmpdir() });
    gwClose.sessions.set(`t:${tid}`, closeSession);

    const token = gwClose.action({ type: "close_topic", threadId: tid, confirmed: true });
    await gwClose.handleCallback({ id: "cb-close", data: token, message: { chat: { id: 1 }, message_id: 10 } });
    assert.deepEqual(answers, [undefined], "close_topic 应只回复一次 answerCallbackQuery");
    assert.equal(gwClose.sessions.has(`t:${tid}`), false);
  }

  // Topic cwd switch adds to recentProjects (ref: review issue 2)
  {
    const tmpDir = join(tmpdir(), `test-topic-recent-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });
    const p1 = join(tmpDir, "p1");
    const p2 = join(tmpDir, "p2");
    await mkdir(p1, { recursive: true });
    await mkdir(p2, { recursive: true });
    const gwTopCwd = new Gateway({ allowedUserId: "1", botToken: "1:x", stateDir: tmpDir, cwd: p1 });
    gwTopCwd.telegram.call = async () => ({});
    const topSession = new ChatSession(gwTopCwd, { threadId: 55, cwd: p1 });
    gwTopCwd.sessions.set("t:55", topSession);
    topSession.send = async () => {};
    topSession.createPi = () => ({
      stop: () => {},
      start: async () => {},
      request: async () => ({ sessionId: "s1" }),
    });
    await topSession.switchCwd(p2, null);
    const realP2 = await realpath(p2);
    assert.ok(gwTopCwd.state.recentProjects.includes(realP2), "Topic cwd 切换应将目标加入 recentProjects");
  }

  // Phase 3：renderReplyHtml / nextFallbackModel / redactLog
  {
    const html = renderReplyHtml("# My Report\n\n<script>alert(1)</script>\n\n| a | b |\n|---|---|\n| 1 | 2 |\n");
    assert.ok(html.includes('meta name="viewport" content="width=device-width,initial-scale=1"'), "viewport meta");
    assert.ok(!/<script>/.test(html) && html.includes("&lt;script&gt;"), "raw HTML escaped");
    assert.ok(html.includes("<table>") && html.includes("<th>a</th>"), "GFM table rendered");
    assert.ok(html.match(/<title>[^<]*My Report[^<]*<\/title>/), "title from first heading");
    assert.ok(html.includes("prefers-color-scheme: dark"), "dark mode media query");
    const html2 = renderReplyHtml("no headings at all\nsecond line");
    assert.ok(html2.includes("<title>no headings at all</title>"), "title falls back to first line");
  }
  {
    const list = ["anthropic/claude", "google/gemini", "openai/gpt"];
    assert.equal(nextFallbackModel(list, { provider: "anthropic", modelId: "claude" }), "google/gemini");
    assert.equal(nextFallbackModel(list, { provider: "openai", modelId: "gpt" }), "anthropic/claude", "wrap-around");
    assert.equal(nextFallbackModel(list, "unknown/model"), "anthropic/claude", "current not in list → first entry");
    assert.equal(nextFallbackModel([], "anthropic/claude"), null, "empty list → null");
    assert.equal(nextFallbackModel(["anthropic/claude"], { provider: "anthropic", modelId: "claude" }), null, "single-entry list at current → null");
    assert.equal(nextFallbackModel(null, null), null, "no list → null");
  }
  {
    const sample = "2026-01-01 bot 123:ABC connecting\napi_key=sk-123\nTOKEN: xyz\nauthorization: Bearer b\nplain line";
    const redacted = redactLog(sample, "123:ABC");
    assert.ok(!redacted.includes("sk-123") && !redacted.includes("123:ABC"), "secrets removed");
    assert.ok(!redacted.includes("xyz") && !redacted.includes("Bearer b"), "token-style pairs removed");
    assert.ok(redacted.includes("plain line"), "non-secret lines kept");
  }
  // Phase 2: parseNumstat — 解析 git diff -z --numstat 输出（含二进制、重命名与中文路径）
  {
    assert.deepEqual(parseNumstat(""), []);
    assert.deepEqual(parseNumstat(null), []);

    const raw = [
      "10\t5\tsrc/index.js",
      "-\t-\tassets/logo.png",
      "3\t1\t中文文件.txt",
      "0\t0\t", // rename: path 字段为空，后两个 NUL 段是 old/new
    ].join("\0") + "\0old/dir/旧名.txt\u0000new/dir/新名.txt\0";

    const parsed = parseNumstat(raw);
    assert.equal(parsed.length, 4);
    assert.deepEqual(parsed[0], { path: "src/index.js", added: 10, deleted: 5, binary: false });
    assert.deepEqual(parsed[1], { path: "assets/logo.png", added: 0, deleted: 0, binary: true });
    assert.deepEqual(parsed[2], { path: "中文文件.txt", added: 3, deleted: 1, binary: false });
    assert.deepEqual(parsed[3], { path: "new/dir/新名.txt", added: 0, deleted: 0, binary: false, oldPath: "old/dir/旧名.txt" });
  }

  // Phase 2: formatRunCard
  {
    const card = formatRunCard({
      durationMs: 133_000,
      costDelta: 0.04,
      tokensDelta: 12_300,
      ctxPercent: 31,
      files: [
        { path: "src/gateway.mjs", added: 10, deleted: 4 },
        { path: "README.md", added: 5, deleted: 0 },
        { path: "new-file.txt", untracked: true },
      ],
    });
    assert.ok(card.includes("✅ Done · 2m13s · +$0.04 · 12.3k tok · ctx 31%"));
    assert.ok(card.includes("📝 3 files changed this run (+15 \u22124)"));
    assert.ok(card.includes("• src/gateway.mjs +10 \u22124"));
    assert.ok(card.includes("• README.md +5 \u22120"));
    assert.ok(card.includes("• new-file.txt new"));

    // non-git / no files
    const nonGitCard = formatRunCard({ durationMs: 45_000, costDelta: 0.01, tokensDelta: 500, ctxPercent: 12 });
    assert.equal(nonGitCard, "✅ Done · 45s · +$0.01 · 500 tok · ctx 12%");

    // single file
    const singleFileCard = formatRunCard({
      durationMs: 10_000,
      files: [{ path: "fix.js", added: 2, deleted: 1 }],
    });
    assert.ok(singleFileCard.includes("📝 1 file changed this run (+2 \u22121)"));
    assert.ok(singleFileCard.includes("• fix.js +2 \u22121"));

    // binary and > 8 files
    const tenFiles = [];
    for (let i = 1; i <= 10; i++) {
      tenFiles.push(i === 1 ? { path: "img.png", binary: true } : { path: `f${i}.js`, added: 1, deleted: 0 });
    }
    const cardTen = formatRunCard({ durationMs: 2000, files: tenFiles });
    assert.ok(cardTen.includes("• img.png binary"));
    assert.ok(cardTen.includes("…and 2 more"));
  }

  // Legacy status-board IDs are ignored without affecting session state.
  {
    const tmpStateDir = join(tmpdir(), `test-legacy-state-${Date.now()}`);
    await mkdir(tmpStateDir, { recursive: true, mode: 0o700 });
    await writeFile(join(tmpStateDir, "state.json"), JSON.stringify({
      cwd: tmpStateDir,
      statusBoards: { main: 12345, "t:99": 67890 },
    }), { mode: 0o600 });
    const loaded = loadState(tmpStateDir);
    assert.equal(Object.hasOwn(loaded, "statusBoards"), false);
    assert.equal(loaded.cwd, tmpStateDir);
    await rm(tmpStateDir, { recursive: true, force: true });
  }

  // Phase 2 review: card computation does not block other sessions' Telegram output
  {
    const gwOrder = new Gateway({ allowedUserId: "1", botToken: "1:x", stateDir: tmpdir() });
    gwOrder.chatReady = true;
    const session1 = gwOrder.mainSession;
    const session2 = new ChatSession(gwOrder, { threadId: 301, cwd: tmpdir() });
    gwOrder.sessions.set("t:301", session2);

    const deliveryLog = [];
    session1.send = async (text) => {
      return gwOrder.queueTelegram(async () => {
        deliveryLog.push(`s1:${text}`);
      });
    };
    session2.send = async (text) => {
      return gwOrder.queueTelegram(async () => {
        deliveryLog.push(`s2:${text}`);
      });
    };

    let slowResolve;
    const slowPromise = new Promise((resolve) => { slowResolve = resolve; });
    session1.pi.request = async (cmd) => {
      if (cmd === "get_session_stats") {
        await slowPromise;
        return { cost: 0.05, tokens: { total: 100 } };
      }
      return {};
    };

    gwOrder.queueTelegram(async () => {
      deliveryLog.push("s1:final_reply");
    });
    const cardPromise = session1.sendRunCard(Promise.resolve(null), 1000);

    await session2.send("fast_msg");

    assert.deepEqual(deliveryLog, ["s1:final_reply", "s2:fast_msg"], "Session 2 output must not be blocked while Session 1 computes card");

    slowResolve();
    await cardPromise;

    assert.equal(deliveryLog.length, 3);
    assert.ok(deliveryLog[2].startsWith("s1:✅ Done"));
  }

  // Phase 2 review: git paths in subdirectory of repo (toplevel resolution, card diff, undo) & runCommand okCodes
  {
    let gitAvailable = true;
    try {
      await runCommand("git", ["--version"], { timeout: 2000 });
    } catch {
      gitAvailable = false;
    }

    if (gitAvailable) {
      const testDiff = await runCommand("git", ["diff", "--no-index", "--", "/dev/null", "package.json"], { timeout: 5000, okCodes: [0, 1] });
      assert.ok(testDiff.includes("package.json"), "runCommand with okCodes [0, 1] must resolve on exit code 1");

      const repoDir = join(tmpdir(), `test-git-subrepo-${Date.now()}`);
      await mkdir(repoDir, { recursive: true });
      const subDir = join(repoDir, "packages", "sub");
      await mkdir(subDir, { recursive: true });

      await runCommand("git", ["init", "-q"], { cwd: repoDir, timeout: 5000 });
      await runCommand("git", ["config", "user.name", "test"], { cwd: repoDir, timeout: 5000 });
      await runCommand("git", ["config", "user.email", "test@test.com"], { cwd: repoDir, timeout: 5000 });

      const trackedFile = join(subDir, "tracked.txt");
      await writeFile(trackedFile, "initial content\n");
      await runCommand("git", ["add", "."], { cwd: repoDir, timeout: 5000 });
      await runCommand("git", ["commit", "-qm", "initial"], { cwd: repoDir, timeout: 5000 });

      const gwSub = new Gateway({ allowedUserId: "1", botToken: "1:x", stateDir: tmpdir(), cwd: subDir });
      gwSub.telegram.answer = async () => {};
      gwSub.telegram.edit = async () => {};
      const subSession = new ChatSession(gwSub, { threadId: 401, cwd: subDir });
      subSession.pi.request = async () => ({});

      const snapObj = await subSession.takeRunSnapshot();
      assert.ok(snapObj?.git?.snap, "Snapshot must have snap commit");
      const realRepoDir = await realpath(repoDir);
      assert.equal(snapObj?.git?.toplevel, realRepoDir, "toplevel must resolve to repo root");

      await writeFile(trackedFile, "modified content\n");
      const newUntrackedFile = join(subDir, "new-sub.txt");
      await writeFile(newUntrackedFile, "hello from subdir\n");

      const diffNumstat = await runCommand("git", ["diff", "-z", "--numstat", snapObj.git.snap], { cwd: snapObj.git.toplevel, timeout: 5000 });
      const parsedTracked = parseNumstat(diffNumstat);
      assert.deepEqual(parsedTracked, [{ path: "packages/sub/tracked.txt", added: 1, deleted: 1, binary: false }]);

      const untrackedRaw = await runCommand("git", ["ls-files", "-z", "--others", "--exclude-standard"], { cwd: snapObj.git.toplevel, timeout: 5000 });
      const currentUntracked = untrackedRaw.split("\0").filter(Boolean);
      const newUntracked = currentUntracked.filter((f) => !snapObj.git.untracked.has(f));
      assert.deepEqual(newUntracked, ["packages/sub/new-sub.txt"]);

      let replySent = "";
      subSession.send = async (t) => { replySent = t; };
      const undoAction = {
        type: "run_undo",
        toplevel: snapObj.git.toplevel,
        snap: snapObj.git.snap,
        trackedFiles: ["packages/sub/tracked.txt"],
        untrackedFiles: ["packages/sub/new-sub.txt"],
        confirmed: true,
      };
      await subSession.handleCallbackAction(undoAction, { id: "cb-undo" });

      const contentAfterUndo = await readFile(trackedFile, "utf8");
      assert.equal(contentAfterUndo, "initial content\n", "tracked file must be restored");
      assert.equal(existsSync(newUntrackedFile), false, "untracked file in subdir must be deleted");
      assert.ok(replySent.includes("Restored 2 file(s)"));
    }
  }

  assert.ok(HELP.includes("/topic") && BOT_COMMANDS.some((c) => c.command === "topic"), "/topic registered");
  assert.ok(HELP.includes("/close") && BOT_COMMANDS.some((c) => c.command === "close"), "/close registered");

  // shell single-quote helper
  {
    assert.equal(shellQuote("/path/to/project"), "'/path/to/project'");
    assert.equal(shellQuote("/path/to/it's project"), "'/path/to/it'\\''s project'");
    assert.equal(shellQuote("foo'bar'baz"), "'foo'\\''bar'\\''baz'");
  }

  // Native session filter: encoded directory layout returns only sessions for the requested cwd.
  {
    const tmpDesktopDir = join(tmpdir(), `test-desktop-sessions-${Date.now()}`);
    const matchDir = encodeCwdSessionDir(tmpDesktopDir, "/test/my-project");
    const otherDir = encodeCwdSessionDir(tmpDesktopDir, "/test/other-project");
    await mkdir(matchDir, { recursive: true, mode: 0o700 });
    await mkdir(otherDir, { recursive: true, mode: 0o700 });

    const matchFile = join(matchDir, "match.jsonl");
    const otherFile = join(otherDir, "other.jsonl");

    await writeFile(matchFile, [
      JSON.stringify({ type: "session", version: 3, id: "s1", timestamp: "2026-10-19T00:00:00Z", cwd: "/test/my-project" }),
      JSON.stringify({ type: "message", id: "m1", message: { role: "user", content: "Hello from matching session" } }),
    ].join("\n") + "\n");

    await writeFile(otherFile, [
      JSON.stringify({ type: "session", version: 3, id: "s2", timestamp: "2026-10-19T00:00:00Z", cwd: "/test/other-project" }),
      JSON.stringify({ type: "message", id: "m2", message: { role: "user", content: "Hello from other session" } }),
    ].join("\n") + "\n");

    const matched = await scanDesktopSessions(tmpDesktopDir, "/test/my-project", 10);
    assert.equal(matched.length, 1, "Only matching cwd session should be returned");
    assert.equal(matched[0].path, matchFile);
    assert.equal(matched[0].id, "s1");
    assert.equal(matched[0].title, "Hello from matching session");

    const notFound = await scanDesktopSessions(tmpDesktopDir, "/test/nonexistent", 10);
    assert.deepEqual(notFound, []);
  }

  // startHerdrWatcher idempotency & late start
  {
    const gwWatcher = new Gateway({ allowedUserId: "1", botToken: "1:x", stateDir: tmpdir(), cwd: tmpdir() });
    assert.equal(gwWatcher.herdrWatcher, null);
    gwWatcher.startHerdrWatcher();
    assert.equal(gwWatcher.herdrWatcher, null, "Watcher must not start without herdrEnv");

    gwWatcher.mainSession.pi.herdrEnv = { HERDR_BIN_PATH: "/bin/echo", HERDR_SOCKET_PATH: "/tmp/fake.sock" };
    gwWatcher.startHerdrWatcher();
    assert.ok(gwWatcher.herdrWatcher, "HerdrWatcher must start once env is available");
    const watcherInstance = gwWatcher.herdrWatcher;
    gwWatcher.startHerdrWatcher();
    assert.equal(gwWatcher.herdrWatcher, watcherInstance, "startHerdrWatcher must be idempotent");
    gwWatcher.herdrWatcher.stop();
  }

  // Herdr pane ownership: resolveHerdrEnvironment
  {
    // 1. Never picks a pane by cwd match; creates new workspace
    const commandsRun = [];
    const mockRunner = async (bin, args) => {
      commandsRun.push([bin, ...args]);
      if (args[0] === "which") return "/usr/local/bin/herdr";
      if (args[0] === "status" && args[1] === "server") return JSON.stringify({ running: true, socket: "/tmp/mock.sock" });
      if (args[0] === "pane" && args[1] === "list") {
        return JSON.stringify({ result: { panes: [{ pane_id: "w1:p1", cwd: "/test/cwd", workspace_id: "w1", tab_id: "t1" }] } });
      }
      if (args[0] === "workspace" && args[1] === "create") {
        return JSON.stringify({ result: { workspace: { workspace_id: "w_new" }, tab: { tab_id: "t_new" }, root_pane: { pane_id: "p_new" } } });
      }
      throw new Error(`Unexpected command: ${args.join(" ")}`);
    };

    const env = await resolveHerdrEnvironment("/test/cwd", { runCmd: mockRunner });
    assert.equal(env.HERDR_PANE_ID, "p_new", "Must create new workspace, never pick from pane list by cwd");
    const createCmd = commandsRun.find((c) => c[1] === "workspace" && c[2] === "create");
    assert.equal(createCmd?.[createCmd.indexOf("--label") + 1], "cwd", "Workspace label is the bare cwd name, no 📱 prefix");
    assert.ok(!commandsRun.some((c) => c[1] === "pane" && c[2] === "list"), "Must never call pane list to match cwd");

    // 2. Reuses persisted pane if it still exists
    commandsRun.length = 0;
    const mockRunnerPersisted = async (bin, args) => {
      commandsRun.push([bin, ...args]);
      if (args[0] === "which") return "/usr/local/bin/herdr";
      if (args[0] === "status" && args[1] === "server") return JSON.stringify({ running: true, socket: "/tmp/mock.sock" });
      if (args[0] === "pane" && args[1] === "get" && args[2] === "p_saved") {
        return JSON.stringify({ result: { pane: { pane_id: "p_saved", workspace_id: "w_saved", tab_id: "t_saved", cwd: "/test/cwd" } } });
      }
      throw new Error(`Unexpected command: ${args.join(" ")}`);
    };
    const envPersisted = await resolveHerdrEnvironment("/test/cwd", { persistedPaneId: "p_saved", runCmd: mockRunnerPersisted });
    assert.equal(envPersisted.HERDR_PANE_ID, "p_saved", "Must reuse persisted pane if it exists");
    assert.ok(!commandsRun.some((c) => c[1] === "workspace" && c[2] === "create"), "Must not create workspace when persisted pane is reused");

    // 3. Fallback to new workspace if persisted pane is gone
    commandsRun.length = 0;
    const mockRunnerGone = async (bin, args) => {
      commandsRun.push([bin, ...args]);
      if (args[0] === "which") return "/usr/local/bin/herdr";
      if (args[0] === "status" && args[1] === "server") return JSON.stringify({ running: true, socket: "/tmp/mock.sock" });
      if (args[0] === "pane" && args[1] === "get") {
        throw new Error("pane not found");
      }
      if (args[0] === "workspace" && args[1] === "create") {
        return JSON.stringify({ result: { workspace: { workspace_id: "w_fallback" }, tab: { tab_id: "t_fallback" }, root_pane: { pane_id: "p_fallback" } } });
      }
      throw new Error(`Unexpected command: ${args.join(" ")}`);
    };
    const envFallback = await resolveHerdrEnvironment("/test/cwd", { persistedPaneId: "p_gone", runCmd: mockRunnerGone });
    assert.equal(envFallback.HERDR_PANE_ID, "p_fallback", "Must create new workspace if persisted pane not found");
  }

  // 3. Session-file resolution prefers agent_session.path, falls back to tokens.remote_pi_session
  {
    const withKind = {
      agent_session: { kind: "path", value: "/path/from/kind.jsonl" },
      tokens: { remote_pi_session: "/path/from/tokens.jsonl" },
    };
    assert.equal(resolveAgentSessionFile(withKind), "/path/from/kind.jsonl");

    const withPath = {
      agent_session: { path: "/path/from/path.jsonl" },
      tokens: { remote_pi_session: "/path/from/tokens.jsonl" },
    };
    assert.equal(resolveAgentSessionFile(withPath), "/path/from/path.jsonl");

    const withTokensOnly = {
      tokens: { remote_pi_session: "/path/from/tokens.jsonl" },
    };
    assert.equal(resolveAgentSessionFile(withTokensOnly), "/path/from/tokens.jsonl");

    assert.equal(resolveAgentSessionFile({}), null);
  }

  // Every topic routes through a native PaneRpc ChatSession.
  {
    const tmpStateDir = join(tmpdir(), `test-dispatch-state-${Date.now()}`);
    await mkdir(tmpStateDir, { recursive: true });
    const gw = new Gateway({
      botToken: "fake:token",
      allowedUserId: "42",
      stateDir: tmpStateDir,
      cwd: tmpStateDir,
    });
    gw.handleUpdate = async () => {};
    gw.telegram = {
      call: async () => ({}),
      send: async () => ({ message_id: 1 }),
      sendOne: async () => ({ message_id: 1 }),
      setReaction: () => {},
    };

    // Message in the first topic
    await gw.dispatchUpdate({
      message: {
        message_id: 10,
        message_thread_id: 501,
        text: "hello desktop",
        from: { id: 42 },
        chat: { type: "private" },
      },
    });
    assert.ok(gw.sessions.get("t:501").pi instanceof PaneRpc, "All topics use PaneRpc");

    // Message in another topic
    await gw.dispatchUpdate({
      message: {
        message_id: 11,
        message_thread_id: 601,
        text: "normal topic message",
        from: { id: 42 },
        chat: { type: "private" },
      },
    });
    assert.equal(gw.sessions.has("t:601"), true, "ChatSession MUST be created for normal topic");
    await gw.saveState({});
    await rm(tmpStateDir, { recursive: true, force: true }).catch(() => {});
  }

  // Command discovery and routing use the current session, never cached main-view aliases.
  {
    const gw = new Gateway({ allowedUserId: "1", botToken: "1:x", stateDir: tmpdir() });
    const main = gw.mainSession;
    main.pi.proc = {};
    let commands = [
      ...["name", "upgrade", "start", "commands", "status"].map((name) => ({ name, source: "prompt", description: `Custom ${name}` })),
      { name: "foo-bar", source: "extension" }, { name: "foo_bar", source: "prompt" },
      { name: `${"a".repeat(32)}-one`, source: "prompt" }, { name: `${"a".repeat(32)}-two`, source: "prompt" },
      { name: "skill:check-a", source: "skill" }, { name: "skill_check_a", source: "extension" },
      { name: "git-review", source: "extension", description: "Review changes" },
    ];
    main.pi.request = async (type) => { assert.equal(type, "get_commands"); return { commands }; };
    const menus = [];
    gw.telegram.call = async (method, params) => { assert.equal(method, "setMyCommands"); menus.push(params); };
    await gw.registerBotCommands();
    assert.equal(menus.length, 2, "register default and private-chat scopes");
    for (const { commands: menu } of menus) {
      for (const name of ["name", "upgrade", "start", "commands", "foo_bar", "a".repeat(32), "skill_check_a"]) {
        assert.ok(!menu.some((c) => c.command === name), `${name} is reserved or ambiguous, not a menu command`);
      }
      assert.equal(menu.find((c) => c.command === "status").description, "Session status, tokens & cost");
      assert.ok(menu.some((c) => c.command === "git_review"));
    }
    const handled = [...ChatSession.prototype.handleCommand.toString().matchAll(/case "([^"]+)":/g)].map((m) => m[1]);
    assert.deepEqual([...RESERVED_COMMANDS].sort(), [...new Set(handled)].sort(), "reserve all gateway commands, including hidden commands and aliases");
    const sent = [];
    const prompts = [];
    main.send = async (text) => { sent.push(text); };
    main.prompt = async (text) => { prompts.push(text); };
    const run = (session, text) => session.handleCommand(parseCommand(text), text);
    for (const name of ["foo_bar", "a".repeat(32), "skill_check_a"]) {
      await run(main, `/${name}`);
      assert.match(sent.at(-1), /Ambiguous command/);
    }
    assert.deepEqual(prompts, [], "ambiguous commands never reach Pi");
    await main.showCommands();
    assert.match(sent.at(-1), /gateway-reserved/);
    assert.match(sent.at(-1), /ambiguous/);
    await run(main, "/foo-bar argument");
    assert.equal(prompts.at(-1), "/foo-bar argument", "unambiguous native spelling still works");
    await run(main, "/skill-check-a focus");
    assert.equal(prompts.at(-1), "/skill:check-a focus", "legacy skill spelling still works");
    await run(main, "/git_review@my_bot Keep CASE");
    assert.equal(prompts.at(-1), "/git-review Keep CASE");
    await run(main, "/git_commit_push");
    assert.equal(prompts.at(-1), "/git-commit-push");
    await run(main, "/git_commit_push extra instructions");
    assert.equal(prompts.at(-1), "/git-commit-push extra instructions");
    await run(main, "/git-commit-push extra instructions");
    assert.equal(prompts.at(-1), "/git-commit-push extra instructions");
    const topic = new ChatSession(gw, { threadId: 123, cwd: tmpdir() });
    topic.pi.proc = {};
    topic.pi.request = async (type) => { assert.equal(type, "get_commands"); return { commands: [{ name: "git_review", source: "prompt" }, { name: "skill:topic-only", source: "skill" }] }; };
    topic.send = main.send;
    topic.prompt = main.prompt;
    await run(topic, "/git_review");
    assert.equal(prompts.at(-1), "/git_review", "topic resolves its own command, not the main view's alias");
    await run(topic, "/skill_topic_only");
    assert.equal(prompts.at(-1), "/skill:topic-only", "topic-only skills work without main-view registration");
    const topicCount = prompts.length;
    await run(topic, "/foo-bar");
    assert.match(sent.at(-1), /Unknown command/);
    assert.equal(prompts.length, topicCount, "main-only commands do not leak into a topic");
    commands = [{ name: "foo-bar", source: "extension" }];
    await run(main, "/foo_bar");
    assert.equal(prompts.at(-1), "/foo-bar", "removing one conflicting command immediately restores unambiguous routing");
    await gw.registerBotCommands();
    assert.ok(menus.at(-1).commands.some((c) => c.command === "foo_bar"), "resolved conflicts return to the menu on refresh");
    commands = [{ name: "git_review", source: "prompt" }];
    await gw.registerBotCommands();
    await run(main, "/git_review");
    assert.equal(prompts.at(-1), "/git_review", "refresh does not retain an obsolete alias");
    commands = [];
    const count = prompts.length;
    await run(main, "/git_review");
    assert.match(sent.at(-1), /Unknown command/);
    assert.equal(prompts.length, count, "removed commands never become model prompts");
    await gw.registerBotCommands();
    assert.ok(!menus.at(-1).commands.some((c) => c.command === "git_review"), "removed commands leave the menu on refresh");
  }

  // Help includes native Pi commands only when available.
  {
    const gwHelp = new Gateway({ allowedUserId: "1", botToken: "1:x", stateDir: tmpdir() });
    const sess = gwHelp.mainSession;
    sess.pi.proc = {};
    const sent = [];
    sess.send = async (text) => { sent.push(text); };
    let commands = [
      { name: "review", description: "Review changes", source: "extension" },
      { name: "summarize", source: "prompt" },
      { name: "skill:check", description: "Run checks", source: "skill" },
    ];
    sess.pi.request = async (type) => {
      assert.equal(type, "get_commands");
      assert.equal(sent.at(-1), HELP, "help sent before command discovery");
      return { commands };
    };
    for (const name of ["help", "commands"]) {
      sent.length = 0;
      await sess.handleCommand({ name, argument: "" }, `/${name}`);
      assert.deepEqual(sent, [HELP, "/review — Review changes\n/summarize\n/skill:check — Run checks"]);
    }
    commands = [];
    sent.length = 0;
    await sess.handleCommand({ name: "help", argument: "" }, "/help");
    assert.deepEqual(sent, [HELP], "no empty command-list notice");
    sess.pi.request = async () => { assert.fail("static help must not start Pi"); };
    sent.length = 0;
    await sess.handleCommand({ name: "start", argument: "" }, "/start");
    assert.deepEqual(sent, [HELP]);
    sess.pi.proc = null;
    sent.length = 0;
    await sess.handleCommand({ name: "help", argument: "" }, "/help");
    assert.deepEqual(sent, [HELP], "help stays available after Pi exits without restarting it");
  }

  // Abort preserves both queues; queue clear removes them through native RPC.
  {
    const gwQueue = new Gateway({ allowedUserId: "1", botToken: "1:x", stateDir: tmpdir() });
    const sess = gwQueue.mainSession;
    const sent = [];
    const calls = [];
    sess.send = async (text) => { sent.push(text); };
    sess.pi.request = async (type) => {
      calls.push(type);
      return { steering: ["steer"], followUp: ["follow"] };
    };
    for (const proc of [null, {}]) {
      sess.pi.proc = proc;
      const queue = { steering: ["steer"], followUp: ["follow"] };
      sess.queue = queue;
      calls.length = 0;
      await sess.handleCommand({ name: "abort", argument: "" }, "/abort");
      assert.equal(sess.queue, queue, "abort keeps queued messages");
      assert.deepEqual(calls, proc ? ["abort"] : []);
      assert.ok(sent.at(-1).includes("use /queue clear to clear"));
      await sess.handleCommand({ name: "queue", argument: "clear" }, "/queue clear");
      assert.deepEqual(sess.queue, { steering: [], followUp: [] });
      assert.deepEqual(calls, proc ? ["abort", "clear_queue"] : []);
      assert.equal(sent.at(-1), proc ? "Cleared\nsteering: 1\nfollow-up: 1" : "Cleared\nsteering: 0\nfollow-up: 0");
    }
  }

  // 11. Command with bot-suffix in parseCommand
  {
    assert.equal(parseCommand("/status@my_bot")?.name, "status");
    assert.equal(parseCommand("/abort@my_bot")?.name, "abort");
    assert.equal(parseCommand("/close@my_bot")?.name, "close");
    assert.equal(parseCommand("/status@my_bot arg")?.argument, "arg");
  }

  // 12. 回归：/compact、/sh 在 RPC 报 abort 错误时不得 fall-through 到下一个 case
  {
    const gwAbort2 = new Gateway({ allowedUserId: "1", botToken: "1:x", stateDir: tmpdir() });
    const sess = gwAbort2.mainSession;
    let exported = 0;
    const sent = [];
    sess.sendDocument = async () => { exported++; return { message_id: 1 }; };
    sess.send = async (t) => { sent.push(t); return { message_id: 1 }; };
    sess.pi.request = async (cmd) => {
      if (cmd === "compact" || cmd === "bash") throw new Error("Pi aborted the current run");
      if (cmd === "export_html") { exported++; return { path: "/tmp/x.html" }; }
      return {};
    };
    await sess.handleCommand({ name: "compact", argument: "" }, "/compact");
    assert.equal(exported, 0, "/compact abort 后不得 fall-through 到 /export");
    await sess.handleCommand({ name: "sh", argument: "echo hi" }, "/sh echo hi");
    assert.equal(exported, 0, "/sh abort 后不得 fall-through 到 /get 发送附件");
    assert.ok(!sent.some((t) => t.includes("File missing")), "/sh abort 后不得 fall-through 到 /get");
  }

  // 13. 回归：并发 saveState 全部成功落盘且最终文件包含全部键
  {
    const tmpStateDir = join(tmpdir(), `test-save-state-${Date.now()}`);
    await mkdir(tmpStateDir, { recursive: true });
    const gwSave = new Gateway({ allowedUserId: "1", botToken: "1:x", stateDir: tmpStateDir });
    await Promise.all([
      gwSave.saveState({ cwd: "/a" }),
      gwSave.saveState({ recentProjects: ["/a"] }),
      gwSave.saveState({ topics: { 1: { cwd: "/a" } } }),
      gwSave.saveState({ herdrPanes: { main: "p1" } }),
    ]);
    const final = JSON.parse(readFileSync(join(tmpStateDir, "state.json"), "utf8"));
    assert.equal(final.cwd, "/a");
    assert.deepEqual(final.recentProjects, ["/a"]);
    assert.deepEqual(final.topics, { 1: { cwd: "/a" } });
    assert.deepEqual(final.herdrPanes, { main: "p1" });
    await rm(tmpStateDir, { recursive: true, force: true }).catch(() => {});
  }

  // 14. 回归：runCommand 多字节字符跨 chunk 分割不损坏
  {
    const out = await runCommand(process.execPath, ["-e", "const b = Buffer.from('中文测试', 'utf8'); process.stdout.write(b.subarray(0, 1)); await new Promise(r => setTimeout(r, 20)); process.stdout.write(b.subarray(1));"]);
    assert.equal(out, "中文测试");
  }

  // Numeric configuration rejects invalid values and preserves zero.
  {
    assert.equal(parseNumberConfig(undefined, undefined, 30, { min: 0 }), 30);
    assert.equal(parseNumberConfig("0", undefined, 30, { min: 0 }), 0);
    assert.equal(parseNumberConfig(undefined, 0, 30, { min: 0 }), 0);
    assert.equal(parseNumberConfig("abc", undefined, 4, { min: 1, integer: true }), 4);
    assert.equal(parseNumberConfig(undefined, "abc", 4, { min: 1, integer: true }), 4);
    assert.equal(parseNumberConfig("2.5", undefined, 4, { min: 1, integer: true }), 4);
    assert.equal(parseNumberConfig("8", undefined, 4, { min: 1, integer: true }), 8);
    assert.equal(parseNumberConfig("0", undefined, 30, { min: 0 }), 0);
  }

  // 16. 回归：send 与 sendOne 背靠背投递保序（sendOne 纳入输出队列）
  {
    const gwSendOne = new Gateway({ allowedUserId: "1", botToken: "1:x", stateDir: tmpdir() });
    const order = [];
    gwSendOne.telegram.call = async (method, body = {}) => {
      if (method === "sendMessage") order.push(body.text);
      return { message_id: order.length };
    };
    const p1 = gwSendOne.telegram.sendOne("1", "first-sendOne");
    const p2 = gwSendOne.telegram.send("1", "second-send");
    await Promise.all([p1, p2]);
    assert.deepEqual(order, ["first-sendOne", "second-send"], "sendOne 应与 send 一样走输出队列且保持顺序");
  }

  // 17. 回归：未授权的 Topic 消息不创建会话/状态/回复
  {
    const tmpAuthDir = join(tmpdir(), `test-auth-${Date.now()}`);
    await mkdir(tmpAuthDir, { recursive: true, mode: 0o700 });
    const gwAuth = new Gateway({ allowedUserId: "1", botToken: "1:x", stateDir: tmpAuthDir });
    const sends = [];
    gwAuth.telegram.send = async (...args) => { sends.push(args); };
    gwAuth.telegram.call = async (...args) => { sends.push(args); };
    await gwAuth.dispatchUpdate({
      update_id: 999,
      message: {
        message_id: 1,
        from: { id: 2 },
        chat: { id: 2, type: "private" },
        message_thread_id: 777,
        is_topic_message: true,
        text: "hello from intruder",
      },
    });
    assert.equal(gwAuth.sessions.has("t:777"), false);
    assert.equal(gwAuth.state.topics?.[777], undefined);
    assert.equal(sends.length, 0);

    // Also verify callback_query from non-allowed user is dropped without session lookup
    await gwAuth.dispatchUpdate({
      update_id: 1000,
      callback_query: {
        id: "cq-1",
        from: { id: 2 },
        message: { chat: { id: 2, type: "private" } },
        data: "some_data",
      },
    });
    assert.equal(sends.length, 0);
    await rm(tmpAuthDir, { recursive: true, force: true }).catch(() => {});
  }

  // 18. 回归：启动时收紧日志与状态目录权限
  {
    const tmpPermDir = join(tmpdir(), `test-perm-${Date.now()}`);
    const stateDir = join(tmpPermDir, "state");
    const dlDir = join(tmpPermDir, "dl");
    const logFile = join(tmpPermDir, "test.log");
    await mkdir(stateDir, { recursive: true, mode: 0o755 });
    await mkdir(dlDir, { recursive: true, mode: 0o755 });
    await writeFile(logFile, "log data", { mode: 0o644 });

    const gw = new Gateway({
      allowedUserId: "1",
      botToken: "1:x",
      stateDir,
      downloadsDir: dlDir,
      logFile,
    });
    await assert.rejects(
      () => gw.start(),
      /Self-test cannot start the gateway/,
      "start() 应在完成权限收紧与锁获取后于自测模式下抛出"
    );

    assert.equal((await stat(logFile)).mode & 0o777, 0o600);
    assert.equal((await stat(stateDir)).mode & 0o777, 0o700);
    assert.equal((await stat(dlDir)).mode & 0o777, 0o700);

    gw.stop();
    await rm(tmpPermDir, { recursive: true, force: true }).catch(() => {});
  }

  // 19. Desk presence & origin-based notification muting
  {
    const tmpDir = join(tmpdir(), `test-desk-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true, mode: 0o700 });
    const presencePath = join(tmpDir, "presence-marker");
    const gw = new Gateway({ allowedUserId: "1", botToken: "1:x", stateDir: tmpDir, cwd: tmpDir, presenceFile: presencePath, doneCard: true });
    gw.chatReady = true;
    const sess = gw.mainSession;
    const sentCalls = [];
    sess.send = async (text, extra = {}) => { sentCalls.push({ text, extra }); return { message_id: sentCalls.length }; };
    sess.pi.request = async () => ({ cost: 0 });

    // 1. Terminal-originated run via remote_user_input
    await sess.handleEvent({ type: "remote_user_input", text: "term cmd" });
    assert.equal(sess.runOrigin, "terminal");
    assert.equal(sentCalls.at(-1)?.extra?.disable_notification, true, "terminal echo is silent");

    // Settles with reply: card is sent with disable_notification: true
    sess.repliedInRun = true;
    let cardPromise;
    const origSendRunCard = sess.sendRunCard.bind(sess);
    sess.sendRunCard = (...args) => (cardPromise = origSendRunCard(...args));
    await sess.handleEvent({ type: "agent_settled" });
    await cardPromise;
    assert.equal(sentCalls.at(-1)?.extra?.disable_notification, true, "terminal-originated run card is silent");
    assert.equal(sess.runOrigin, "telegram", "runOrigin resets to telegram");

    // 2. Terminal-originated run with no text reply -> error message is silent
    await sess.handleEvent({ type: "remote_user_input", text: "empty prompt" });
    sess.repliedInRun = false;
    sess.abortedRun = false;
    await sess.handleEvent({ type: "agent_settled" });
    await gw.telegramChain;
    assert.equal(sentCalls.at(-1)?.extra?.disable_notification, true, "terminal empty-reply error is silent");

    // 3. Telegram-originated run -> card is notified
    sess.pi.request = async (cmd) => { if (cmd === "prompt") return {}; return { cost: 0 }; };
    await sess.prompt("tg prompt");
    assert.equal(sess.runOrigin, "telegram");
    sess.repliedInRun = true;
    sess.sendRunCard = (...args) => (cardPromise = origSendRunCard(...args));
    await sess.handleEvent({ type: "agent_settled" });
    await cardPromise;
    assert.equal(sentCalls.at(-1)?.extra?.disable_notification, undefined, "telegram-originated run card notifies");

    // 4. presenceFile exists -> telegram run card, error, and blocked alert are silent
    assert.equal(gw.isUserPresent(), false);
    await writeFile(presencePath, "here");
    assert.equal(gw.isUserPresent(), true);

    await sess.prompt("tg prompt with presence");
    sess.repliedInRun = true;
    sess.sendRunCard = (...args) => (cardPromise = origSendRunCard(...args));
    await sess.handleEvent({ type: "agent_settled" });
    await cardPromise;
    assert.equal(sentCalls.at(-1)?.extra?.disable_notification, true, "presenceFile silences telegram run card");

    // Herdr blocked alert with presence
    gw.herdrWatcher = {
      cli: async () => "screen content",
      label: () => "agent-1",
    };
    gw.telegram.send = async (chatId, text, extra = {}) => { sentCalls.push({ text, extra }); return { message_id: sentCalls.length }; };
    await gw.sendHerdrAgent("w1:p1", "blocked", { terminal_title_stripped: "Agent" });
    assert.equal(sentCalls.at(-1)?.extra?.disable_notification, true, "presenceFile silences Herdr blocked alerts");

    // Presence removed -> notifies again
    await unlink(presencePath);
    assert.equal(gw.isUserPresent(), false);
    await sess.prompt("tg prompt without presence");
    sess.repliedInRun = true;
    sess.sendRunCard = (...args) => (cardPromise = origSendRunCard(...args));
    await sess.handleEvent({ type: "agent_settled" });
    await cardPromise;
    assert.equal(sentCalls.at(-1)?.extra?.disable_notification, undefined, "cleared presence notifies run card");

    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }

  // 20. Attach backfill, topic naming, and session rename sync
  {
    const tmpDir = join(tmpdir(), `test-topic-naming-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true, mode: 0o700 });
    const gw = new Gateway({ allowedUserId: "1", botToken: "1:x", stateDir: tmpDir, cwd: tmpDir });
    gw.chatReady = true;
    gw.me = { has_topics_enabled: true };

    const tgCalls = [];
    gw.telegram.call = async (method, params) => {
      tgCalls.push({ method, params });
      if (method === "createForumTopic") return { message_thread_id: 101 };
      return true;
    };
    const sent = [];
    gw.telegram.send = async (chat, text, extra = {}) => { sent.push({ text, extra }); return { message_id: sent.length }; };

    // 1. onPaneHello creates topic with sessionName and sends silent preview message
    await gw.onPaneHello({
      socket: { write: () => true },
      clients: new Set(),
      hello: {
        paneId: "w1:p-attach",
        cwd: tmpDir,
        sessionFile: join(tmpDir, "s.jsonl"),
        sessionName: "refactor-auth",
        recent: {
          firstUserText: "first prompt",
          lastUserText: "how does auth work?",
          lastAssistantText: "Auth uses JWT tokens.",
        },
      },
    });

    const createCall = tgCalls.find((c) => c.method === "createForumTopic");
    assert.equal(createCall?.params?.name, "📡 refactor-auth", "topic named with sessionName");
    const preview = sent.find((s) => s.text.includes("👤 how does auth work?"));
    assert.ok(preview, "recent context preview sent");
    assert.ok(preview.text.includes("🤖 Auth uses JWT tokens."));
    assert.equal(preview.extra.disable_notification, true, "preview sent silently");

    // 2. session_info_changed updates topic name and prevents double-rename/loop
    const topicSession = gw.sessions.get("t:101");
    assert.ok(topicSession, "topic session registered");
    assert.equal(topicSession.lastTopicName, "📡 refactor-auth");

    tgCalls.length = 0;
    await topicSession.handleEvent({ type: "session_info_changed", name: "v2-auth" });
    const editCall = tgCalls.find((c) => c.method === "editForumTopic");
    assert.equal(editCall?.params?.name, "📡 v2-auth", "editForumTopic called with prefix + new name");
    assert.equal(topicSession.lastTopicName, "📡 v2-auth");

    // Same event again -> no editForumTopic call
    tgCalls.length = 0;
    await topicSession.handleEvent({ type: "session_info_changed", name: "v2-auth" });
    assert.equal(tgCalls.filter((c) => c.method === "editForumTopic").length, 0, "dedupes same name without loop");

    // 3. Fallback naming when sessionName is empty: uses firstUserText
    tgCalls.length = 0;
    sent.length = 0;
    await gw.onPaneHello({
      socket: { write: () => true },
      clients: new Set(),
      hello: {
        paneId: "w1:p-fallback",
        cwd: tmpDir,
        sessionFile: join(tmpDir, "s2.jsonl"),
        recent: {
          firstUserText: "Initial task description",
        },
      },
    });
    const fallbackCall = tgCalls.find((c) => c.method === "createForumTopic");
    assert.equal(fallbackCall?.params?.name, "📡 Initial task description", "fallback to firstUserText");

    // 4. Topic session created via /topic (owned: true) renames without 📡 prefix
    const topicOwned = new ChatSession(gw, { threadId: 202, cwd: tmpDir });
    topicOwned.binding = { paneId: "w1:p-owned", sessionFile: join(tmpDir, "s3.jsonl"), cwd: tmpDir, owned: true };
    topicOwned.lastTopicName = "topic-orig";
    gw.sessions.set("t:202", topicOwned);

    tgCalls.length = 0;
    await topicOwned.handleEvent({ type: "session_info_changed", name: "owned-renamed" });
    const ownedEdit = tgCalls.find((c) => c.method === "editForumTopic");
    assert.equal(ownedEdit?.params?.name, "owned-renamed", "owned topic renames without prefix");

    // 5. Backfill when final assistant entry is tool-call-only: still shows earlier assistant text
    tgCalls.length = 0;
    sent.length = 0;
    await gw.onPaneHello({
      socket: { write: () => true },
      clients: new Set(),
      hello: {
        paneId: "w1:p-toolcall",
        cwd: tmpDir,
        sessionFile: join(tmpDir, "s-tool.jsonl"),
        sessionName: "tool-session",
        recent: {
          firstUserText: "write tests",
          lastUserText: "run tests",
          lastAssistantText: "All 12 tests passed.",
        },
      },
    });
    const toolPreview = sent.find((s) => s.text.includes("🤖 All 12 tests passed."));
    assert.ok(toolPreview, "backfill displays earlier assistant text even when last entry in session was tool-call-only");

    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }

  console.log("self-test: ok");
  } finally {
    globalThis.fetch = origGlobalFetch;
    net.connect = origNetConnect;
    net.createConnection = origNetCreateConnection;
    setTestMode(false);
  }
}

export { selfTest, selfTestPaneBridge };

if (import.meta.main) {
  await selfTest();
}
