#!/bin/zsh
# Лаунчер CanAI для macOS — порт start.ps1. Находит или скачивает Node.js,
# синхронизирует зависимости, собирает клиент и запускает production-сервер на
# свободной паре портов (основной + планшетный).
#
# Windows-версия (start.ps1) остаётся ЕДИНСТВЕННЫМ источником правды для
# Windows: этот файл её не заменяет и не подключает, у систем просто разные
# оболочки. Правишь поведение запуска — правь оба.
set -e
cd "$(dirname "$0")"
ROOT="$PWD"

NODE_VERSION=v22.23.1
NODE_SHA=ef28d8fab2c0e4314522d4bb1b7173270aa3937e93b92cb7de79c112ac1fa953
NODE_MIN_MAJOR=22
BUNDLED="$ROOT/runtime/node"

NO_BROWSER=0
UNATTENDED=0
for arg in "$@"; do
  case "$arg" in
    --no-browser) NO_BROWSER=1 ;;
    --unattended) UNATTENDED=1 ;;
  esac
done
[ -n "$CANAI_NO_BROWSER" ] && NO_BROWSER=1
[ -n "$CANAI_UNATTENDED" ] && UNATTENDED=1

say() { print -r -- "[CanAI] $*" }
die() {
  say "$*"
  print -r -- ""
  if [ -t 0 ] && [ "$UNATTENDED" -eq 0 ]; then
    print -r -- "Press any key to close this window."
    read -k 1
  fi
  exit 1
}

node_major() {  # путь к node → мажорная версия
  local version
  version="$("$1" -v 2>/dev/null)" || return 1
  print -r -- "${${version#v}%%.*}"
}

install_node() {
  say "Downloading portable Node.js $NODE_VERSION (about 40 MB, one time)…"
  local archive="$ROOT/runtime/node.tar.gz" unpack="$ROOT/runtime/node-unpack"
  mkdir -p "$ROOT/runtime"
  curl -fsSL -o "$archive" "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-darwin-arm64.tar.gz" \
    || die "Could not download Node.js; check your internet connection."
  local actual="$(shasum -a 256 "$archive" | awk '{print $1}')"
  if [ "$actual" != "$NODE_SHA" ]; then
    rm -f "$archive"
    die "The Node.js archive checksum does not match."
  fi
  rm -rf "$unpack"; mkdir -p "$unpack"
  tar xzf "$archive" -C "$unpack"
  local downloaded="$unpack/node-$NODE_VERSION-darwin-arm64"
  # ⚠️ Проверяем ЗАПУСКОМ, а не флагом исполняемости: -x стоит и у обрезанного
  # архива, и у бинарника чужой архитектуры (качаем сборку только под Apple
  # Silicon) — то есть прежняя проверка пропускала ровно те случаи, ради
  # которых была написана, а падало потом на npm ci и без объяснения причины.
  if [ -z "$(node_major "$downloaded/bin/node" || true)" ]; then
    rm -rf "$unpack" "$archive"
    die "Downloaded Node.js could not start: the archive is damaged or this Mac is not Apple Silicon. Install Node.js $NODE_MIN_MAJOR+ from nodejs.org and run this again."
  fi
  rm -rf "$BUNDLED"
  mv "$downloaded" "$BUNDLED"
  rm -rf "$unpack" "$archive"
}

# ── 1. Node ───────────────────────────────────────────────────────
# ⚠️ В отличие от Windows-версии мы НЕ переустанавливаем свою копию из-за
# несовпадения версии — только если она старше минимума. На машине
# разработчика в runtime/node может лежать более новый Node, и молча
# откатывать его назад незачем; серверу достаточно 22-й.
if [ -x "$BUNDLED/bin/node" ]; then
  major="$(node_major "$BUNDLED/bin/node" || print 0)"
  [ "${major:-0}" -lt "$NODE_MIN_MAJOR" ] && install_node
  export PATH="$BUNDLED/bin:$PATH"
  say "Using bundled Node.js from runtime/node"
elif command -v node >/dev/null 2>&1; then
  major="$(node_major "$(command -v node)" || print 0)"
  if [ "${major:-0}" -lt "$NODE_MIN_MAJOR" ]; then
    install_node
    export PATH="$BUNDLED/bin:$PATH"
  else
    say "Using system Node.js $(node -v)"
  fi
else
  install_node
  export PATH="$BUNDLED/bin:$PATH"
  say "Node.js installed in runtime/node"
fi

# ── 2. Зависимости — по хешу lock-файла ───────────────────────────
sync_deps() {
  local pkg="$1"
  local lock="$ROOT/$pkg/package-lock.json"
  local modules_dir="$ROOT/$pkg/node_modules"
  local marker="$modules_dir/.canai-lock.sha256"
  [ -f "$lock" ] || return 0
  local lock_hash
  lock_hash="$(shasum -a 256 "$lock" | awk '{print $1}')"
  local marker_hash=""
  [ -f "$marker" ] && marker_hash="$(cat "$marker")"
  if [ ! -d "$modules_dir" ] || [ "$marker_hash" != "$lock_hash" ]; then
    say "Syncing dependencies in '$pkg'…"
    ( cd "$ROOT/$pkg" && npm ci --no-fund --no-audit ) || die "Could not install dependencies in '$pkg' (npm ci, see the message above). Usually registry.npmjs.org is unreachable; check your internet connection, VPN, or proxy."
    print -r -- "$lock_hash" > "$marker"
  fi
}
sync_deps server

# ── 3. Сборка интерфейса, если исходники новее ────────────────────
DIST="$ROOT/client/dist/index.html"
TABLET_DIST="$ROOT/client/dist/tablet/tablet.html"
needs_build=0
# ⚠️ Поставке покупателя (build-info.json есть, .git нет) интерфейс собран
# заранее, и по датам её не судим: распаковка архива может поставить всем файлам
# своё время (на Windows так и вышло — 943 исходника «новее» собранного), и
# лаунчер пересобирал бы интерфейс ни за что. Копия под git решает по датам.
shipped_build=0
[ -f "$ROOT/build-info.json" ] && [ ! -e "$ROOT/.git" ] && shipped_build=1
if [ ! -f "$DIST" ] || [ ! -f "$TABLET_DIST" ]; then
  needs_build=1
elif [ "$shipped_build" = 1 ]; then
  needs_build=0
else
  # ⚠️ packages/ — общие исходники, и в собранный интерфейс они тоже входят
  # (клиент берёт оттуда разбор ответа помощника и каталог моделей, сервер
  # читает те же файлы на лету). Без неё в этом списке правка, сделанная только
  # там, после обновления через git доезжает до сервера, а до собранных страниц
  # — нет: компьютер и планшет прочли бы один ответ по-разному. Папки может не
  # быть — find пропустит её молча (2>/dev/null || true).
  newer="$(find "$ROOT/client/src" "$ROOT/client/public" "$ROOT/packages" \
    "$ROOT/client/package.json" "$ROOT/client/package-lock.json" \
    "$ROOT/client/vite.config.ts" "$ROOT/client/vite.tablet.config.ts" \
    -type f -newer "$DIST" -print -quit 2>/dev/null || true)"
  [ -n "$newer" ] && needs_build=1
fi
if [ "$needs_build" = 1 ]; then
  # ⚠️ Корневые и клиентские пакеты нужны ТОЛЬКО сборке интерфейса: в поставке
  # он уже собран, а ставились они всегда — 260 МБ клиентских и 5 МБ корневых
  # против 75 МБ серверных (замер на чистой Windows 28.09.2026).
  sync_deps .
  sync_deps client
  say "Building the UI (about 10 seconds)…"
  ( cd "$ROOT/client" && npm run build ) || die "Could not build the UI"
fi

# ── 4. Порты ──────────────────────────────────────────────────────
DATA_ROOT="${CANAI_DATA_DIR:-$ROOT/server/data}"
CONTROL="$DATA_ROOT/runtime-control.json"
REQUESTED_PORT="${PORT:-8787}"
FIXED_REMOTE_PORT="${CANAI_REMOTE_PORT:-}"

port_busy() { nc -z 127.0.0.1 "$1" >/dev/null 2>&1 }

valid_port() {
  case "$1" in
    ''|*[!0-9]*) return 1 ;;
  esac
  [ "$1" -ge 1 ] && [ "$1" -le 65535 ]
}

if ! valid_port "$REQUESTED_PORT"; then
  die "Invalid main port: $REQUESTED_PORT"
fi
if [ -n "$FIXED_REMOTE_PORT" ] && ! valid_port "$FIXED_REMOTE_PORT"; then
  die "Invalid tablet port: $FIXED_REMOTE_PORT"
fi

find_free_port() {  # начальный порт → основной и планшетный порт
  local start="$1"
  local candidate
  local remote
  local max_main
  local last
  max_main=65533
  [ -n "$FIXED_REMOTE_PORT" ] && max_main=65535
  [ "$start" -gt "$max_main" ] && return 1
  last=$(( start + 99 ))
  [ "$last" -gt "$max_main" ] && last="$max_main"
  for (( candidate = start; candidate <= last; candidate++ )); do
    if [ -n "$FIXED_REMOTE_PORT" ]; then
      remote="$FIXED_REMOTE_PORT"
    else
      remote=$(( candidate + 2 ))
    fi
    if [ "$candidate" -ne "$remote" ] && ! port_busy "$candidate" && ! port_busy "$remote"; then
      print -r -- "$candidate:$remote"; return 0
    fi
  done
  return 1
}

# Отпечаток серверного кода: по нему приложение понимает, что установлено
# обновление и работающий сервер устарел.
server_fingerprint() {
  { find "$ROOT/server/src" -type f -print0 | sort -z | xargs -0 shasum -a 256
    shasum -a 256 "$ROOT/server/package.json" "$ROOT/server/package-lock.json"
  } 2>/dev/null | shasum -a 256 | awk '{print $1}'
}
export CANAI_SERVER_FINGERPRINT="$(server_fingerprint || true)"

# ⚠️ Каждое обращение обязано гаситься `|| true`: при set -e неудачная
# подстановка команды роняет ВЕСЬ скрипт, а «сервера нет» — это норма, а не
# сбой. На этом же попался kill уже завершившегося наблюдателя за браузером.
status_json() { curl -fsS -m 3 "http://127.0.0.1:$1/api/status" 2>/dev/null || true }

# Пробуем закрыть чужой экземпляр ТОЛЬКО по токену control-файла: без
# подтверждения, что это наша копия, ничего не завершаем принудительно.
request_shutdown() {  # порт
  local port="$1" token
  token="$(node - "$CONTROL" "$port" <<'NODE' 2>/dev/null
const fs = require('fs');
try {
  const control = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  if (control.version !== 1 || Number(control.port) !== Number(process.argv[3])) {
    process.exit(1);
  }
  const token = control.shutdownToken || '';
  if (!token || token.length > 256) {
    process.exit(1);
  }
  process.stdout.write(String(token));
} catch {
  process.exit(1);
}
NODE
)" || return 1
  curl -fsS -m 5 -X POST -H "x-canai-shutdown-token: $token" \
    "http://127.0.0.1:$port/api/lifecycle/shutdown" >/dev/null 2>&1 || return 1
  local waited=0
  while [ "$waited" -lt 60 ]; do
    port_busy "$port" || return 0
    sleep 0.25; waited=$(( waited + 1 ))
  done
  return 1
}

if port_busy "$REQUESTED_PORT"; then
  status_body="$(status_json "$REQUESTED_PORT")"
  if [ -n "$status_body" ]; then
    fingerprint="$(print -r -- "$status_body" | node -e 'try{const b=JSON.parse(require("fs").readFileSync(0,"utf8"));process.stdout.write(b.serverFingerprint||"");}catch{}' 2>/dev/null || true)"
    mock="$(print -r -- "$status_body" | node -e 'try{const b=JSON.parse(require("fs").readFileSync(0,"utf8"));process.stdout.write(b.mockMode?"1":"");}catch{}' 2>/dev/null || true)"
    if [ -z "$mock" ] && [ "$fingerprint" = "$CANAI_SERVER_FINGERPRINT" ]; then
      say "CanAI is already running; opening it in the browser."
      say "Address: http://127.0.0.1:$REQUESTED_PORT. A second instance is not needed."
      [ "$NO_BROWSER" -eq 0 ] && open "http://127.0.0.1:$REQUESTED_PORT"
      exit 0
    fi
    say "Found an older server; shutting it down safely."
    request_shutdown "$REQUESTED_PORT" || die "The old server did not release its port. Close it manually and try again."
  else
    say "Port $REQUESTED_PORT is used by another program; looking for a free address."
  fi
fi

SELECTED_PORTS="$(find_free_port "$REQUESTED_PORT")" \
  || die "No free app port pair was found starting at $REQUESTED_PORT."
PORT_SELECTED="${SELECTED_PORTS%%:*}"
REMOTE_SELECTED="${SELECTED_PORTS#*:}"
export PORT="$PORT_SELECTED"
export CANAI_REMOTE_PORT="$REMOTE_SELECTED"
URL="http://127.0.0.1:$PORT"

# Лаунчер всегда запускает production: переменная могла остаться от ручного
# npm run dev и не должна воскресить демонстрационный режим.
unset CANAI_MOCK

print -r -- ""
say "Starting… The browser will open at $URL, when the app is ready."
say "To stop the app, close this window (or press Ctrl+C)."
print -r -- ""

# Открыть адрес мало — надо УБЕДИТЬСЯ, что браузер по нему пришёл. Браузер с
# несколькими профилями встречает холодный запуск выбором профиля и открытый
# адрес при этом теряет: приложение работает, а человек смотрит на чужой экран
# («канвас не открылся после обновления сам», 09.09.2026). Сервер отмечает,
# приходил ли кто-нибудь за страницей интерфейса (uiOpened) — по этому и
# повторяем заход; к этому времени профиль обычно уже выбран.
#
# ⚠️ Строку с адресом печатает САМ сервер, а не мы: он один знает, пришёл ли
# браузер, и пишет в то же окно. Правило общее с Windows-лаунчером.
watch_browser() {
  # ⚠️ Вторая переменная в ОДНОМ local не видит первую (ловушка zsh, из-за
  # которой порт получился бы пустым) — объявляем раздельно.
  local target="$1" i attempt
  local port="${target##*:}"
  for (( i = 0; i < 60; i++ )); do
    sleep 1
    [ -n "$(status_json "$port")" ] && break
  done
  [ -n "$(status_json "$port")" ] || return
  # ⚠️ Вкладка приложения УЖЕ открыта — вторая не нужна: две вкладки на одной
  # доске оставляют конфликтную копию. Живую вкладку сервер видит по опросу
  # состояния, который шлёт браузер (см. uiOpened.ts).
  #
  # ⚠️ Пауза нужна: у перезапущенного сервера отметка пуста, и открытой вкладке
  # надо дать успеть опросить его снова — иначе решим раньше времени и всё
  # равно откроем вторую.
  sleep 4
  case "$(status_json "$port")" in (*'"uiAlive":true'*) return ;; esac
  for attempt in 1 2; do
    open "$target" || true
    for (( i = 0; i < 12; i++ )); do
      sleep 1
      case "$(status_json "$port")" in (*'"uiOpened":true'*) return ;; esac
    done
  done
}

show_log_tail() {
  local log="$DATA_ROOT/logs/server.log"
  [ -f "$log" ] || return
  print -r -- ""
  say "Last lines of server/data/logs/server.log:"
  tail -n 15 "$log"
}
# ⚠️ Лаунчер умеет писать в журнал сервера — он единственный, кто остаётся жив,
# когда сервер умирает насовсем. Без этой строки в журнале просто пробел, и
# «постоянно вылетает» не отличить от «закрыли окно».
log_server_line() {
  local dir="$DATA_ROOT/logs"
  mkdir -p "$dir" 2>/dev/null || return 0
  print -r -- "[$(date -u +%Y-%m-%dT%H:%M:%S.000Z)] $1" >> "$dir/server.log" 2>/dev/null || true
}

# ⚠️ Фатальная ошибка самого Node (прежде всего нехватка памяти) печатается в
# консоль и исчезает вместе с окном. Штатный отчёт Node ничего не стоит, пока
# всё хорошо, и оставляет файл с причиной, стеками и памятью, когда плохо.
node_report_dir="$DATA_ROOT/logs"
mkdir -p "$node_report_dir" 2>/dev/null || true
case "$NODE_OPTIONS" in
  (*--report-on-fatalerror*) ;;
  (*) export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--report-on-fatalerror --report-directory=$node_report_dir" ;;
esac

# ── 5. Прокси ─────────────────────────────────────────────────────
# Там, где до сервера команды не достучаться напрямую, человек включает прокси
# в системе — браузер начинает работать, а приложение нет: Node переменные
# прокси сам не читает. Переключатель ставится ДО запуска: изнутри процесса он
# уже ничего не меняет. Без настроенного прокси ничего не трогаем.
#
# ⚠️ На маке берём только переменные окружения. Системную настройку (scutil
# --proxy) не читаем намеренно: там прокси часто задан автоскриптом PAC, а его
# разбор — отдельная работа, и молча взять «похожий» адрес хуже, чем не взять.
if [ -n "${HTTPS_PROXY:-}${https_proxy:-}${HTTP_PROXY:-}${http_proxy:-}" ]; then
  [ -n "${NODE_USE_ENV_PROXY:-}" ] || export NODE_USE_ENV_PROXY=1
  # Свои серверы мимо прокси: планшетная и гостевая страницы живут здесь же.
  [ -n "${NO_PROXY:-}${no_proxy:-}" ] || export NO_PROXY='localhost,127.0.0.1,::1,.local'
  say "The connection to the team server uses a proxy"
fi

# ── 6. Запуск с автоперезапуском ──────────────────────────────────
MAX_QUICK_FAILURES=3
quick_failures=0
# ⚠️ Адрес, на который браузер уже отправляли. Перезапуск на ТОМ ЖЕ адресе
# второй вкладки открывать не должен: первая никуда не делась и сама вернётся
# на связь, а две вкладки на одной доске заставляют сервер писать конфликтную
# копию — одно падение оборачивалось задвоенной доской. На НОВЫЙ адрес (порт
# успели занять) смотреть некому, там браузер открываем.
opened_url=""
while true; do
  if [ "$opened_url" != "$URL" ]; then
    if [ "$NO_BROWSER" -eq 0 ]; then
      watch_browser "$URL" &
      watcher=$!
    fi
    opened_url="$URL"
  fi
  started_at="$SECONDS"
  set +e
  npm --prefix server run start
  exit_code=$?
  set -e
  if [ -n "$watcher" ]; then kill "$watcher" 2>/dev/null || true; fi
  # ⚠️ Записываем ЛЮБОЙ конец сервера, включая обычный. В этом весь смысл:
  # если строки нет, а сервер записал сигнал — значит закрыли само окно и оно
  # унесло лаунчер с собой. Если строка есть — сервер ушёл сам, а лаунчер его
  # пережил. Две совсем разные беды, и отличить их больше нечем.
  log_server_line "[launcher] server stopped, exit code $exit_code"
  [ "$exit_code" -eq 0 ] && break

  if (( SECONDS - started_at < 10 )); then
    quick_failures=$(( quick_failures + 1 ))
  else
    quick_failures=1
  fi

  if [ "$quick_failures" -ge "$MAX_QUICK_FAILURES" ]; then
    print -r -- ""
    say "The server failed to start $quick_failures times in a row; stopping."
    show_log_tail
    print -r -- ""
    say "If the error repeats, send server/data/logs/server.log to the person supporting your installation"
    print -r -- ""
    if [ -t 0 ] && [ "$UNATTENDED" -eq 0 ]; then
      print -r -- "Press any key to close this window."
      read -k 1
    fi
    exit 1
  fi

  if port_busy "$PORT" || port_busy "$CANAI_REMOTE_PORT"; then
    selected="$(find_free_port $(( PORT + 1 )))" || die "No free app port pair was found after the startup conflict."
    PORT_SELECTED="${selected%%:*}"
    REMOTE_SELECTED="${selected#*:}"
    export PORT="$PORT_SELECTED"
    export CANAI_REMOTE_PORT="$REMOTE_SELECTED"
    URL="http://127.0.0.1:$PORT"
    say "The port was taken; choosing another free address: $URL"
  fi

  say "The server stopped unexpectedly (code $exit_code). Restarting in 2 seconds… (attempt $quick_failures of $MAX_QUICK_FAILURES)"
  sleep 2
done
