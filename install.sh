#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
LABEL="local.remote-pi"

if [[ "${1:-}" =~ ^(restart|stop|uninstall|upgrade)$ ]] && [[ -n "${REMOTE_PI_GATEWAY:-}" ]]; then
    echo "❌ 不能在 Remote Pi Gateway 会话内重启或停止自身服务（会导致自杀与失联）。" >&2
    echo "💡 如需重启 Gateway，请在 Telegram 中手动发送 /restart；如需升级请发送 /upgrade。" >&2
    exit 1
fi

DOMAIN="gui/$(id -u)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
CONFIG_DIR="$HOME/.config/remote-pi"
CONFIG="$CONFIG_DIR/config.json"
LOG_DIR="$HOME/.local/var/log"
LOG_FILE="$LOG_DIR/remote-pi.log"
COMMAND="$HOME/.local/bin/pi-remote-gateway"
NODE="$(command -v node || true)"
[[ -n "$NODE" ]] || { echo "❌ 未找到 node 可执行文件，请先安装 Node.js (>=22.18.0)" >&2; exit 1; }
PI="$(command -v pi || true)"
[[ -n "$PI" ]] || { echo "❌ 未找到 pi 可执行文件，请先安装并登录 pi 命令行工具" >&2; exit 1; }

xml_escape() {
    local s="$1"
    s="${s//&/&amp;}"
    s="${s//</&lt;}"
    s="${s//>/&gt;}"
    s="${s//\"/&quot;}"
    s="${s//\'/&apos;}"
    echo "$s"
}

install_command() {
    mkdir -p "$(dirname "$COMMAND")"
    ln -sf "$ROOT/install.sh" "$COMMAND"
}

setup_plist() {
    local esc_node esc_gateway esc_root esc_log
    esc_node="$(xml_escape "$NODE")"
    esc_gateway="$(xml_escape "$ROOT/gateway.mjs")"
    esc_root="$(xml_escape "$ROOT")"
    esc_log="$(xml_escape "$LOG_FILE")"

    cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>$LABEL</string>
    <key>ProgramArguments</key>
    <array><string>/usr/bin/caffeinate</string><string>-s</string><string>-i</string><string>--</string><string>$esc_node</string><string>$esc_gateway</string></array>
    <key>WorkingDirectory</key><string>$esc_root</string>
    <key>KeepAlive</key><true/>
    <key>ProcessType</key><string>Background</string>
    <key>StandardOutPath</key><string>$esc_log</string>
    <key>StandardErrorPath</key><string>$esc_log</string>
</dict>
</plist>
EOF
    plutil -lint "$PLIST"
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    launchctl bootstrap "$DOMAIN" "$PLIST"
    sleep 2
    status
}

install() {
    if [[ -f "$CONFIG" ]]; then
        echo "发现已有配置文件：$CONFIG"
        printf '是否保留现有配置并直接安装/更新服务？(Y/n): '
        read -r keep_config
        if [[ ! "$keep_config" =~ ^[Nn]$ ]]; then
            echo "保留现有配置。"
            install_command
            (cd "$ROOT" && npm install --omit=dev --no-audit --no-fund)
            setup_plist
            return
        fi
    fi

    local token user_id
    printf 'Telegram Bot Token: '
    read -rs token
    printf '\nTelegram numeric user ID: '
    read -r user_id

    [[ "$token" =~ ^[0-9]+:[A-Za-z0-9_-]+$ ]] || { echo 'Invalid Bot Token' >&2; exit 1; }
    [[ "$user_id" =~ ^[0-9]+$ ]] || { echo 'User ID must be numeric' >&2; exit 1; }

    mkdir -p "$CONFIG_DIR" "$LOG_DIR" "$HOME/Library/LaunchAgents"
    chmod 700 "$CONFIG_DIR"
    (umask 077 && cat > "$CONFIG" <<EOF
{
  "telegram": {
    "botToken": "$token",
    "allowedUserId": "$user_id"
  },
  "cwd": "$ROOT"
}
EOF
    )
    chmod 600 "$CONFIG"
    install_command
    (cd "$ROOT" && npm install --omit=dev --no-audit --no-fund)
    setup_plist
}

start() {
    if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
        status
        return
    fi
    [[ -f "$PLIST" ]] || { echo "Missing $PLIST; run $ROOT/install.sh install" >&2; exit 1; }
    launchctl bootstrap "$DOMAIN" "$PLIST"
    sleep 2
    status
}

stop() {
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    echo "🛑 remote-pi is stopped"
}

restart() {
    if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
        launchctl kickstart -k "$DOMAIN/$LABEL"
    else
        [[ -f "$PLIST" ]] || { echo "Missing $PLIST; run $ROOT/install.sh install" >&2; exit 1; }
        launchctl bootstrap "$DOMAIN" "$PLIST"
    fi
    sleep 2
    status
}

status() {
    local state
    state="$( (launchctl print "$DOMAIN/$LABEL" 2>/dev/null || true) | awk '/state =/{print $3; exit}')"
    if [[ "$state" == "running" ]]; then
        echo "✅ remote-pi is running (logs: $LOG_FILE)"
    else
        echo "⚠️ remote-pi is ${state:-stopped} (logs: $LOG_FILE)"
        [[ -f "$LOG_FILE" ]] && tail -n 10 "$LOG_FILE"
        return 1
    fi
}

# ponytail: rollback only covers npm/self-test failures; a new version that boots but crashes loops under KeepAlive — recover manually with `git reset --hard <old>`
upgrade() {
    local flag="${1:-}"
    cd "$ROOT"
    command -v git >/dev/null 2>&1 || { echo "❌ 未找到 git" >&2; exit 1; }
    local old branch remote_name
    old="$(git rev-parse HEAD 2>/dev/null)" || { echo "❌ $ROOT 不是 git 仓库" >&2; exit 1; }
    [[ -z "$(git status --porcelain)" ]] || { echo "❌ working tree 存在未提交修改，拒绝升级（先提交或清理）" >&2; exit 1; }
    branch="$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null)" || { echo "❌ 当前分支未设置 upstream（git push -u origin <branch>）" >&2; exit 1; }
    remote_name="${branch%%/*}"
    git fetch --quiet "$remote_name" || { echo "❌ git fetch 失败" >&2; exit 1; }
    if [[ "$(git rev-parse HEAD)" == "$(git rev-parse "$branch")" ]]; then
        echo "✅ 已是最新：$(git log -1 --format='(%h) %s')"
        return 0
    fi
    git merge --ff-only --quiet "$branch" || { echo "❌ 无法 fast-forward（本地与远端分叉）" >&2; exit 1; }
    echo "⬆️ 已更新到：$(git log -1 --format='(%h) %s')"
    if ! npm install --omit=dev --no-audit --no-fund --silent; then
        git reset --hard --quiet "$old"
        echo "❌ npm install 失败，已回滚到 $old" >&2; exit 1
    fi
    if ! "$NODE" "$ROOT/gateway.mjs" --self-test >/dev/null 2>&1; then
        git reset --hard --quiet "$old"
        npm install --omit=dev --no-audit --no-fund --silent >/dev/null 2>&1
        echo "❌ self-test 失败，已回滚到 $old" >&2; exit 1
    fi
    echo "✅ 升级完成"
    [[ "$flag" == "--no-restart" ]] && return 0
    if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
        restart
    else
        echo "（服务未运行，跳过重启；可执行 pi-remote-gateway start 启动）"
    fi
}

case "${1:-install}" in
    install)   install ;;
    upgrade)   upgrade "${2:-}" ;;
    start)     start ;;
    stop)      stop ;;
    restart)   restart ;;
    status)    status ;;
    logs)      tail -f "$LOG_FILE" ;;
    uninstall) launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true; rm -f "$PLIST" "$COMMAND"; echo "Removed service; kept $CONFIG" ;;
    *) echo "Usage: $0 [install|upgrade|start|stop|restart|status|logs|uninstall]" >&2; exit 1 ;;
esac
