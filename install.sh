#!/usr/bin/env bash
set -euo pipefail

# 解析 symlink（pi-remote-gateway 是指向本脚件的符号链接），否则 ROOT 会指向 ~/.local/bin
SELF="$0"
while [ -L "$SELF" ]; do SELF="$(readlink "$SELF")"; done
ROOT="$(cd "$(dirname "$SELF")" && pwd)"
LABEL="local.remote-pi"

if [[ "${1:-}" =~ ^(restart|stop|uninstall|upgrade)$ ]] && [[ -n "${REMOTE_PI_GATEWAY:-}" ]]; then
    echo "❌ Cannot restart/stop/uninstall/upgrade from inside a Remote Pi Gateway session (it would kill itself and lose the connection)." >&2
    echo "💡 Send /restart (or /upgrade) in Telegram instead." >&2
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
[[ -n "$NODE" ]] || { echo "❌ node not found; install Node.js (>=22.18.0) first" >&2; exit 1; }
PI="$(command -v pi || true)"
[[ -n "$PI" ]] || { echo "❌ pi not found; install and log in to the pi CLI first" >&2; exit 1; }

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
        echo "Found existing config: $CONFIG"
        printf 'Keep it and (re)install/update the service? (Y/n): '
        read -r keep_config
        if [[ ! "$keep_config" =~ ^[Nn]$ ]]; then
            echo "Keeping existing config."
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
    command -v git >/dev/null 2>&1 || { echo "❌ git not found" >&2; exit 1; }
    local old branch remote_name
    old="$(git rev-parse HEAD 2>/dev/null)" || { echo "❌ $ROOT is not a git repository" >&2; exit 1; }
    [[ -z "$(git status --porcelain)" ]] || { echo "❌ Working tree has uncommitted changes; refusing to upgrade (commit or clean first)" >&2; exit 1; }
    branch="$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null)" || { echo "❌ Current branch has no upstream (git push -u origin <branch>)" >&2; exit 1; }
    remote_name="${branch%%/*}"
    git fetch --quiet "$remote_name" || { echo "❌ git fetch failed" >&2; exit 1; }
    if [[ "$(git rev-parse HEAD)" == "$(git rev-parse "$branch")" ]]; then
        echo "✅ Already up to date: $(git log -1 --format='(%h) %s')"
        return 0
    fi
    git merge --ff-only --quiet "$branch" || { echo "❌ Cannot fast-forward (local and remote have diverged)" >&2; exit 1; }
    echo "⬆️ Updated to: $(git log -1 --format='(%h) %s')"
    if ! npm install --omit=dev --no-audit --no-fund --silent; then
        git reset --hard --quiet "$old"
        echo "❌ npm install failed; rolled back to $old" >&2; exit 1
    fi
    if ! "$NODE" "$ROOT/gateway.mjs" --self-test >/dev/null 2>&1; then
        git reset --hard --quiet "$old"
        npm install --omit=dev --no-audit --no-fund --silent >/dev/null 2>&1
        echo "❌ Self-test failed; rolled back to $old" >&2; exit 1
    fi
    echo "✅ Upgrade complete"
    [[ "$flag" == "--no-restart" ]] && return 0
    if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
        restart
    else
        echo "(Service not running; skipping restart. Run pi-remote-gateway start to start it.)"
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
