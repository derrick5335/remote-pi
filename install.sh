#!/usr/bin/env bash
set -euo pipefail

SELF="$0"
while [ -L "$SELF" ]; do SELF="$(readlink "$SELF")"; done
ROOT="$(cd "$(dirname "$SELF")" && pwd)"
LABEL="local.remote-pi"

DOMAIN="gui/$(id -u)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
CONFIG_DIR="$HOME/.config/remote-pi"
CONFIG="$CONFIG_DIR/config.json"
LOG_DIR="$HOME/.local/var/log"
LOG_FILE="$LOG_DIR/remote-pi.log"
COMMAND="$HOME/.local/bin/pi-remote-gateway"
PI_EXTENSION_DIR="$HOME/.pi/agent/extensions"
PI_EXTENSION="$PI_EXTENSION_DIR/remote-pi.ts"
NODE="$(command -v node || true)"
[[ -n "$NODE" ]] || { echo "❌ node not found; install Node.js (>=22.18.0) first" >&2; exit 1; }
PI="$(command -v pi || true)"
[[ -n "$PI" ]] || { echo "❌ pi not found; install and log in to the pi CLI first" >&2; exit 1; }

xml_escape() { local s="$1"; s="${s//&/&amp;}"; s="${s//</&lt;}"; s="${s//>/&gt;}"; s="${s//\"/&quot;}"; s="${s//\'/&apos;}"; echo "$s"; }

install_command() {
    mkdir -p "$(dirname "$COMMAND")" "$PI_EXTENSION_DIR"
    ln -sf "$ROOT/install.sh" "$COMMAND"
    if [[ -e "$PI_EXTENSION" && ! -L "$PI_EXTENSION" ]]; then echo "❌ Refusing to overwrite non-symlink extension: $PI_EXTENSION" >&2; return 1; fi
    ln -sfn "$ROOT/remote-pi.ts" "$PI_EXTENSION"
}

secure_log() {
    mkdir -p "$LOG_DIR" && chmod 700 "$LOG_DIR"
    [[ -f "$LOG_FILE" ]] || (umask 077 && touch "$LOG_FILE")
    chmod 600 "$LOG_FILE"
}

setup_plist() {
    secure_log
    local esc_node esc_gateway esc_root esc_log
    esc_node="$(xml_escape "$NODE")"; esc_gateway="$(xml_escape "$ROOT/gateway.mjs")"
    esc_root="$(xml_escape "$ROOT")"; esc_log="$(xml_escape "$LOG_FILE")"
    cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
    <key>Label</key><string>$LABEL</string>
    <key>ProgramArguments</key><array><string>/usr/bin/caffeinate</string><string>-s</string><string>-i</string><string>--</string><string>$esc_node</string><string>$esc_gateway</string></array>
    <key>WorkingDirectory</key><string>$esc_root</string>
    <key>KeepAlive</key><true/>
    <key>ProcessType</key><string>Background</string>
    <key>StandardOutPath</key><string>$esc_log</string>
    <key>StandardErrorPath</key><string>$esc_log</string>
</dict></plist>
EOF
    plutil -lint "$PLIST"
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    sleep 1
    for attempt in 1 2 3; do
        if launchctl bootstrap "$DOMAIN" "$PLIST"; then break; fi
        [[ "$attempt" == 3 ]] && { echo "❌ launchctl bootstrap failed after 3 attempts" >&2; return 1; }
        sleep 1
    done
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
    printf 'Telegram Bot Token: ' && read -rs token
    printf '\nTelegram numeric user ID: ' && read -r user_id
    [[ "$token" =~ ^[0-9]+:[A-Za-z0-9_-]+$ ]] || { echo 'Invalid Bot Token' >&2; exit 1; }
    [[ "$user_id" =~ ^[0-9]+$ ]] || { echo 'User ID must be numeric' >&2; exit 1; }

    mkdir -p "$CONFIG_DIR" "$LOG_DIR" "$HOME/Library/LaunchAgents"
    chmod 700 "$CONFIG_DIR"
    (umask 077 && CFG_TOKEN="$token" CFG_USER_ID="$user_id" CFG_CWD="$ROOT" "$NODE" -e '
      process.stdout.write(JSON.stringify({ telegram: { botToken: process.env.CFG_TOKEN, allowedUserId: process.env.CFG_USER_ID }, cwd: process.env.CFG_CWD }, null, 2) + "\n");
    ' > "$CONFIG")
    chmod 600 "$CONFIG"
    install_command
    (cd "$ROOT" && npm install --omit=dev --no-audit --no-fund)
    setup_plist
}

start() {
    if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
        if [[ "${1:-}" == "restart" ]]; then launchctl kickstart -k "$DOMAIN/$LABEL"; else status; return; fi
    else
        [[ -f "$PLIST" ]] || { echo "Missing $PLIST; run $ROOT/install.sh install" >&2; exit 1; }
        secure_log
        launchctl bootstrap "$DOMAIN" "$PLIST"
    fi
    sleep 2
    status
}

stop() {
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    echo "🛑 remote-pi is stopped"
}

restart() { start restart; }

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

case "${1:-install}" in
    install)   install ;;
    start)     start ;;
    stop)      stop ;;
    restart)   restart ;;
    status)    status ;;
    logs)      tail -f "$LOG_FILE" ;;
    uninstall) launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true; rm -f "$PLIST" "$COMMAND"; [[ -L "$PI_EXTENSION" ]] && rm -f "$PI_EXTENSION"; echo "Removed service; kept $CONFIG" ;;
    *) echo "Usage: $0 [install|start|stop|restart|status|logs|uninstall]" >&2; exit 1 ;;
esac
