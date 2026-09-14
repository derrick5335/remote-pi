# remote-pi

Telegram Bot gateway for Pi RPC。Pi 在本仓库工作，通过 Telegram 收发指令。

## 关键规则

- **不要启动新的 gateway 实例**：launchd 已有常驻服务，重复运行会被锁拦截。代码变更通过 `pi-telegram-gateway restart` 生效。
- **唯一安全的测试方式**：`node gateway.mjs --self-test`（离线自检，不连 Telegram；没有 `--test` 参数）。
- **修改前先查最佳实践**：动手改代码前，先上网确认该做法是否为最佳实践；若某次修改应用了官方文档、社区等来源的最佳实践，需标明该修改方向的 reference。

## 运维速查

- 日志：`~/.local/var/log/remote-pi.log`（可用 `REMOTE_PI_LOG_FILE` 覆盖；排障先 tail 它）
- 服务：`pi-telegram-gateway start|stop|restart|status|logs`
- 配置：`~/.config/remote-pi/config.json`（bot token，mode 600；可选 `sttCommand` 语音转写）
- 会话：`~/.local/var/remote-pi/sessions`（与桌面 Pi 分开存，避免写同一 session）
- 下载：`~/.local/var/remote-pi/downloads`
- 改完 gateway.mjs 后重启服务生效：`pi-telegram-gateway restart`

## 架构

- `gateway.mjs`：单文件，Node stdlib only，无 npm 依赖。轮询 Telegram → RPC 驱动 Pi 子进程；流式草稿（`sendMessageDraft`）不支持时回退静音消息 + 编辑。
- `telegram-extension.mjs`：Gateway 自动 `-e` 加载，给模型提供 `telegram_attach`（发文件）和 `telegram_ask`（内联按钮提问）两个工具。
- `install.sh`：安装 launchd 服务，`caffeinate -s -i -- node gateway.mjs` 防睡眠，KeepAlive 崩溃自启。
- Telegram 命令：`/sh`（直跑 shell）、`/get`（下载文件）、`/followup`（排队追加）、`/new /resume /abort /compact /model` 等；图片/文件/语音均可作上下文。
- 安全：只接受配置的私聊用户；Telegram 非端到端加密，控制该账号即等于控制本机用户权限，勿拉群。
