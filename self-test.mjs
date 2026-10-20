import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, readFile, readlink, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
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
  MAX_MESSAGE,
  PaneRpc,
  RESERVED_COMMANDS,
  Telegram,
  attachmentPrompt,
  buildDevPath,
  chunks,
  expandableBlockquote,
  extensionFromMime,
  extractText,
  formatAssistantError,
  formatContextTokens,
  formatSessionReset,
  herdrTail,
  isConnectPhaseError,
  loadConfig,
  loadState,
  paneHasForegroundShell,
  parseCommand,
  pollBackoffMs,
  resolveAgentSessionFile,
  resolveHerdrEnvironment,
  resolvePath,
  retryableTelegramStatus,
  runCommand,
  runStt,
  sessionKeyOf,
  setTestMode,
  shellQuote,
  shouldRetryTelegram,
  telegramCommandName,
  telegramHtml,
  toolSummary,
} from "./gateway.mjs";

const LINE_BUDGET = 2300;

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
    if (method === "pane.get") return { pane: { tokens } };
    if (method === "pane.report_metadata") {
      metadataCalls.push(params);
      Object.assign(tokens, params.tokens);
      return {};
    }
    if (method === "agent.list") return { agents: [{ pane_id: "w1:p-test", agent: "pi", name: "test-agent" }, ...otherAgents] };
    assert.fail(`Unexpected Herdr call ${method}`);
  };
  const until = async (predicate) => {
    for (let i = 0; i < 300; i++) {
      if (predicate())
        return;
      await sleep(10);
    }
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
    await session.pi.request("abort");
    assert.equal(aborted, 1);
    const { sessions } = await session.pi.request("list_sessions");
    assert.equal(sessions.length, 12);
    assert.equal(sessions[0].title, "Named session");
    assert.equal(sessions[1].title, "a".repeat(60));
    assert.equal(sessions[2].title, "s-12.jsonl");
    assert.equal(sessions[0].path, join(dir, "s-14.jsonl"));
    const originalSend = session.send;
    let picker;
    session.send = async (text, extra) => { picker = { text, extra }; };
    await session.handleCommand({ name: "resume", argument: "" });
    const pick = picker.extra.reply_markup.inline_keyboard[0][0];
    assert.equal(pick.text, "Named session");
    assert.equal(gateway.actions.get(pick.callback_data.slice(2)).path, sessions[0].path);
    session.send = originalSend;
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
    await current.emit("agent_end", { messages: [] });
    await session.eventChain;
    assert.equal(session.isStreaming, true, "agent_end is not the final boundary");
    await current.emit("agent_settled");
    await until(() => !session.isStreaming);
    assert.ok(events.some((e) => e.type === "agent_settled"));
    await current.emit("session_before_compact", { reason: "threshold" });
    await current.emit("session_compact", { reason: "threshold", willRetry: false, compactionEntry: { tokensBefore: 100, summary: "short" } });
    await until(() => events.some((e) => e.type === "compaction_end"));
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
      const config = { allowedUserId: "1", botToken: "1:x", stateDir: dir, cwd: dir };
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
    assert.deepEqual(parseCommand("/name review"), { name: "name", argument: "review" });
    assert.deepEqual(parseCommand("/followup check tests"), { name: "followup", argument: "check tests" });
    assert.equal(parseCommand("hello"), null);
    assert.ok(buildDevPath("/usr/bin:/bin").includes("/opt/homebrew/bin"));
    assert.ok(buildDevPath("/usr/bin:/bin").includes(join(homedir(), ".local", "bin")));
    assert.equal(await runCommand("echo", ["ok"]), "ok");
    assert.deepEqual(await resolveHerdrEnvironment(tmpdir()), {});
    assert.equal(telegramCommandName({ name: "skill:grill-me", source: "skill" }), "skill_grill_me");
    assert.equal(telegramCommandName({ name: `skill:${"a".repeat(40)}`, source: "skill" }).length, 32);
    assert.equal(telegramCommandName({ name: "git-commit-push", source: "extension" }), "git_commit_push");

    // HTTP application errors must not fall through to the network retry policy.
    {
      const originalFetch = globalThis.fetch;
      let requests = 0;
      globalThis.fetch = async () => {
        requests++;
        return { ok: false, status: 400, json: async () => ({ ok: false, description: "bad request" }) };
      };
      try {
        const tg = new Telegram("1:fake", "");
        await assert.rejects(() => tg.call("editMessageText", {}, 1000, 3, null, true), /bad request/);
        assert.equal(requests, 1, "HTTP 400 is not retried, even for an idempotent method");
      } finally { globalThis.fetch = originalFetch; }
    }
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
    assert.equal(formatContextTokens(1048576), "1.0M");
    assert.equal(formatContextTokens(128000), "128K");
    assert.equal(formatContextTokens(8192), "8K");
    assert.equal(formatContextTokens(500), "500");
    assert.equal(extensionFromMime("audio/ogg"), ".ogg");
    assert.equal(extensionFromMime("weird/type"), "");
    assert.ok(attachmentPrompt("check this", [{ path: "/tmp/a b.txt" }]).includes("- /tmp/a b.txt"));
    assert.equal(await runStt("printf %s $1", "/tmp/audio.ogg"), "/tmp/audio.ogg");
    const started = Date.now();
    await assert.rejects(() => runCommand("bash", ["-c", "sleep 2 & wait"], { timeout: 50 }), /timed out/);
    assert.ok(Date.now() - started < 1500, "timeout must reject before a descendant closes inherited stdio");

    {
      const gw = new Gateway({ allowedUserId: "1", botToken: "1:x", stateDir: tmpdir() });
      gw.chatReady = true;
      const calls = [];
      gw.telegram.call = async (method, body) => {
        calls.push({ method, body });
        return { message_id: calls.length };
      };
      const s = gw.mainSession;
      s.pi.request = async () => ({});
      const endMessage = async (text, stopReason = "stop", errorMessage) => s.handleEvent({
        type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], stopReason, errorMessage },
      });
      const start = async (id = 42) => {
        await gw.handleMessage({ message_id: id, text: "hello", from: { id: 1 }, chat: { type: "private" } });
        await s.handleEvent({ type: "agent_start" });
        await s.run.pending;
      };
      const reactions = () => calls.filter((c) => c.method === "setMessageReaction").map((c) => c.body.reaction[0]?.emoji);
      await start();
      assert.deepEqual(reactions(), ["👀", "👨‍💻"]);
      const drafts = () => calls.filter((c) => c.method === "sendMessageDraft");
      assert.equal(drafts()[0].body.text, "");
      const t0 = s.lastDraftAt;
      await s.handleEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "live" } });
      await s.tickRun(t0 + 1499);
      assert.equal(drafts().length, 1);
      await s.tickRun(t0 + 1500);
      assert.equal(drafts().length, 2);
      assert.equal(drafts()[1].body.text, "live");
      await s.tickRun(t0 + 21_499);
      assert.equal(drafts().length, 2);
      await s.tickRun(t0 + 21_500);
      assert.equal(drafts().length, 3, "keepalive after 20s");
      await s.handleEvent({ type: "tool_execution_start", toolName: "bash", args: { command: "echo ok" } });
      await s.tickRun(t0 + 23_000);
      assert.ok(drafts().at(-1).body.text.includes("⚙️ bash"));
      await s.handleEvent({ type: "tool_execution_end", toolName: "bash" });
      assert.equal(s.run.tool, null);
      await endMessage("tool explanation", "toolUse");
      assert.equal(calls.filter((c) => c.method === "sendMessage").at(-1).body.disable_notification, true);
      await endMessage("final");
      assert.equal(calls.filter((c) => c.method === "sendMessage").at(-1).body.disable_notification, false);
      await s.handleEvent({ type: "agent_settled" });
      assert.deepEqual(reactions(), ["👀", "👨‍💻", "👌"]);
      assert.equal(s.run, null);
      calls.length = 0;
      await start(43);
      await endMessage("x".repeat(5000), "error", "Network failure");
      await s.handleEvent({ type: "agent_settled" });
      assert.deepEqual(reactions(), ["👀", "👨‍💻", "💔"]);
      const delivered = calls.filter((c) => c.method === "sendMessage");
      assert.equal(delivered.length, 2);
      assert.equal(delivered[0].body.reply_markup, undefined);
      const button = delivered.at(-1).body.reply_markup.inline_keyboard.flat();
      assert.equal(button.length, 1);
      assert.equal(button[0].text, "🔁 Retry");
      assert.equal(gw.actions.get(button[0].callback_data.slice(2)).type, "retry");
      const rpc = [];
      s.pi.request = async (type, fields) => {
        rpc.push({ type, fields });
        return {};
      };
      await s.handleCallbackAction({ type: "retry" }, {});
      assert.equal(rpc.at(-1).fields.message, "hello");
      for (const aborted of [false, true]) {
        calls.length = 0;
        await start();
        if (aborted) await s.handleCommand({ name: "abort", argument: "" });
        await s.handleEvent({ type: "agent_settled" });
        assert.deepEqual(reactions(), ["👀", "👨‍💻", aborted ? undefined : "🤷"]);
        assert.equal(s.run, null);
      }
      calls.length = 0;
      await s.handleEvent({ type: "remote_user_input", text: "from terminal" });
      await s.handleEvent({ type: "agent_start" });
      await endMessage("terminal final");
      await s.handleEvent({ type: "agent_settled" });
      assert.deepEqual(reactions(), []);
      assert.equal(calls.filter((c) => c.method === "sendMessage").at(-1).body.disable_notification, true);
      gw.isUserPresent = () => true;
      await start();
      await endMessage("desk final");
      assert.equal(calls.filter((c) => c.method === "sendMessage").at(-1).body.disable_notification, true);
      for (const present of [true, false]) {
        gw.isUserPresent = () => present;
        await s.handleUiRequest({ method: "select", id: `q-${present}`, title: "Choose", options: ["A", "B"] });
        assert.equal(calls.filter((c) => c.method === "sendMessage").at(-1).body.disable_notification, present);
      }
      await s.handleEvent({ type: "compaction_end", errorMessage: "failed" });
      assert.equal(calls.filter((c) => c.method === "sendMessage").at(-1).body.disable_notification, true);
      s.stop();

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

      // Only /abort bypasses an in-flight session update.
      let releaseUpdate;
      const blocked = new Promise((resolve) => { releaseUpdate = resolve; });
      const updates = [];
      gw.telegram.react = async () => {};
      const handleCommand = gw.mainSession.handleCommand;
      gw.mainSession.handleCommand = async ({ name }) => { updates.push(`/${name}`); };
      gw.handleUpdate = async (update) => {
        updates.push(update.message.text);
        if (update.message.text !== "/abort") await blocked;
      };
      const slow = gw.dispatchUpdate({ message: { from: { id: 1 }, chat: { type: "private" }, text: "/sh sleep 10" } });
      await sleep(5);
      const queued = gw.dispatchUpdate({ message: { from: { id: 1 }, chat: { type: "private" }, text: "/status" } });
      await gw.dispatchUpdate({ message: { from: { id: 1 }, chat: { type: "private" }, text: "/abort" } });
      assert.deepEqual(updates, ["/sh sleep 10", "/abort"]);
      releaseUpdate();
      await Promise.all([slow, queued]);
      assert.deepEqual(updates, ["/sh sleep 10", "/abort", "/status"]);
      gw.mainSession.handleCommand = handleCommand;

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
      assert.ok(newSessionSent.includes("openai/gpt-4o"));
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

      // verify state persistence without modifying config.json
      const originalCfgContent = readFileSync(validCfgPath, "utf8");
      const gwState = new Gateway({
        allowedUserId: "999",
        botToken: "123456:abcdef",
        configPath: validCfgPath,
        stateDir: tmpCfgDir,
        cwd: tmpCfgDir,
      });
      await gwState.saveState({ cwd: "/target/path" });
      assert.equal(readFileSync(validCfgPath, "utf8"), originalCfgContent, "config.json must remain immutable");
      const loaded = loadState(tmpCfgDir);
      assert.equal(loaded.cwd, "/target/path");
    }

    {
      const tg = new Telegram("123456:fake-token", "/tmp/fake-offset");
      const calls = [];
      tg.call = async (method, body) => {
        calls.push({ method, body });
        return true;
      };
      await tg.react(123, 456, "👀");
      assert.deepEqual(calls[0], {
        method: "setMessageReaction",
        body: { chat_id: 123, message_id: 456, reaction: [{ type: "emoji", emoji: "👀" }] },
      });
      assert.equal(await tg.react(123, 0, "👀"), null);
      assert.equal(calls.length, 1);
    }

    {
      const tmpState = join(tmpdir(), `test-remote-pi-lock-${Date.now()}`);
      await mkdir(tmpState, { recursive: true, mode: 0o700 });

      const gw1 = { config: { stateDir: tmpState }, pidFile: null, lockServer: null, sockPath: null };
      gw1.acquireLock = Gateway.prototype.acquireLock.bind(gw1);
      gw1.stop = Gateway.prototype.stop.bind(gw1);
      gw1.sessions = new Map();

      await gw1.acquireLock();
      assert.equal(existsSync(gw1.sockPath), true);
      assert.equal(readFileSync(gw1.pidFile, "utf8").trim(), String(process.pid));

      const gw2 = { config: { stateDir: tmpState }, pidFile: null, lockServer: null, sockPath: null };
      gw2.acquireLock = Gateway.prototype.acquireLock.bind(gw2);
      gw2.stop = Gateway.prototype.stop.bind(gw2);
      gw2.sessions = new Map();

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
        gwRestart.telegram.react = async () => {};
        let sentMsg = "";
        gwRestart.telegram.send = async (_c, text) => {
          sentMsg = text;
          return { message_id: 42 };
        };
        let origExit = process.exit;
        process.exit = () => {};

        try {
          await gwRestart.dispatchUpdate({ message: { message_id: 10, text: "/restart", from: { id: 1 }, chat: { type: "private" } }, update_id: 888 });
          assert.ok(sentMsg.includes("Restarting gateway"));
          assert.equal(await readFile(gwRestart.telegram.offsetPath, "utf8"), "889");
          await sleep(150);
        } finally { process.exit = origExit; }

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
        const res = await tgLimit.sendOne(1, longText, { message_thread_id: 77, disable_notification: true });
        assert.equal(res.message_id, 99);
        // 超长纯文本被切片为 <=4000 的纯文本分段调用
        assert.ok(calls.length >= 2);
        assert.ok(calls.every((c) => !c.body.parse_mode || c.body.parse_mode === "HTML"));
        assert.ok(calls.every((c) => c.body.message_thread_id === 77 && c.body.disable_notification === true));
      }

      // 回归（架构审查 Issue 4）：MediaGroup 延迟聚合占位并保证后续文本时序
      {
        const gwMedia = new Gateway({ allowedUserId: "1", botToken: "1:x", stateDir: tmpdir() });
        gwMedia.chatReady = true;
        gwMedia.telegram.react = async () => {};
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

      await sleep(80);
      assert.equal(existsSync(join(tmpOffset, "offset")), false, "offset 不应在处理完前落盘");
      release();
      await sleep(80);
      assert.deepEqual(handled, [7]);
      assert.equal(readFileSync(join(tmpOffset, "offset"), "utf8"), "8", "处理完后 offset 应为 update_id+1");
      tg.stopPolling();
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

    // Poll only bound panes; remote_ask suppresses blocked alerts.
    assert.equal(herdrTail("a\nb\nc\n\n\n", 2), "b\nc");
    {
      const gw = new Gateway({ allowedUserId: "1", botToken: "1:x", stateDir: tmpdir() });
      gw.chatReady = true;
      const session = new ChatSession(gw, { threadId: 99, cwd: tmpdir() });
      gw.sessions.set(session.key, session);
      session.binding.paneId = "bound";
      const requests = [], sent = [], calls = [];
      let status = "blocked";
      gw.herdr = async (args) => {
        requests.push(args);
        if (args[0] === "list") return JSON.stringify({ result: { agents: [
          { pane_id: "bound", agent_status: status }, { pane_id: "unbound", agent_status: "blocked" },
        ] } });
        if (args[0] === "read") return "screen";
        if (args[0] === "get") return JSON.stringify({ result: { agent: { agent_status: status } } });
        if (args[0] === "send-keys") return "";
        assert.fail(args);
      };
      gw.telegram.send = async (_chat, text, extra) => {
        sent.push({ text, extra });
        return { message_id: 7 };
      };
      gw.telegram.call = async (...args) => {
        calls.push(args);
        return true;
      };
      gw.telegram.answer = async () => {};
      await gw.pollBlocked();
      assert.equal(requests.length, 0, "no polling while all sessions are idle");
      session.isStreaming = true;
      session.uiMessages = new Map([["q", 1]]);
      await gw.pollBlocked();
      assert.equal(sent.length, 0, "remote_ask owns the buttons");
      status = "working";
      await gw.pollBlocked();
      session.uiMessages.clear();
      status = "blocked";
      await gw.pollBlocked();
      assert.equal(sent.length, 1);
      assert.equal(sent[0].extra.message_thread_id, 99);
      assert.equal(sent[0].extra.disable_notification, false);
      assert.ok(requests.some((a) => a.join(" ") === "read bound --source visible --lines 40"));
      assert.ok(!requests.some((a) => a.includes("unbound")), "never read an unbound pane");
      await gw.pollBlocked();
      assert.equal(sent.length, 1, "blocked transition is deduplicated");
      const button = sent[0].extra.reply_markup.inline_keyboard[0][0];
      status = "idle";
      await gw.handleCallback({ id: "cb", data: button.callback_data, message: { chat: { id: 1 }, message_id: 7 } });
      assert.ok(!requests.some((a) => a[0] === "send-keys"), "do not send stale keys");
      assert.equal(calls.at(-1)[0], "editMessageReplyMarkup");
      await gw.pollBlocked();
      gw.isUserPresent = () => true;
      status = "blocked";
      await gw.pollBlocked();
      assert.equal(sent.at(-1).extra.disable_notification, true);
      const enter = sent.at(-1).extra.reply_markup.inline_keyboard[0][0];
      await gw.handleCallback({ id: "cb2", data: enter.callback_data, message: { chat: { id: 1 }, message_id: 8 } });
      assert.ok(requests.some((a) => a.join(" ") === "send-keys bound enter"));
      gw.startBlockedPoller();
      assert.equal(gw.blockedTimer, null, "self-test never starts the timer");
      gw.stop();
    }
    {
      const r = spawnSync("node", ["--check", "--experimental-strip-types", join(dirname(fileURLToPath(import.meta.url)), "remote-pi.ts")]);
      assert.equal(r.status, 0, `remote-pi.ts syntax check: ${r.stderr}`);
    }
    for (const c of BOT_COMMANDS) assert.ok(HELP.includes(`/${c.command.padEnd(19)} ${c.description}`));
    assert.ok(BOT_COMMANDS.some((c) => c.command === "name"), "rename is in the menu");
    assert.ok(!BOT_COMMANDS.some((c) => c.command === "commands"), "discovery uses help");

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

    // 1. poll() 断网与恢复日志：断网仅首见打 1 行 offline，期间静默，恢复打 1 行 back online
    {
      const tmpOffset = join(tmpdir(), `test-poll-${Date.now()}`);
      const tg = new Telegram("fake-token", tmpOffset);
      const origError = console.error;
      const origLog = console.log;
      const errors = [];
      const logs = [];
      const attempts = [];
      console.error = (...args) => errors.push(args.join(" "));
      console.log = (...args) => logs.push(args.join(" "));

      let pollStep = 0;
      let pollPromise;
      const donePromise = new Promise((resolve) => {
        tg.call = async () => {
          attempts.push(Date.now());
          pollStep++;
          if (pollStep === 1) throw new Error("poll outage 1");
          if (pollStep === 2) throw new Error("poll outage 2");
          if (pollStep === 3) return [{ update_id: 10 }];
          throw new Error("unexpected poll");
        };
        pollPromise = tg.poll(() => {
          tg.stopPolling();
          resolve();
          return Promise.resolve();
        });
      });

      await donePromise;
      await pollPromise;
      console.error = origError;
      console.log = origLog;

      assert.equal(errors.filter((l) => l.includes("[tg:poll] offline:")).length, 1, "断网期间 offline 仅应记录 1 行");
      assert.ok(errors.some((l) => l.includes("[tg:poll] offline: poll outage 1; retrying with backoff")), "offline 日志内容");
      assert.equal(errors.filter((l) => l.includes("poll outage 2")).length, 0, "断网期间后续失败应保持静默");
      assert.equal(logs.filter((l) => l.includes("[tg:poll] back online after")).length, 1, "恢复后应记录 1 行 back online");
      assert.ok(logs.some((l) => l.includes("(2 failed polls)")), "恢复日志需体现连续失败次数");
      assert.equal(attempts.length, 3);
      for (let i = 1; i < attempts.length; i++) assert.ok(attempts[i] - attempts[i - 1] >= 490, "poll failures back off");
    }

    // 1. poll() Conflict 处理：记录 [tg:poll] conflict:，不计入 outage/back-online，15s 可中断休眠
    {
      const tmpOffset = join(tmpdir(), `test-poll-conflict-${Date.now()}`);
      const tg = new Telegram("fake-token", tmpOffset);
      const origError = console.error;
      const origLog = console.log;
      const errors = [];
      const logs = [];
      const attempts = [];
      console.error = (...args) => errors.push(args.join(" "));
      console.log = (...args) => logs.push(args.join(" "));

      let step = 0;
      let pollPromise;
      const donePromise = new Promise((resolve) => {
        tg.call = async () => {
          attempts.push(Date.now());
          step++;
          if (step === 1) throw new Error("Conflict: terminated by other getUpdates request");
          if (step === 2) throw new Error("Conflict: duplicate");
          if (step === 3) return [{ update_id: 20 }];
          throw new Error("unexpected poll");
        };
        pollPromise = tg.poll(() => {
          tg.stopPolling();
          resolve();
          return Promise.resolve();
        });
      });

      await donePromise;
      await pollPromise;
      console.error = origError;
      console.log = origLog;

      assert.equal(errors.filter((l) => l.includes("[tg:poll] conflict:")).length, 1, "Conflict 连续出现应只打 1 行日志");
      assert.equal(errors.filter((l) => l.includes("[tg:poll] offline:")).length, 0, "Conflict 不应被当作 offline outage");
      assert.equal(logs.filter((l) => l.includes("[tg:poll] back online")).length, 0, "Conflict 恢复不应打 back online");
      assert.equal(tg.pollFailures, 0, "Conflict 不应计入 pollFailures");
      assert.equal(attempts.length, 3);
      for (let i = 1; i < attempts.length; i++) assert.ok(attempts[i] - attempts[i - 1] >= 14_900, "conflicts back off for 15s");
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

    // runCommand accepts nonzero success codes.
    {
      const result = await runCommand(process.execPath, ["-e", "process.stdout.write('ok'); process.exit(1)"], { okCodes: [0, 1] });
      assert.equal(result, "ok");
    }

    assert.ok(HELP.includes("/topic") && BOT_COMMANDS.some((c) => c.command === "topic"), "/topic registered");
    assert.ok(HELP.includes("/close") && BOT_COMMANDS.some((c) => c.command === "close"), "/close registered");

    // shell single-quote helper
    {
      assert.equal(shellQuote("/path/to/project"), "'/path/to/project'");
      assert.equal(shellQuote("/path/to/it's project"), "'/path/to/it'\\''s project'");
      assert.equal(shellQuote("foo'bar'baz"), "'foo'\\''bar'\\''baz'");
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

      const nativeHerdr = { herdrBin: "/usr/local/bin/herdr", socketPath: "/tmp/mock.sock" };
      const env = await resolveHerdrEnvironment("/test/cwd", { ...nativeHerdr, runCmd: mockRunner });
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
      const envPersisted = await resolveHerdrEnvironment("/test/cwd", { ...nativeHerdr, persistedPaneId: "p_saved", runCmd: mockRunnerPersisted });
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
      const envFallback = await resolveHerdrEnvironment("/test/cwd", { ...nativeHerdr, persistedPaneId: "p_gone", runCmd: mockRunnerGone });
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
        react: () => {},
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
        ...["name", "start", "status"].map((name) => ({ name, source: "prompt", description: `Custom ${name}` })),
        { name: "foo-bar", source: "extension" }, { name: "foo_bar", source: "prompt" },
        { name: `${"a".repeat(32)}-one`, source: "prompt" }, { name: `${"a".repeat(32)}-two`, source: "prompt" },
        { name: "skill:check-a", source: "skill" }, { name: "skill_check_a", source: "extension" },
        { name: "git-review", source: "extension", description: "Review changes" },
        { name: "git-commit-push", source: "extension" },
      ];
      main.pi.request = async (type) => {
        assert.equal(type, "get_commands");
        return { commands };
      };
      const menus = [];
      gw.telegram.call = async (method, params) => {
        assert.equal(method, "setMyCommands");
        menus.push(params);
      };
      await gw.registerBotCommands();
      assert.equal(menus.length, 2, "register default and private-chat scopes");
      for (const { commands: menu } of menus) {
        for (const name of ["start", "foo_bar", "a".repeat(32), "skill_check_a"]) {
          assert.ok(!menu.some((c) => c.command === name), `${name} is reserved or ambiguous, not a menu command`);
        }
        assert.equal(menu.find((c) => c.command === "status").description, BOT_COMMANDS.find((c) => c.command === "status").description);
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
      topic.pi.request = async (type) => {
        assert.equal(type, "get_commands");
        return { commands: [{ name: "git_review", source: "prompt" }, { name: "skill:topic-only", source: "skill" }] };
      };
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
      for (const name of ["help"]) {
        sent.length = 0;
        await sess.handleCommand({ name, argument: "" }, `/${name}`);
        assert.deepEqual(sent, [HELP, "/review — Review changes\n/summarize\n/skill:check — Run checks"]);
      }
      commands = [];
      sent.length = 0;
      await sess.handleCommand({ name: "help", argument: "" }, "/help");
      assert.deepEqual(sent, [HELP], "no empty command-list notice");
      sess.pi.proc = null;
      sess.pi.request = async () => { assert.fail("static help must not start Pi"); };
      sent.length = 0;
      await sess.handleCommand({ name: "start", argument: "" }, "/start");
      assert.deepEqual(sent, [HELP]);
      sess.pi.proc = null;
      sent.length = 0;
      await sess.handleCommand({ name: "help", argument: "" }, "/help");
      assert.deepEqual(sent, [HELP], "help stays available after Pi exits without restarting it");
    }

    // Abort sends only the native abort command, never queue inspection/clearing.
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
        calls.length = 0;
        await sess.handleCommand({ name: "abort", argument: "" }, "/abort");
        assert.deepEqual(calls, proc ? ["abort"] : []);
        assert.ok(sent.at(-1).includes("queued messages kept"));
      }
    }

    // 11. Command with bot-suffix in parseCommand
    {
      assert.equal(parseCommand("/status@my_bot")?.name, "status");
      assert.equal(parseCommand("/abort@my_bot")?.name, "abort");
      assert.equal(parseCommand("/close@my_bot")?.name, "close");
      assert.equal(parseCommand("/status@my_bot arg")?.argument, "arg");
    }

    // /compact propagates an abort; /sh consumes it without falling through.
    {
      const gw = new Gateway({ allowedUserId: "1", botToken: "1:x", stateDir: tmpdir() });
      const s = gw.mainSession;
      const requests = [];
      s.pi.request = async (type) => {
        requests.push(type);
        throw new Error("Pi aborted the current run");
      };
      s.send = async () => assert.fail("aborted shell must not send an error");
      await assert.rejects(() => s.handleCommand({ name: "compact", argument: "" }), /aborted/);
      await s.handleCommand({ name: "sh", argument: "echo hi" });
      assert.deepEqual(requests, ["compact", "bash"]);
      assert.equal(s.run, null);
    }

    // 13. 回归：并发 saveState 全部成功落盘且最终文件包含全部键
    {
      const tmpStateDir = join(tmpdir(), `test-save-state-${Date.now()}`);
      await mkdir(tmpStateDir, { recursive: true });
      const gwSave = new Gateway({ allowedUserId: "1", botToken: "1:x", stateDir: tmpStateDir });
      await Promise.all([
        gwSave.saveState({ cwd: "/a" }),
        gwSave.saveState({ pendingRestartMessageId: 99 }),
        gwSave.saveState({ topics: { 1: { cwd: "/a" } } }),
        gwSave.saveState({ herdrPanes: { main: "p1" } }),
      ]);
      const final = JSON.parse(readFileSync(join(tmpStateDir, "state.json"), "utf8"));
      assert.equal(final.cwd, "/a");
      assert.equal(final.pendingRestartMessageId, 99);
      assert.deepEqual(final.topics, { 1: { cwd: "/a" } });
      assert.deepEqual(final.herdrPanes, { main: "p1" });
      await rm(tmpStateDir, { recursive: true, force: true }).catch(() => {});
    }

    // 14. 回归：runCommand 多字节字符跨 chunk 分割不损坏
    {
      const out = await runCommand(process.execPath, ["-e", "const b = Buffer.from('中文测试', 'utf8'); process.stdout.write(b.subarray(0, 1)); await new Promise(r => setTimeout(r, 20)); process.stdout.write(b.subarray(1));"]);
      assert.equal(out, "中文测试");
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

    // Draft pacing is per topic; a failed preview never falls back to edits.
    {
      const gw = new Gateway({ allowedUserId: "1", botToken: "1:x", stateDir: tmpdir(), cwd: tmpdir() });
      gw.chatReady = true;
      const sessions = [gw.mainSession, new ChatSession(gw, { threadId: 22, cwd: tmpdir() })], calls = [];
      let fail = false;
      gw.telegram.call = async (method, body) => {
        calls.push({ method, body });
        if (fail && method === "sendMessageDraft") throw new Error("draft unavailable");
        return true;
      };
      try {
        await Promise.all(sessions.map((s) => s.handleEvent({ type: "agent_start" })));
        await Promise.all(sessions.map((s) => s.run.pending));
        assert.equal(calls.length, 2, "both topics send their first draft independently");
        assert.equal(calls[1].body.message_thread_id, 22);
        const t0 = Math.max(...sessions.map((s) => s.lastDraftAt));
        for (const s of sessions) s.run.text = "changed";
        await Promise.all(sessions.map((s) => s.tickRun(t0 + 1500)));
        assert.equal(calls.length, 4);
        fail = true;
        sessions[0].run.text = "fail once";
        await sessions[0].tickRun(t0 + 3000);
        assert.equal(sessions[0].run.disabled, true);
        await sessions[0].tickRun(t0 + 30_000);
        assert.equal(calls.length, 5, "failed preview is disabled for the rest of the run");
        assert.ok(calls.every((c) => c.method === "sendMessageDraft"), "no edit fallback");
      } finally { for (const s of sessions) s.stop(); }
    }

    // 19. Desk presence & origin-based notification muting
    {
      const tmpDir = join(tmpdir(), `test-desk-${Date.now()}`);
      await mkdir(tmpDir, { recursive: true, mode: 0o700 });
      const presencePath = join(tmpDir, "presence-marker");
      const gw = new Gateway({ allowedUserId: "1", botToken: "1:x", stateDir: tmpDir, cwd: tmpDir, presenceFile: presencePath });
      gw.chatReady = true;
      const sess = gw.mainSession;
      const sentCalls = [];
      sess.send = async (text, extra = {}) => {
        sentCalls.push({ text, extra });
        return { message_id: sentCalls.length };
      };
      sess.pi.request = async () => ({ cost: 0 });

      // 1. Terminal-originated run via remote_user_input
      await sess.handleEvent({ type: "remote_user_input", text: "term cmd" });
      assert.equal(sess.nextOrigin, "terminal");
      assert.equal(sentCalls.at(-1)?.extra?.disable_notification, true, "terminal echo is silent");

      await sess.handleEvent({ type: "agent_settled" });
      assert.equal(sess.run, null, "settling releases run state");
      assert.equal(gw.isUserPresent(), false);
      await writeFile(presencePath, "here");
      assert.equal(gw.isUserPresent(), true);

      // Presence removed -> notifies again
      await unlink(presencePath);
      assert.equal(gw.isUserPresent(), false);
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
      gw.telegram.send = async (chat, text, extra = {}) => {
        sent.push({ text, extra });
        return { message_id: sent.length };
      };

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
