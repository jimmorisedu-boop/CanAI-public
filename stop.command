#!/bin/zsh
# Останавливает работающий CanAI — порт stop.ps1 для macOS.
#
# Завершаем ТОЛЬКО по токену из runtime-control.json: без подтверждения, что
# на порту действительно наша копия, ничего убивать нельзя — там может стоять
# чужая программа.
set -e
cd "$(dirname "$0")"
ROOT="$PWD"
DATA_ROOT="${CANAI_DATA_DIR:-$ROOT/server/data}"
CONTROL="$DATA_ROOT/runtime-control.json"

BUNDLED="$ROOT/runtime/node"
if [ -x "$BUNDLED/bin/node" ]; then
  export PATH="$BUNDLED/bin:$PATH"
fi

say() { print -r -- "[CanAI] $*" }
port_busy() { nc -z 127.0.0.1 "$1" >/dev/null 2>&1 }

control_field() {  # поле → значение из control-файла
  node - "$CONTROL" "$1" <<'NODE' 2>/dev/null || true
const fs = require('fs');
try {
  const control = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  if (control.version !== 1) process.exit(1);
  const value = control[process.argv[3]];
  if (value === undefined || value === null) process.exit(1);
  process.stdout.write(String(value));
} catch {
  process.exit(1);
}
NODE
}

PORT_TO_STOP="$(control_field port)"
[ -z "$PORT_TO_STOP" ] && PORT_TO_STOP="${PORT:-8787}"

if ! port_busy "$PORT_TO_STOP"; then
  say "CanAI is not running (port $PORT_TO_STOP is free)."
  exit 0
fi

INSTANCE="$(curl -fsS -m 3 "http://127.0.0.1:$PORT_TO_STOP/api/status" 2>/dev/null \
  | node -e 'try{const b=JSON.parse(require("fs").readFileSync(0,"utf8"));process.stdout.write(b.instanceId||"");}catch{}' 2>/dev/null || true)"
if [ -z "$INSTANCE" ]; then
  say "Port $PORT_TO_STOP is used by another program; CanAI is not there. Nothing was changed."
  exit 1
fi

EXPECTED="$(control_field instanceId)"
if [ -n "$EXPECTED" ] && [ "$EXPECTED" != "$INSTANCE" ]; then
  say "Port $PORT_TO_STOP has another CanAI instance from a different folder. Nothing was changed."
  exit 1
fi

TOKEN="$(control_field shutdownToken)"
if [ -z "$TOKEN" ]; then
  say "Could not verify that the server belongs to this CanAI copy."
  say "Nothing was stopped; close the app window manually."
  exit 1
fi

curl -fsS -m 5 -X POST -H "x-canai-shutdown-token: $TOKEN" \
  "http://127.0.0.1:$PORT_TO_STOP/api/lifecycle/shutdown" >/dev/null 2>&1 || {
  say "The server did not accept the safe shutdown request."
  exit 1
}

waited=0
while [ "$waited" -lt 60 ]; do
  if ! port_busy "$PORT_TO_STOP"; then
    say "CanAI stopped."
    exit 0
  fi
  sleep 0.25
  waited=$(( waited + 1 ))
done
say "The server did not release its port within 15 seconds. I will not kill processes forcefully."
exit 1
