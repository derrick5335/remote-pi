# remote-pi

Telegram Bot gateway for Pi RPC。Pi 在本仓库工作，通过 Telegram 收发指令。

## 关键规则

- **不要启动新的 gateway 实例**：launchd 已有常驻服务，重复运行会被锁拦截。代码变更通过 `pi-remote-gateway restart` 生效。
- **唯一安全的测试方式**：`node gateway.mjs --self-test`（离线自检，不连 Telegram；没有 `--test` 参数）。
- **修改前先查最佳实践**：动手改代码前，先上网确认该做法是否为最佳实践；若某次修改应用了官方文档、社区等来源的最佳实践，需标明该修改方向的 reference。
- **100% 基于 Pi 原生状态与能力**：整个项目严格只依赖 Pi RPC 原生暴露的状态与能力（如 `get_state`、`get_session_stats` 等），不引入任何私有 addon、本地旁路文件或定制化侵入逻辑。
- **多语言 README 同步**：代码行为/命令/配置发生变化时，必须同步更新 `README.md` 和 `README.zh-CN.md`，两份文档保持一致。

## 运维速查

- 日志：`~/.local/var/log/remote-pi.log`（可用 `REMOTE_PI_LOG_FILE` 覆盖；排障先 tail 它）
- 服务：`pi-remote-gateway start|stop|restart|status|logs`
- 配置：`~/.config/remote-pi/config.json`（bot token，mode 600；可选 `sttCommand` 语音转写）
- 会话：`~/.local/var/remote-pi/sessions`（与桌面 Pi 分开存，避免写同一 session）
- 下载：`~/.local/var/remote-pi/downloads`
- 改完 gateway.mjs 后重启服务生效：`pi-remote-gateway restart`

## 架构

- `gateway.mjs`：单文件核心，无额外框架（仅依赖 `markdown-it` 用于 Telegram HTML 格式渲染）。轮询 Telegram → RPC 驱动 Pi 子进程；流式草稿（`sendMessageDraft`）不支持时回退静音消息 + 编辑。
- `remote-extension.mjs`：Companion extension，给模型提供 `remote_attach`（发文件）和 `remote_ask`（内联按钮提问）两个工具（兼容别名 `telegram_attach`/`telegram_ask`）。可通过配置禁用或添加更多自定义扩展。
- `install.sh`：安装 launchd 服务，`caffeinate -s -i -- node gateway.mjs` 防睡眠，KeepAlive 崩溃自启。
- Telegram 命令：`/sh`（直跑 shell）、`/get`（下载文件）、`/followup`（排队追加）、`/new /resume /abort /compact /model` 等；图片/文件/语音均可作上下文。
- 安全：只接受配置的私聊用户；Telegram 非端到端加密，控制该账号即等于控制本机用户权限，勿拉群。
