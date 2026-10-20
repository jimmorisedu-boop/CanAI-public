import assert from 'node:assert/strict'
import test from 'node:test'
import { fitInfoLine, infoLineParts, middleTruncate } from './itemInfoLine'

// Ширину считаем «по знаку»: в тесте важна не гарнитура, а правило подгонки.
const measure = (text: string) => text.length * 6

test('у импортированного файла первым идёт имя, у генерации — модель', () => {
  const imported = infoLineParts({ name: 'морской_закат.png', naturalWidth: 1024, naturalHeight: 1536, fileSize: '2,3 МБ' })
  assert.equal(imported.title, 'морской_закат.png')
  assert.equal(imported.tech, '1024×1536 · 2,3 МБ')

  // ⚠️ У генерации имя файла машинное и человеку не говорит ничего, а модель —
  // ровно то, что ищут глазами, сравнивая две картинки на доске.
  const generated = infoLineParts({ name: 'fal-1737281923.png', modelName: 'Seedream 5 Pro', naturalWidth: 2048, naturalHeight: 2048 })
  assert.equal(generated.title, 'Seedream 5 Pro')
  assert.equal(generated.tech, '2048×2048')
})

test('длительность встаёт в тот же ряд, пустые части не оставляют разделителей', () => {
  const video = infoLineParts({ name: 'clip.mp4', naturalWidth: 1920, naturalHeight: 1080, durationText: '0:12', fileSize: '8,4 МБ' })
  assert.equal(video.tech, '1920×1080 · 0:12 · 8,4 МБ')
  assert.equal(infoLineParts({ name: 'a.png' }).tech, '')
  assert.equal(infoLineParts({}).title, '')
})

test('путь до файла в подпись не идёт', () => {
  assert.equal(infoLineParts({ name: 'C:/media/съёмка/кадр_01.png' }).title, 'кадр_01.png')
})

test('усечение по середине сохраняет хвост — версию и расширение', () => {
  const cut = middleTruncate('морской_закат_финальный_вариант_v7.png', 22)
  assert(cut.length <= 22, cut)
  assert(cut.startsWith('морской'), cut)
  // ⚠️ Обрезка с конца сделала бы «…_v7.png» и «…_v8.png» неразличимыми.
  assert(cut.endsWith('v7.png'), cut)
  assert(cut.includes('…'))
  // Короткое имя не трогаем вовсе.
  assert.equal(middleTruncate('a.png', 22), 'a.png')
})

test('режется только имя, техника остаётся целой', () => {
  const fitted = fitInfoLine({
    title: 'морской_закат_финальный_вариант_v7.png',
    tech: '1024×1536 · 2,3 МБ',
    maxTextWidth: 6 * 40,
    measureTitle: measure,
    measureTech: measure,
    gap: 6,
  })
  assert(fitted)
  assert.equal(fitted.tech, '1024×1536 · 2,3 МБ', 'по технике сравнивают — её не режем')
  assert(fitted.title.includes('…'))
  assert(fitted.title.endsWith('v7.png'))
})

test('когда под имя места не осталось — показываем технику, а не обрубок', () => {
  const fitted = fitInfoLine({
    title: 'морской_закат_финальный_вариант_v7.png',
    tech: '1024×1536 · 2,3 МБ',
    maxTextWidth: 6 * 19,
    measureTitle: measure,
    measureTech: measure,
    gap: 6,
  })
  assert.deepEqual(fitted, { title: '', tech: '1024×1536 · 2,3 МБ' })
})

test('не влезла даже техника — не показываем ничего', () => {
  assert.equal(fitInfoLine({
    title: 'имя.png',
    tech: '1024×1536 · 2,3 МБ',
    maxTextWidth: 10,
    measureTitle: measure,
    measureTech: measure,
    gap: 6,
  }), null)
})

test('широкому объекту хватает места на всё целиком', () => {
  const fitted = fitInfoLine({
    title: 'закат.png',
    tech: '1024×1536',
    maxTextWidth: 600,
    measureTitle: measure,
    measureTech: measure,
    gap: 6,
  })
  assert.deepEqual(fitted, { title: 'закат.png', tech: '1024×1536' })
})
