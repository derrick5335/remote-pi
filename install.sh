#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
LABEL="local.remote-pi"
DOMAIN="gui/$(id -u)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
CONFIG_DIR="$HOME/.config/remote-pi"
CONFIG="$CONFIG_DIR/config.json"
LOG_DIR="$HOME/.local/var/log"
LOG_FILE="$LOG_DIR/remote-pi.log"
COMMAND="$HOME/.local/bin/pi-telegram-gateway"
NODE="$(command -v node)"
PI="$(command -v pi || echo /opt/homebrew/bin/pi)"

install_command() {
    mkdir -p "$(dirname "$COMMAND")"
    cat > "$COMMAND" <<EOF
#!/bin/sh
exec "$ROOT/install.sh" "\$@"
EOF
    chmod 755 "$COMMAND"
}

install() {
    local token user_id
    printf 'Telegram Bot Token: '
    read -rs token
    printf '\nTelegram numeric user ID: '
    read -r user_id

    [[ "$token" =~ ^[0-9]+:[A-Za-z0-9_-]+$ ]] || { echo 'Invalid Bot Token' >&2; exit 1; }
    [[ "$user_id" =~ ^[0-9]+$ ]] || { echo 'User ID must be numeric' >&2; exit 1; }

    mkdir -p "$CONFIG_DIR" "$LOG_DIR" "$HOME/Library/LaunchAgents"
    chmod 700 "$CONFIG_DIR"
    cat > "$CONFIG" <<EOF
{
  "botToken": "$token",
  "allowedUserId": "$user_id",
  "cwd": "$ROOT",
  "piBin": "$PI",
  "approve": true,
  "logFile": "$LOG_FILE"
}
EOF
    chmod 600 "$CONFIG"
    install_command

    cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>$LABEL</string>
    <key>ProgramArguments</key>
    <array><string>/usr/bin/caffeinate</string><string>-i</string><string>--</string><string>$NODE</string><string>$ROOT/gateway.mjs</string></array>
    <key>WorkingDirectory</key><string>$ROOT</string>
    <key>KeepAlive</key><true/>
    <key>ProcessType</key><string>Background</string>
    <key>StandardOutPath</key><string>$LOG_FILE</string>
    <key>StandardErrorPath</key><string>$LOG_FILE</string>
</dict>
</plist>
EOF
    plutil -lint "$PLIST"
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    launchctl bootstrap "$DOMAIN" "$PLIST"
    sleep 2
    status
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
        echo "🛑 remote-pi is ${state:-stopped} (logs: $LOG_FILE)"
        [[ -f "$LOG_FILE" ]] && tail -n 10 "$LOG_FILE"
        return 1
    fi
}

case "${1:-install}" in
    install)   install ;;
    start)     start ;;
    stop)      stop ;;
    restart)   restart ;;
    status)    status ;;
    logs)      tail -f "$LOG_FILE" ;;
    uninstall) launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true; rm -f "$PLIST" "$COMMAND"; echo "Removed service; kept $CONFIG" ;;
    *) echo "Usage: $0 [install|start|stop|restart|status|logs|uninstall]" >&2; exit 1 ;;
esac
