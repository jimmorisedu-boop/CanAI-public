#!/bin/zsh
# Собирает поставку для macOS — порт make-dist.ps1.
#
# ⚠️ Собирать НАДО НА МАКЕ, и это не удобство, а необходимость: во-первых,
# zip с Windows не хранит бит исполняемости, и «Start CanAI.command» в
# release ZIP не запустился бы двойным кликом; во-вторых, THIRD-PARTY-LICENSES
# собирается из УСТАНОВЛЕННЫХ пакетов, а они платформенные.
#
# ⚠️ В отличие от Windows-поставки СЮДА КЛАДЁТСЯ ffmpeg. Скачать его на маке
# неоткуда: LGPL-сборок под macOS не существует, а публичные собраны с x264 и
# потому GPL. Нашу собственную сборку делает scripts/build-ffmpeg-macos.sh.
set -e
cd "$(dirname "$0")"
ROOT="$PWD"

say() { print -r -- "[dist] $*" }
die() { print -r -- "[dist] ERROR: $*" >&2; exit 1 }

[ "$(uname -m)" = arm64 ] || die 'macOS builds must run on Apple Silicon (arm64)'

[ -x "$ROOT/runtime/node/bin/node" ] && export PATH="$ROOT/runtime/node/bin:$PATH"

say 'Checking types…'
npm run check || die 'type check failed'

say 'Building the UI…'
npm run build || die 'could not build the UI'

# ffmpeg обязан быть готов ДО упаковки: собирать его молча здесь нельзя —
# это несколько минут, и человек должен знать, что происходит.
FFMPEG="$ROOT/runtime/media-tools/ffmpeg"
FFPROBE="$ROOT/runtime/media-tools/ffprobe"
if [ ! -x "$FFMPEG" ] || [ ! -x "$FFPROBE" ]; then
  die 'runtime/media-tools/ffmpeg is missing; run scripts/build-ffmpeg-macos.sh first'
fi
CONFIG="$("$FFMPEG" -hide_banner -version 2>&1 | grep configuration || true)"
for forbidden in enable-gpl libx264 libx265 nonfree; do
  print -r -- "$CONFIG" | grep -q -- "$forbidden" \
    && die "the ffmpeg build contains a GPL component ($forbidden); it cannot be distributed"
done
say 'ffmpeg is present and has no GPL components.'

STAMP="$(date +%Y-%m-%d)"
OUT="$ROOT/dist-package/CanAI-$STAMP"
rm -rf "$ROOT/dist-package"
mkdir -p "$OUT"

# Намеренно НЕ копируется: server/.env (release user вводит свой ключ),
# server/data (личные доски), node_modules, runtime/node (лаунчер скачает
# инфраструктуру), update.* (служебный обновлятор разработчика не входит в архив).
INCLUDE=(
  client server packages package.json package-lock.json
  'Start CanAI.command' 'Stop CanAI.command' start.command stop.command
  'Migrate data.command' migrate-data.command
  README.md USER-GUIDE.md TABLET-GUIDE.md CHANGELOG.md SECURITY.md
  THIRD-PARTY-NOTICES.md licenses
  docs/agents
  docs/GETTING-STARTED.md docs/help
  docs/images/assistant.jpg docs/images/assets.jpg
  docs/images/canvas.jpg docs/images/help.jpg
  docs/images/tablet.jpg docs/images/workflows.jpg
  docs/images/gallery.jpg docs/images/assistant-expanded.jpg
  docs/images/references.jpg docs/images/compare.jpg
  docs/images/timeline.jpg docs/images/trash.jpg
  docs/images/versions.jpg
  LICENSE
)
HAS_AUTHORING_PROTOCOL=0
[ -f "$ROOT/docs/public/AGENT-PROTOCOL.md" ] && HAS_AUTHORING_PROTOCOL=1
HAS_PUBLIC_MANIFEST=0
if [ -f "$ROOT/PUBLIC-SOURCE-MANIFEST.json" ] && node -e '
  try {
    const manifest = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))
    process.exit(manifest.format === "canai-public-source" && manifest.version === 1 ? 0 : 1)
  } catch { process.exit(1) }
' "$ROOT/PUBLIC-SOURCE-MANIFEST.json"; then
  HAS_PUBLIC_MANIFEST=1
fi
if [ "$HAS_AUTHORING_PROTOCOL" -eq 0 ] && [ "$HAS_PUBLIC_MANIFEST" -eq 0 ]; then
  die 'public protocol source is missing (expected docs/public/AGENT-PROTOCOL.md or a valid PUBLIC-SOURCE-MANIFEST.json)'
fi
if [ "$HAS_PUBLIC_MANIFEST" -eq 1 ] && [ ! -f "$ROOT/docs/agents/README.md" ]; then
  die 'public protocol README is missing from the exported source'
fi
for item in "${INCLUDE[@]}"; do
  [ -e "$ROOT/$item" ] || die "required file is missing: $item"
  say "+ $item"
  if [ -d "$ROOT/$item" ]; then
    # dist-tablet-cloud — планшетная страница ДЛЯ СЕРВЕРА КОМАНДЫ: её раздаёт
    # он сам, в поставке она не открывается ничем и весит 28 МБ.
    RSYNC_ARGS=(
      -a
      --exclude node_modules --exclude data --exclude dist-package --exclude .git
      --exclude dist-tablet-cloud --exclude '.env' --exclude '*.env*'
    )
    # The authoring checkout contains private agent implementation notes. The
    # release ships the short public protocol instead (copied below).
    if [ "$item" = "docs/agents" ]; then
      RSYNC_ARGS+=(--exclude CLOUD.md --exclude IMPLEMENTATION.md --exclude ADAPTATION.md)
      [ "$HAS_AUTHORING_PROTOCOL" -eq 1 ] && RSYNC_ARGS+=(--exclude README.md)
    fi
    rsync "${RSYNC_ARGS[@]}" "$ROOT/$item/" "$OUT/$item/"
  else
    mkdir -p "$OUT/$(dirname "$item")"
    cp -p "$ROOT/$item" "$OUT/$item"
  fi
done

if [ "$HAS_AUTHORING_PROTOCOL" -eq 1 ]; then
  say '+ docs/agents/README.md (public protocol)'
  mkdir -p "$OUT/docs/agents"
  cp -p "$ROOT/docs/public/AGENT-PROTOCOL.md" "$OUT/docs/agents/README.md"
fi

say 'Building the third-party license list directly into the package…'
[ -f "$ROOT/scripts/generate-third-party.mjs" ] || die 'third-party license generator is missing'
node "$ROOT/scripts/generate-third-party.mjs" "$OUT/THIRD-PARTY-LICENSES.txt" \
  || die 'could not build the license list'

# Номер сборки — файлом: в release ZIP нет .git, а разбор жалобы начинается
# с вопроса, какая у него версия (пункт 5.1 списка исправлений).
say 'Writing build number…'
npm --prefix "$ROOT/server" run build-info -- "$OUT" || die 'build number is unknown'
[ -f "$OUT/build-info.json" ] || die 'the package has no build number'

say '+ runtime/media-tools (ffmpeg, ffprobe)'
mkdir -p "$OUT/runtime/media-tools"
cp -p "$FFMPEG" "$FFPROBE" "$OUT/runtime/media-tools/"

# ⚠️ Опись лицензий генерируем ПРЯМО В ПОСТАВКУ, а не в репозиторий. Она
# собирается из УСТАНОВЛЕННЫХ пакетов, а они платформенные: запуск на маке
# подменил бы отслеживаемый файл darwin-сборками вместо win32, и такой файл
# попал бы в release ZIP для Windows.
[ -f "$OUT/client/dist/index.html" ] || die 'the package has no built UI'
[ -f "$OUT/client/dist/tablet/tablet.html" ] || die 'the package has no tablet page'
[ -e "$OUT/server/.env" ] && die 'a secret was included in the package'
[ -e "$OUT/server/data" ] && die 'personal data was included in the package'
[ -f "$OUT/client/public/fonts/OFL.txt" ] || die 'font license is missing'
[ -n "$(ls -A "$OUT/licenses" 2>/dev/null)" ] || die 'licenses folder with full LGPL texts is missing'
[ -e "$OUT/client/dist-tablet-cloud" ] && die 'the team-server tablet build was included in the package'
[ "$(wc -c < "$OUT/THIRD-PARTY-LICENSES.txt")" -ge 10000 ] || die 'the license list is incomplete'
[ -f "$OUT/LICENSE" ] || die 'project license is missing from the package'
for launcher in 'Start CanAI.command' 'Stop CanAI.command' start.command stop.command \
    'Migrate data.command' migrate-data.command; do
  [ -x "$OUT/$launcher" ] || die "executable bit was lost: $launcher"
done

[ -f "$ROOT/scripts/scan-secrets.mjs" ] || die 'secret scanner is missing'
say 'Scanning package for secrets…'
node "$ROOT/scripts/scan-secrets.mjs" --source "$OUT" --mode dir --require-gitleaks \
  || die 'secret scan failed'

ZIP="$ROOT/dist-package/CanAI-$STAMP-macos.zip"
say "Packaging $ZIP …"
# ditto, а не zip: он сохраняет права доступа, и двойной клик по .command у
# пользователя сработает.
( cd "$ROOT/dist-package" && ditto -c -k --sequesterRsrc --keepParent "CanAI-$STAMP" "$ZIP" ) \
  || die 'could not package the archive'

ZIP_NAME="$(basename "$ZIP")"
ZIP_HASH="$(shasum -a 256 "$ZIP" | awk '{print $1}')"
print -r -- "$ZIP_HASH  $ZIP_NAME" > "$ZIP.sha256"

say "Checksum: $ZIP.sha256 ($ZIP_HASH)"
say "Done: $ZIP ($(du -h "$ZIP" | cut -f1))"
