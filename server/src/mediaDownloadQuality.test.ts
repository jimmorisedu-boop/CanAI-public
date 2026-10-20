import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

// Требование пользователя 19.08.2026: «качать должен всегда в максимальном
// качестве». Настоящий максимум — это ОТДЕЛЬНЫЕ дорожки видео и звука (выше
// 1080p единым файлом не бывает) и правильный клиент YouTube. Всё это живые
// замеры, которые из кода не выводятся, — поэтому их держит сторож.

const source = fs.readFileSync(new URL('./mediaImportManager.ts', import.meta.url), 'utf8')

test('первым делом просим web_embedded — только он отдаёт высокое качество целиком', () => {
  // Замер 19.08.2026 на одном и том же ролике: клиент по умолчанию
  // (android_vr) обрывается на ~61 МБ с 403, tv/mweb/ios дают 360p, а
  // web_embedded скачал 1080p60 целиком и на втором ролике — 3840×2160.
  assert.match(source, /player_client=web_embedded/)
  const webEmbedded = source.indexOf('player_client=web_embedded')
  const singleStream = source.indexOf("'-f', 'b'")
  assert.ok(webEmbedded > 0 && singleStream > webEmbedded,
    'лучший единый поток — последняя ступенька, а не первая')
})

test('максимум просится раздельными дорожками, без потолка по высоте', () => {
  // bv*+ba, а не «b»: единым файлом YouTube отдаёт от силы 720p.
  assert.match(source, /'-f', 'bv\*\[ext=mp4\]\+ba\[ext=m4a\]\/bv\*\+ba'/)
  assert.doesNotMatch(source, /height<=\d+/, 'потолка по высоте быть не должно — 4K берём как есть')
})

test('без ffmpeg раздельных дорожек не просим — склеивать нечем', () => {
  assert.match(source, /const merged = ffmpeg/)
  assert.match(source, /merged \? \[merged\] : \[\]/)
})

test('после неудачной попытки обрывки убираются', () => {
  // Обрыв оставляет недокачанный кусок (замер: 61 МБ), а следующая попытка
  // пишет под другим именем — без уборки мусор осел бы в media.
  assert.match(source, /lastError = error[\s\S]{0,400}cleanupParts\(task\.id\)/)
})

test('отмена не перебивается повтором', () => {
  // «Стоп» нажал человек: следующую попытку заводить нельзя.
  assert.match(source, /if \(signal\?\.aborted\) throw error/)
})
