import assert from 'node:assert/strict'
import test from 'node:test'
import { componentInventory, missingComponentsLine } from './components.js'

// Опись портативных компонентов. Главное правило, ради которого она вообще
// пишется отдельным модулем: она НИЧЕГО НЕ КАЧАЕТ. Компоненты весят под сотню
// мегабайт, и тянуть их при старте — значит тратить чужой трафик за человека.

const allPresent = { exists: async () => true, ffmpeg: async () => ({ source: 'runtime' as const }), faces: async () => true, loginBrowser: async () => 'ready' as const }
// ffmpegDownloadable задаётся ЯВНО: иначе опись зависела бы от системы, где
// идёт прогон, — на Windows сборка качается, на macOS приезжает в поставке.
const nonePresent = { exists: async () => false, ffmpeg: async () => null, faces: async () => false, ffmpegDownloadable: () => true, loginBrowser: async () => 'missing' as const }

test('опись видит все компоненты и называет их человеческим языком', async () => {
  const list = await componentInventory(allPresent)
  assert.deepEqual(list.map((item) => item.id).sort(), ['face-models', 'ffmpeg', 'login-browser', 'yt-dlp'])
  for (const item of list) {
    assert.ok(item.name.length > 0, `${item.id}: нет имени`)
    assert.ok(item.purpose.length > 0, `${item.id}: не сказано, зачем он`)
    // Вес человек вправе знать ДО нажатия кнопки.
    assert.match(item.sizeHint, /MB/, `${item.id}: size is missing`)
  }
})

test('всё на месте — состояние ready и строки в лог нет', async () => {
  const list = await componentInventory(allPresent)
  assert.ok(list.every((item) => item.state !== 'missing'))
  // Молчание в логе — тоже сообщение: строку «всё хорошо» каждый запуск писать незачем.
  assert.equal(missingComponentsLine(list), null)
})

test('ничего не скачано — каждый помечен, и лог называет их', async () => {
  const list = await componentInventory(nonePresent)
  assert.ok(list.every((item) => item.state === 'missing'))
  const line = missingComponentsLine(list)
  assert.match(line ?? '', /not downloaded components/u)
  assert.match(line ?? '', /Settings/u, 'tell the user where the button is')
})

// ⚠️ Та же ошибка, что когда-то была с cloudflared (см. шапку components.ts):
// компонент числился «не скачан», а кнопки для него в настройках не было — и
// приложение каждый старт звало человека туда, где ничего нет. На macOS ffmpeg
// не качается ниоткуда, он лежит в папке с самого начала.
test('чего нельзя скачать — то и не зовёт к кнопке', async () => {
  const list = await componentInventory({ ...nonePresent, ffmpegDownloadable: () => false })
  const ffmpeg = list.find((item) => item.id === 'ffmpeg')
  assert.equal(ffmpeg?.state, 'unsupported')

  const line = missingComponentsLine(list)
  assert.ok(line, 'про остальные компоненты сказать надо')
  assert.doesNotMatch(line, /Processing video/u, 'do not point to a missing button')
})

// То же правило для браузера входа: на маке мы его не качаем, там он ставится
// обычным способом — значит и звать к кнопке в настройках нельзя.
test('браузер входа, которого не качаем, тоже не зовёт к кнопке', async () => {
  const list = await componentInventory({ ...nonePresent, loginBrowser: async () => 'unsupported' as const })
  assert.equal(list.find((item) => item.id === 'login-browser')?.state, 'unsupported')
  assert.doesNotMatch(missingComponentsLine(list) ?? '', /Browser for platform sign-in/u)
})

test('там, где сборка качается, всё как было', async () => {
  const list = await componentInventory({ ...nonePresent, ffmpegDownloadable: () => true })
  assert.equal(list.find((item) => item.id === 'ffmpeg')?.state, 'missing')
  assert.match(missingComponentsLine(list) ?? '', /Processing video and audio/u)
})

test('системный ffmpeg считается готовым, но помечен как чужой', async () => {
  // Разница важна: своя копия переедет вместе с папкой, системная — нет.
  const [ffmpeg] = await componentInventory({
    ...nonePresent,
    ffmpeg: async () => ({ source: 'system' as const }),
  })
  assert.equal(ffmpeg.state, 'ready')
  assert.equal(ffmpeg.system, true)
})
