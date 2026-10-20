#!/bin/zsh
# Собирает портативные ffmpeg и ffprobe для macOS и кладёт их в
# runtime/media-tools/ — туда, где приложение их ищет.
#
# ⚠️ ЗАЧЕМ СВОЯ СБОРКА. Готовой LGPL-сборки под macOS не существует. BtbN,
# откуда мы берём Windows-версию, macOS не собирает вовсе; evermeet.cx и
# Homebrew собраны с --enable-gpl и x264/x265, то есть целиком GPL — в
# продаваемое приложение такое класть нельзя.
#
# ⚠️ ЧТО НЕЛЬЗЯ ДОБАВЛЯТЬ. Ни --enable-gpl, ни --enable-nonfree, ни libx264,
# ни libx265. Единственная внешняя библиотека — LAME (LGPL): своего
# MP3-кодировщика у ffmpeg нет, а он нужен для «Отделить звук». Видео жмёт
# h264_videotoolbox — часть macOS, посторонней лицензии не приносит.
#
# Проверить результат: runtime/media-tools/ffmpeg -version | grep configuration
set -e

FFMPEG_VERSION=8.1.2
LAME_VERSION=3.100
FFMPEG_SHA=464beb5e7bf0c311e68b45ae2f04e9cc2af88851abb4082231742a74d97b524c
LAME_SHA=ddfe36cab873794038ae2c1210557ad34857a4b6bdc515785d1da9e175b1da1e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$ROOT/.ffmpeg-build"
DEPS="$WORK/deps"
TARGET="$ROOT/runtime/media-tools"
JOBS="$(sysctl -n hw.ncpu)"

verify() {  # файл, ожидаемая сумма
  local actual="$(shasum -a 256 "$1" | awk '{print $1}')"
  if [ "$actual" != "$2" ]; then
    echo "Checksum mismatch: $1" >&2
    echo "  expected: $2" >&2
    echo "  received: $actual" >&2
    exit 1
  fi
}

mkdir -p "$WORK"
cd "$WORK"

echo "[1/5] sources"
[ -f "ffmpeg-$FFMPEG_VERSION.tar.xz" ] || curl -sSL -o "ffmpeg-$FFMPEG_VERSION.tar.xz" "https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz"
[ -f "lame-$LAME_VERSION.tar.gz" ]     || curl -sSL -o "lame-$LAME_VERSION.tar.gz"     "https://downloads.sourceforge.net/project/lame/lame/$LAME_VERSION/lame-$LAME_VERSION.tar.gz"
verify "ffmpeg-$FFMPEG_VERSION.tar.xz" "$FFMPEG_SHA"
verify "lame-$LAME_VERSION.tar.gz"     "$LAME_SHA"

echo "[2/5] extracting"
rm -rf "lame-$LAME_VERSION" "ffmpeg-$FFMPEG_VERSION" "$DEPS" out
tar xzf "lame-$LAME_VERSION.tar.gz"
tar xJf "ffmpeg-$FFMPEG_VERSION.tar.xz"
mkdir -p "$DEPS"

echo "[3/5] LAME — library only, without the console program"
cd "$WORK/lame-$LAME_VERSION"
# В 3.100 в списке экспортов остался символ, которого в коде нет: без этого
# линковка падает на «lame_init_old».
sed -i '' '/lame_init_old/d' include/libmp3lame.sym
./configure --prefix="$DEPS" --disable-shared --enable-static --disable-frontend \
  --disable-dependency-tracking > "$WORK/lame-configure.log" 2>&1
make -j"$JOBS" > "$WORK/lame-make.log" 2>&1
make install >> "$WORK/lame-make.log" 2>&1

echo "[4/5] ffmpeg (${JOBS} threads, several minutes)"
cd "$WORK/ffmpeg-$FFMPEG_VERSION"
./configure \
  --prefix="$WORK/out" \
  --disable-shared --enable-static \
  --disable-autodetect \
  --enable-zlib \
  --disable-doc --disable-htmlpages --disable-manpages --disable-podpages --disable-txtpages \
  --disable-ffplay \
  --disable-debug \
  --enable-videotoolbox \
  --enable-audiotoolbox \
  --enable-encoder=h264_videotoolbox \
  --enable-encoder=aac \
  --enable-libmp3lame \
  --enable-encoder=libmp3lame \
  --extra-cflags="-I$DEPS/include" \
  --extra-ldflags="-L$DEPS/lib" \
  > "$WORK/ffmpeg-configure.log" 2>&1
make -j"$JOBS" > "$WORK/ffmpeg-make.log" 2>&1
make install >> "$WORK/ffmpeg-make.log" 2>&1

echo "[5/5] validating and installing to runtime/media-tools"
CONFIG="$("$WORK/out/bin/ffmpeg" -hide_banner -version 2>&1 | grep configuration)"
for forbidden in enable-gpl libx264 libx265 nonfree; do
  if echo "$CONFIG" | grep -q -- "$forbidden"; then
    echo "The build contains a GPL component ($forbidden); stopping." >&2
    exit 1
  fi
done
for needed in h264_videotoolbox libmp3lame aac; do
  "$WORK/out/bin/ffmpeg" -hide_banner -encoders 2>/dev/null | grep -q " $needed " || {
    echo "The build is missing the $needed encoder; stopping." >&2
    exit 1
  }
done

# PNG кодеки зависят от zlib. Проверяем не только наличие кодировщика в списке:
# настоящий roundtrip ловит ошибку линковки/регистрации, которая иначе проявится
# только у покупателя при импорте или экспорте картинки.
PNG_SMOKE="$WORK/png-smoke"
rm -rf "$PNG_SMOKE"
mkdir -p "$PNG_SMOKE"
"$WORK/out/bin/ffmpeg" -hide_banner -loglevel error -y \
  -f lavfi -i 'color=c=red:s=2x2' -frames:v 1 "$PNG_SMOKE/encoded.png"
test -s "$PNG_SMOKE/encoded.png"
"$WORK/out/bin/ffmpeg" -hide_banner -loglevel error \
  -i "$PNG_SMOKE/encoded.png" -frames:v 1 -f null -

mkdir -p "$TARGET"
strip "$WORK/out/bin/ffmpeg" "$WORK/out/bin/ffprobe" 2>/dev/null || true
cp "$WORK/out/bin/ffmpeg" "$WORK/out/bin/ffprobe" "$TARGET/"
chmod +x "$TARGET/ffmpeg" "$TARGET/ffprobe"

echo
echo "Done: $TARGET"
ls -la "$TARGET"
echo
echo "License from the binary itself:"
"$TARGET/ffmpeg" -hide_banner -L 2>&1 | head -4
