// @ts-expect-error Клиентские тесты запускаются через tsx с Node-типами.
import assert from 'node:assert/strict'
// @ts-expect-error Production-клиент не зависит от Node-типов.
import test from 'node:test'
import { decidePaste, isOwnClipboardText, OWN_CLIPBOARD_TYPE } from './pasteDecision.js'

const ownMarker = JSON.stringify({ type: OWN_CLIPBOARD_TYPE, items: [{ id: 'a' }] })

const base = {
  hasMediaFiles: false,
  focusInInput: false,
  clipboardText: '',
  hasInternalItems: false,
  mirrorFailed: false,
}

test('файлы из буфера всегда важнее всего', () => {
  assert.equal(decidePaste({ ...base, hasMediaFiles: true, hasInternalItems: true }), 'media')
  assert.equal(
    decidePaste({ ...base, hasMediaFiles: true, focusInInput: true }),
    'media',
  )
})

test('файл, лежавший в буфере ДО своей неудавшейся копии, не подменяет её', () => {
  // Жалоба 01.10.2026: «копирую одну картинку, а вставляется другая». В
  // системном буфере остался давний снимок экрана, а своя копия туда не легла.
  assert.equal(
    decidePaste({ ...base, hasMediaFiles: true, hasInternalItems: true, mirrorFailed: true }),
    'internal',
  )
  // Своей копии нет вовсе — тогда файл и есть то, что человек хочет вставить.
  assert.equal(decidePaste({ ...base, hasMediaFiles: true, mirrorFailed: true }), 'media')
})

test('в поле ввода вставляет браузер, а не холст', () => {
  assert.equal(
    decidePaste({ ...base, focusInInput: true, clipboardText: 'привет', hasInternalItems: true }),
    'input',
  )
})

test('свежий внешний текст побеждает старый внутренний буфер', () => {
  // Главный случай: пользователь когда-то скопировал объект на холсте (буфер в
  // localStorage живёт вечно), а сейчас скопировал текст из браузера. Раньше
  // появлялись СТАРЫЕ объекты, и вставка текста на холст была сломана навсегда.
  assert.equal(
    decidePaste({
      ...base,
      clipboardText: 'свежий текст из браузера',
      hasInternalItems: true,
    }),
    'text',
  )
})

test('своя метка в системном буфере отдаёт ход внутреннему буферу', () => {
  // Ctrl+C по объектам холста → Ctrl+V обязан вставить ОБЪЕКТЫ, а не JSON-текст.
  assert.equal(
    decidePaste({ ...base, clipboardText: ownMarker, hasInternalItems: true }),
    'internal',
  )
})

test('PNG-превью собственной копии не заменяет группу одним изображением', () => {
  // Ctrl+C по выделению с картинкой кладёт в системный буфер сразу два
  // представления: PNG для внешних программ и метку CanAI со всей группой.
  // Внутри CanAI обязана вставляться группа, иначе останется только PNG первой
  // картинки и остальные выделенные объекты потеряются.
  assert.equal(
    decidePaste({
      ...base,
      hasMediaFiles: true,
      clipboardText: ownMarker,
      hasInternalItems: true,
    }),
    'internal',
  )
})

test('известный провал записи в системный буфер оставляет ход внутреннему', () => {
  // Если запись не прошла (нет прав, окно не в фокусе), в системном буфере
  // лежит чужой старый текст. Принять его за «свежую копию» нельзя — иначе
  // Ctrl+C→Ctrl+V на холсте вставлял бы посторонний текст вместо объектов.
  assert.equal(
    decidePaste({
      ...base,
      mirrorFailed: true,
      clipboardText: 'чужой старый текст',
      hasInternalItems: true,
    }),
    'internal',
  )
})

test('после перезапуска ссылка из системного буфера побеждает давнюю копию', () => {
  // Тот самый баг: внутренний буфер живёт в localStorage и переживает
  // перезапуск, а «мы успели записать в системный» раньше было флагом в
  // памяти модуля и обнулялось при каждом запуске. Итог: стоило когда-то
  // скопировать объекты на холсте — и после перезапуска вставка ссылки
  // МОЛЧА клала на холст те самые старые объекты вместо ссылки.
  //
  // Провала записи не было, значит системному буферу верим: пользователь
  // копировал снаружи позже, чем мы клали свою метку.
  assert.equal(
    decidePaste({
      ...base,
      mirrorFailed: false,
      clipboardText: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      hasInternalItems: true,
    }),
    'text',
  )
})

test('своя метка в системном буфере всегда отдаёт ход объектам', () => {
  // Копия объектов остаётся в системном буфере и после перезапуска — по ней
  // и узнаём, что снаружи с тех пор ничего не копировали.
  assert.equal(
    decidePaste({ ...base, clipboardText: ownMarker, hasInternalItems: true }),
    'internal',
  )
})

test('пустой внутренний буфер: текст идёт на холст', () => {
  assert.equal(decidePaste({ ...base, clipboardText: 'заметка' }), 'text')
  assert.equal(
    decidePaste({ ...base, mirrorFailed: true, clipboardText: 'заметка' }),
    'text',
  )
})

test('вставлять нечего', () => {
  assert.equal(decidePaste(base), 'none')
  assert.equal(decidePaste({ ...base, clipboardText: '   \n  ' }), 'none')
})

test('распознавание своей метки не ломается о мусор', () => {
  assert.equal(isOwnClipboardText(ownMarker), true)
  assert.equal(isOwnClipboardText('{не json'), false)
  assert.equal(isOwnClipboardText('обычный текст'), false)
  assert.equal(isOwnClipboardText('{"type":"чужое"}'), false)
  assert.equal(isOwnClipboardText(''), false)
})
