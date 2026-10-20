#!/bin/zsh
# Переносит доски, файлы и ключ fal.ai из ПРЕЖНЕЙ версии CanAI в эту — порт
# migrate-data.ps1 для macOS (пункт 5.4 списка исправлений). Правишь один —
# правь оба: общего источника у них нет, как и у лаунчеров.
#
# ⚠️ Ничего не удаляет. Прежняя папка остаётся как была — её человек удалит сам,
# когда убедится, что доски на месте. То, что уже было в новой папке,
# откладывается рядом с отметкой времени, а не стирается.
#
# ⚠️ Копирование, а не перенос: прежняя папка — единственная страховка, пока
# новую версию не проверили. После копирования сверяются число файлов и объём.
#
# Аргументы (для проверок): $1 — папка прежней версии, $2 — «yes» без вопроса.
cd "$(dirname "$0")"
HERE="$(pwd -P)"
FROM="${1:-}"
ANSWER="${2:-}"
SKIP='runtime-control.json'

say() { print -r -- "[CanAI] $*" }
fail() {
  print -r -- ""
  print -r -- "[CanAI] $*"
  print -r -- "[CanAI] Nothing was deleted; the old folder was left untouched."
  exit 1
}

# Файл управления запущенным экземпляром принадлежит ПРЕЖНЕЙ копии: в новой он
# указывал бы на чужой сервер. Его не переносим и при сверке не считаем.
count_files() {
  find "$1" -type f ! -name "$SKIP" | wc -l | tr -d ' '
}
count_bytes() {
  find "$1" -type f ! -name "$SKIP" -exec stat -f %z {} + | awk '{ total += $1 } END { printf "%d", total + 0 }'
}
human_size() {
  awk -v b="$1" 'BEGIN {
    if (b >= 1073741824) printf "%.1f GB", b / 1073741824
    else if (b >= 1048576) printf "%d MB", b / 1048576
    else printf "%d KB", (b + 1023) / 1024
  }'
}

# 1. Где прежняя версия.
if [ -z "$FROM" ]; then
  FROM="$(osascript -e 'POSIX path of (choose folder with prompt "Choose the OLD CanAI folder (the one containing “Start CanAI.command”)")' 2>/dev/null)" \
    || fail 'No folder was selected; nothing was copied.'
fi
OLD="$(cd "${FROM%/}" 2>/dev/null && pwd -P)" || fail "The folder “$FROM” cannot be opened."
[ "$OLD" = "$HERE" ] && fail 'The NEW folder was selected. Choose the old folder.'
case "$HERE/" in
  "$OLD"/*) fail 'The new version is inside the old one. Extract it into a separate folder beside it.' ;;
esac
OLD_DATA="$OLD/server/data"
OLD_ENV="$OLD/server/.env"
[ -f "$OLD_DATA/projects.json" ] \
  || fail "The folder “$OLD” has no CanAI boards (server/data/projects.json is missing). Choose the old folder containing “Start CanAI.command”."

boards="$(find "$OLD_DATA/projects" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')"
source_files="$(count_files "$OLD_DATA")"
source_bytes="$(count_bytes "$OLD_DATA")"
say "Old version: $OLD"
say "Boards: $boards files: $source_files size: $(human_size "$source_bytes")."
if [ -f "$OLD_ENV" ]; then say 'fal.ai key: found; it will be copied.'; else say 'fal.ai key: not found.'; fi
if [ "$ANSWER" != 'yes' ]; then
  read -q "?[CanAI] Copy everything to the new version? The old folder will stay unchanged (y/n) " || { print -r -- ""; fail 'Copy cancelled.' }
  print -r -- ""
fi

# 2. Обе версии обязаны стоять: копировать из-под работающего сервера нельзя —
# он пишет доску прямо в этот момент, и копия вышла бы с дырой.
for folder in "$OLD" "$HERE"; do
  if [ -x "$folder/stop.command" ]; then
    "$folder/stop.command" || fail "CanAI in “$folder” could not be stopped. Close its window and run the copy again."
  fi
done

# 3. То, что уже есть в новой папке, — в сторону, а не в корзину.
stamp="$(date '+%Y-%m-%d_%H-%M-%S')"
NEW_DATA="$HERE/server/data"
NEW_ENV="$HERE/server/.env"
mkdir -p "$HERE/server"
if [ -e "$NEW_DATA" ]; then
  mv "$NEW_DATA" "$HERE/server/data-before-migration-$stamp" || fail 'Could not set aside the new version data.'
  say "New version data set aside: server/data-before-migration-$stamp"
fi
if [ -e "$NEW_ENV" ]; then
  mv "$NEW_ENV" "$HERE/server/.env-before-migration-$stamp" || fail 'Could not set aside the new version key.'
  say "New version key set aside: server/.env-before-migration-$stamp"
fi

# 4. Копирование.
say 'Copying boards and files…'
rsync -a --exclude "$SKIP" "$OLD_DATA/" "$NEW_DATA/" || fail 'Copy failed.'
if [ -f "$OLD_ENV" ]; then
  cp -p "$OLD_ENV" "$NEW_ENV" || fail 'The fal.ai key could not be copied.'
fi

# 5. Сверка: столько же файлов и столько же байт.
copied_files="$(count_files "$NEW_DATA")"
copied_bytes="$(count_bytes "$NEW_DATA")"
if [ "$copied_files" != "$source_files" ] || [ "$copied_bytes" != "$source_bytes" ]; then
  fail "Not everything was copied: files $copied_files of $source_files, $(human_size "$copied_bytes") of $(human_size "$source_bytes"). Check free disk space and run the copy again."
fi

print -r -- ""
say "Done: copied boards $boards, files $copied_files ($(human_size "$copied_bytes"))."
say 'Start CanAI.command in THIS folder and check your boards.'
say 'Delete the old folder only after you verify everything is in place.'
exit 0
