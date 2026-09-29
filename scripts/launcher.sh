#!/bin/bash
# Agent Canvas.app launcher: starts the local server if it isn't running, then
# opens the app in the default browser. "--background" (used by "Start when I
# log in") only starts the server.
RES="$(cd "$(dirname "$0")/../Resources" && pwd)"
PORT="${AGENT_CANVAS_PORT:-3002}"
URL="http://127.0.0.1:$PORT"
LOG="$HOME/Library/Logs/Agent Canvas.log"
# Finder gives apps a bare PATH; add where Claude Code and common tools live.
export PATH="$HOME/.local/bin:$HOME/.claude/local:/opt/homebrew/bin:/usr/local/bin:$PATH"

up() { /usr/bin/curl -fs -m 2 "$URL/api/system/usage" >/dev/null 2>&1; }

if ! up; then
  mkdir -p "$(dirname "$LOG")"
  echo "--- $(date) starting Agent Canvas on $URL" >>"$LOG"
  cd "$RES/app" || exit 1
  PORT="$PORT" NODE_ENV=production nohup "$RES/node" dist/main.js >>"$LOG" 2>&1 &
  for _ in $(seq 1 80); do up && break; sleep 0.25; done
  if ! up; then
    /usr/bin/osascript -e "display alert \"Agent Canvas couldn’t start\" message \"See ~/Library/Logs/Agent Canvas.log for details. Is something else using port $PORT?\"" >/dev/null 2>&1
    exit 1
  fi
fi
[ "${1:-}" = "--background" ] || /usr/bin/open "$URL"
