import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { gifFrameDelayMs, isAnimatedImageItem } from './animatedImageItem'
import { isGifReference, itemToRef } from './selection'

// Жалоба 22.09.2026: «ни на сетевой, ни на локальной доске не проигрываются GIF».

test('GIF узнаётся по mime, а без него — по адресу или имени', () => {
  assert.equal(isAnimatedImageItem({ src: '/media/a.gif', mime: 'image/gif' }), true)
  // У сетевой доски в адресе расширения нет — решает mime.
  assert.equal(isAnimatedImageItem({ src: '/api/cloud-assets/assets/ast_1', mime: 'image/gif' }), true)
  assert.equal(isAnimatedImageItem({ src: '/api/cloud-assets/assets/ast_1', mime: 'image/png' }), false)
  // Старый объект без mime: адрес со сбросом кэша и имя файла.
  assert.equal(isAnimatedImageItem({ src: '/media/a.GIF?v=123' }), true)
  assert.equal(isAnimatedImageItem({ src: '/api/cloud-assets/assets/ast_1', name: 'кот.gif' }), true)
  assert.equal(isAnimatedImageItem({ src: '/media/a.png' }), false)
})

test('GIF с непрозрачным адресом сетевой доски остаётся узнаваемым референсом', () => {
  const ref = itemToRef({
    id: 'gif', kind: 'image', x: 0, y: 0, w: 100, h: 80,
    src: '/api/cloud-assets/assets/ast_1', mime: 'image/gif', name: 'Анимация',
  })
  assert.ok(ref)
  assert.equal(isGifReference(ref), true)
  assert.equal(isGifReference({ ...ref, mime: 'image/png' }), false)
})

test('задержка кадра — как у браузеров: микросекунды в миллисекунды, нулевые — 100 мс', () => {
  assert.equal(gifFrameDelayMs(40_000), 40)
  assert.equal(gifFrameDelayMs(10_000), 100)
  assert.equal(gifFrameDelayMs(0), 100)
  assert.equal(gifFrameDelayMs(null), 100)
})

test('GIF рисует GifItem с плеером: движение — от плеера, неподвижный кадр — из превью', () => {
  const canvas = readFileSync(new URL('./KonvaCanvas.tsx', import.meta.url), 'utf8')
  assert.match(canvas, /isAnimatedImageItem\(item\)\) return \(\s*<GifItem[\s\S]{0,400}viewScale=\{previewScale\}/)
  const gif = readFileSync(new URL('./GifItem.tsx', import.meta.url), 'utf8')
  // ⚠️ Прежде тут требовался ОРИГИНАЛ: «превью — это WebP из первого кадра».
  // Но холст и у <img> с GIF рисует только первый кадр, то есть ровно превью,
  // а восемь оригиналов по 0,4–15 МБ занимали очередь картинок сетевой доски
  // (жалоба 27.09.2026 «всё равно медленно») — тест защищал ошибку.
  assert.match(gif, /screenPreviewSrc\(item\.src, previewWidth\.current\)/, 'неподвижный кадр — экранное превью')
  // Третьим доводом идёт центр объекта (очередь «от центра кадра», 3.5).
  assert.match(gif, /useImageEl\(shownSrc, item\.src[,)]/, 'не отдалось превью — показываем оригинал, а не дыру')
  assert.doesNotMatch(gif, /useImageEl\(item\.src\)/)
  assert.match(gif, /image=\{player\?\.canvas \?\? img\}/, 'холст рисует текущий кадр плеера')
  const tablet = readFileSync(new URL('../../../tablet/BoardItemView.tsx', import.meta.url), 'utf8')
  assert.match(tablet, /isAnimatedImageItem\(item\) \? item\.src : previewSrc\(/)
})

test('оригинал GIF плеер качает, только когда к GIF обратились', () => {
  // Каждый GIF в кадре тянул файл целиком при каждом появлении на экране:
  // на сетевой доске — десятки мегабайт через VPN ради анимации, которую
  // никто не запускал.
  const gif = readFileSync(new URL('./GifItem.tsx', import.meta.url), 'utf8')
  assert.doesNotMatch(gif, /useGifPlayer\(item\.src, true\)/, 'плеер не создаётся сразу для всех GIF')
  assert.match(gif, /useGifPlayer\(item\.src, wantPlayer\)/)
  assert.match(gif, /if \(selected\) setWantPlayer\(true\)/, 'выделили — пора готовить кадры')
  assert.match(gif, /playWhenReady\.current = true/, 'попросили играть раньше времени — запустим, как будет готово')
})

test('оболочка плеера одна на видео и GIF — одинаковые с виду ведут себя одинаково', () => {
  for (const name of ['VideoItem.tsx', 'GifItem.tsx']) {
    const source = readFileSync(new URL(`./${name}`, import.meta.url), 'utf8')
    assert.match(source, /from '\.\/mediaPlayerChrome'/, `${name}: оболочка из общего модуля`)
    for (const part of ['PlayPauseOverlay', 'MediaTimeBadge', 'MediaProgressBar', 'CaptureFrameButton']) {
      assert.match(source, new RegExp(`<${part}\\b`), `${name}: ${part}`)
    }
    assert.match(source, /useMediaPlayerHotkeys\(/, `${name}: клавиши общие`)
    assert.match(source, /useProgressScrub\(/, `${name}: перемотка общая`)
    assert.match(source, /createCanvasVideoPlaybackCommands\(/, `${name}: одно играет — другое стоит`)
  }
})

test('дорожку кадров ждём ДО полных данных: после `completed` её ещё нет', () => {
  // Поймано живой проверкой: сразу после `completed` selectedTrack равен null,
  // и анимация молча не начиналась — юнит-тест без браузера этого не видит.
  const player = readFileSync(new URL('./gifPlayer.ts', import.meta.url), 'utf8')
  const ready = player.indexOf('await decoder.tracks.ready')
  const completed = player.indexOf('await decoder.completed')
  assert.ok(ready > 0 && completed > ready, 'сначала tracks.ready, потом completed')
})
