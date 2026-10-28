import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

// ⚠️ «Применить» — единственная кнопка, ради которой заходят в режим правки
// клипа, и она обязана оставаться на своей строке. Перенос строки флексбокс
// решает по БАЗОВЫМ размерам, а не по сжатым: пока итог мерился своим текстом,
// на обычном окне 1217px кнопка уезжала на вторую строку к левому краю — и
// прыгала туда ровно в тот момент, когда человек убирал кусок и строка итога
// становилась длиннее. Правило общее с подсказкой о варианте модели в
// промпт-баре: пояснение уступает место рабочим элементам, а не наоборот.
// То же правило держит строка состояния транспорта: сообщение режима не
// выталкивает кнопку «Снять кадр».
const css = fs.readFileSync(new URL('../../../styles/timeline.css', import.meta.url), 'utf8')

function rule(selector: string): string {
  const at = css.indexOf(selector + ' {')
  assert.notEqual(at, -1, `в timeline.css нет правила ${selector}`)
  return css.slice(at, css.indexOf('}', at))
}

function squeezes(selector: string): void {
  const body = rule(selector)
  assert.match(body, /flex:\s*1\s+1\s+0/u, `${selector}: обязан иметь нулевой базовый размер`)
  assert.match(body, /min-width:\s*0/u, `${selector}: без min-width: 0 флекс-элемент не ужимается ниже содержимого`)
}

test('итог в строке монтажа сжимается, а не выталкивает «Применить» на вторую строку', () => {
  squeezes('.timeline-result')
  const result = rule('.timeline-result')
  assert.match(result, /text-overflow:\s*ellipsis/u, 'сжатый текст обрывается многоточием')
  assert.match(result, /white-space:\s*nowrap/u)
})

test('строка состояния транспорта тоже уступает место кнопке «Снять кадр»', () => {
  squeezes('.tl-live')
  const text = rule('.tl-live-text')
  assert.match(text, /text-overflow:\s*ellipsis/u)
  assert.match(text, /white-space:\s*nowrap/u)
  // сам транспорт не переносится на вторую строку: главная кнопка остаётся справа
  assert.doesNotMatch(rule('.tl-transport'), /flex-wrap:\s*wrap/u)
})

test('полный текст итога доступен подсказкой — сжатый обрывается', () => {
  const montage = fs.readFileSync(new URL('./TimelineMontage.tsx', import.meta.url), 'utf8')
  assert.match(
    montage,
    /className="timeline-result"\s+title=\{session\.summary\}/u,
    'у сжимаемой строки обязан быть title с полным текстом',
  )
})

test('«Применить» — последний в строке монтажа, итог стоит перед ним', () => {
  const montage = fs.readFileSync(new URL('./TimelineMontage.tsx', import.meta.url), 'utf8')
  const result = montage.indexOf('className="timeline-result"')
  const apply = montage.indexOf("label={t('Apply edits')}")
  assert.ok(result !== -1 && apply !== -1 && result < apply, 'итог — перед главной кнопкой')
})

test('законы UX: транспорт центрирован под превью, единственная primary-кнопка — Apply edits, дорожка двухэтажная', () => {
  const transport = fs.readFileSync(new URL('./TimelineTransport.tsx', import.meta.url), 'utf8')
  const montage = fs.readFileSync(new URL('./TimelineMontage.tsx', import.meta.url), 'utf8')
  const track = fs.readFileSync(new URL('./TimelineTrack.tsx', import.meta.url), 'utf8')
  const preview = fs.readFileSync(new URL('./TimelinePreview.tsx', import.meta.url), 'utf8')

  // Эффект фон Ресторфф: в транспорте нет конкурирующей primary-кнопки на захвате кадра (S)
  assert.doesNotMatch(transport, /\bprimary\b/u)
  assert.match(transport, /keys="S"/u)
  assert.match(transport, /keys="B"/u)
  assert.match(transport, /tl-transport-center/u)

  // Полка кадров живёт всплывающей панелью внутри .tl-preview, не разрывая видео и транспорт,
  // а поверх верхнего края видео нет плашки имени (.tl-name), перекрывающей сам кадр.
  assert.match(preview, /TimelineFramesShelf/u)
  assert.doesNotMatch(preview, /tl-name/u)

  // Двухэтажная дорожка: чистый рельс линейки (.tl-ruler) + плёнка с аудиоволной (.tl-waveform)
  assert.match(track, /className="tl-ruler"/u)
  assert.match(track, /tl-waveform/u)

  // Группировка инструментов монтажа с новыми горячими клавишами C, X, Q, W | F, A
  for (const key of ['keys="C"', 'keys="X"', 'keys="Q"', 'keys="W"', 'keys="F"', 'keys="A"', 'keys="Enter"']) {
    assert.ok(montage.includes(key), `в TimelineMontage должна быть клавиша ${key}`)
  }
  assert.match(montage, /tl-divider/u)
})
