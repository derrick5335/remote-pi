# remote-pi

Telegram Bot gateway for interactive Pi。一个 session 对应 Herdr 窗格中的一个 Pi 进程，桌面终端与 Telegram 只是不同视图。

## 关键规则

- **不要启动新的 gateway 实例**：launchd 已有常驻服务，重复运行会被锁拦截。未经用户明确授权，不要启动、停止或重启服务。
- **唯一安全的测试方式**：`node gateway.mjs --self-test`（离线自检，不连 Telegram 或真实 Herdr；没有 `--test` 参数）。
- **修改前先查最佳实践**：动手改代码前，先上网确认该做法是否为最佳实践；若某次修改应用了官方文档、社区等来源的最佳实践，需标明该修改方向的 reference。
- **100% Pi-native**：仅依赖 Pi 公开 Extension API、Pi 原生 CLI 与 Herdr socket API；不引入私有补丁、私有 addon 或旁路通信文件。目标为已安装的 Pi 1.3.0，以其 `docs/extensions.md`、`docs/rpc.md` 和公开类型定义为准。
- **行数预算与验证**：`gateway.mjs` ≤1500、`remote-pi.ts` ≤360、`install.sh` ≤140，三者合计 ≤2000；`self-test.mjs` ≤900，均含注释与空行。每步运行 `node gateway.mjs --self-test` 与 `npm run lint`；不得修改 ESLint 规则或挤压多条语句规避预算。
- **多语言 README 同步**：代码行为/命令/配置发生变化时，必须同步更新 `README.md` 和 `README.zh-CN.md`，两份文档保持一致。
- **一个会话，一个进程**：已有 Pi 在运行时只绑定其视图，不启动第二个进程读写同一 session。关闭桌面附加的 Topic 只能断开远程控制，不能终止用户的 Pi。

## 运维速查

- 依赖：Node.js >=22.18.0、已认证的 Pi CLI 1.3.0、Herdr（必需，`pi` 与 `herdr` 均需位于 PATH）
- 日志：`~/.local/var/log/remote-pi.log`（可用 `REMOTE_PI_LOG_FILE` 覆盖；排障先 tail 它）
- 服务：`pi-remote-gateway start|stop|restart|status|logs`（仅经用户授权执行变更）
- 配置：`~/.config/remote-pi/config.json`（bot token，mode 600；可选 `sttCommand` 语音转写）
- 会话：Pi 原生目录 `~/.pi/agent/sessions`（支持 Pi 原生目录环境变量覆盖）
- 网关状态：`~/.local/var/remote-pi/state.json`，保存主会话/Topic 的 pane/terminal/session 绑定；桥接 socket 为同目录的 `bridge.sock`（mode 600）
- 下载：`~/.local/var/remote-pi/downloads`
- 网关代码通过服务重启生效；Pi 扩展通过 Pi 原生 `/reload` 或会话替换重载。不要为了验证而自行重启。

## 架构

- `gateway.mjs`：单文件核心，仅依赖 `markdown-it` 渲染 Telegram HTML。轮询 Telegram → `PaneRpc` → 本地 Unix socket → Herdr 窗格内的交互式 Pi；流式输出采用临时 `sendMessageDraft` + 最终 `sendMessage`，状态通过用户消息 reaction 显示；工具调用/终端发起静音，桌面在线时不响铃。
- 输出保序：各 `ChatSession` 的 `eventChain` / `updateChain` 负责会话内串行；无全局 Telegram 输出队列或方法猴子补丁。附件用独立的会话级 `uploadChain` 保序，不阻塞事件或其他会话；仅 `/abort` 与 `/restart` 绕过输入更新链。新 Topic 同步注册并按到达顺序入队，持久化与欢迎消息在后台执行并记录错误。
- 轮次收尾：已回复后禁止空的 “Thinking…” 草稿；每条助手 `message_end` 更新 `run.error`，内部重试成功后最终 reaction 为 `👌`。
- `remote-pi.ts`：统一 Pi extension，通过公开 Extension API 实现 RPC 形状的桥接命令与事件转发，提供 `/remote-control on|off|status`。Herdr 原生 pane metadata token `remote_pi=on` 保存开关，扩展自动重连；会话替换后由新 runtime 的 hello 恢复绑定。
- `remote_attach` / `remote_ask`：统一扩展中的两个工具，仅连接期间启用；后者同时在 Telegram 与 TUI 显示，先回答者生效并取消另一端。断线重连保持待答提问有效并在重连后重发，显式断开才取消。其他扩展的 TUI 对话不代理，只提供 Herdr blocked 屏幕预览与 Enter/Esc 控件，不解析编号选项。
- 绑定与生命周期：会话按 Herdr `terminal_id` 匹配实际终端，避免窗格 ID 复用导致误绑或误关。Telegram 客户端删除的 Topic 在下次投递失败时自动对齐清理。`/new` 与 `/resume` 替换请求采用 60s 超时并向用户反馈清晰错误。
- blocked 轮询：绑定会话工作期间每 3 秒读取 Herdr 原生 agent 状态，仅推送绑定窗格的 blocked 变化；已有 `remote_ask` 按钮时不重复提醒。Enter/Esc 回调重新验证 blocked；按键、屏幕读取与状态查询均走 Herdr socket API，不用模拟按键驱动 Pi。
- `install.sh`：安装 launchd 服务，并将 `remote-pi.ts` 软链到 `~/.pi/agent/extensions/remote-pi.ts`；安装/升级时替换已有软链目标，不覆盖用户普通文件。`caffeinate -s -i -- node gateway.mjs` 防睡眠，KeepAlive 崩溃自启。
- `/new` 无论是否已有连接都必须请求 `new_session`，不能把旧 `binding.sessionFile` 的懒启动误报为新会话。
- Telegram 命令：`/sh`（直跑 shell）、`/followup`（排队追加）、`/new /resume /abort /compact /model` 等；图片/文件/语音均可作上下文。`/resume` 使用统一原生会话列表，已运行的会话只切换视图。
- Pi 1.3.0：`/resume` 经扩展调用公开 `SessionManager.list`，不由网关扫描会话文件；无公开原生队列检查/清空 API 及自动重试事件钩子。
- 安全：只接受配置的私聊用户；Telegram 非端到端加密，控制该账号即等于控制本机用户权限，勿拉群。
