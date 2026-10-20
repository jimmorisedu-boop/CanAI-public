// @ts-expect-error Клиентские тесты запускаются через tsx с Node-типами.
import assert from 'node:assert/strict'
// @ts-expect-error Production-клиент не зависит от Node-типов.
import test from 'node:test'
import type { CanvasItem } from './types.js'
import { canvasItemFileName, sketchResultName } from './mediaFileName.js'
import { reserveExportNumbersForProject } from './zipExport.js'

// Окружение браузера: скачивание отдаёт архив ссылкой через URL.createObjectURL.
// Содержимое файла заглушка отдаёт БАЙТАМИ, а не Blob: JSZip в Node вообще не
// умеет принимать Blob (его getTypeOf такого типа не знает) — это ограничение
// библиотеки, к проверяемой логике имён отношения не имеющее.
let captured: Blob | null = null
let downloadClicks = 0
let downloadName = ''
const g = globalThis as Record<string, unknown>

g.fetch = async () => ({ ok: true, blob: async () => new Uint8Array([1, 2, 3]) })
g.document = {
  createElement: () => ({
    href: '',
    download: '',
    click(this: { download: string }) {
      downloadClicks++
      downloadName = this.download
    },
    remove() {},
  }),
  body: { appendChild() {} },
}
;(g.URL as unknown as Record<string, unknown>).createObjectURL = (blob: Blob) => {
  captured = blob
  return 'blob:test'
}
;(g.URL as unknown as Record<string, unknown>).revokeObjectURL = () => {}

function item(patch: Partial<CanvasItem>): CanvasItem {
  return { id: 'i1', kind: 'image', x: 0, y: 0, w: 10, h: 10, ...patch } as CanvasItem
}

test('local ProjectRef reserves export numbers through the local provider', async () => {
  const calls: string[] = []
  const local = async (id: string) => {
    calls.push(`local:${id}`)
    return { board: 'Локальная', starts: { '1': 1 } }
  }
  assert.equal((await reserveExportNumbersForProject(
    { source: 'local', id: 'same' }, [{ mark: 1, count: 1 }], local,
  )).starts['1'], 1)
  assert.deepEqual(calls, ['local:same'])
})

test('одиночное скачивание получает реальное расширение файла', () => {
  assert.equal(
    canvasItemFileName(item({ name: 'ChatGPT Image 2', src: '/media/result.png' })),
    'ChatGPT Image 2.png',
  )
  assert.equal(
    canvasItemFileName(item({ name: 'кадр.png', src: '/media/result.png' })),
    'кадр.png',
  )

  const aliases = [
    { name: 'запись.weba', src: '/media/audio.weba', expected: 'запись.weba' },
    { name: 'голос.opus', src: '/media/audio.ogg', expected: 'голос.ogg' },
    { name: 'фото.jfif', src: '/media/photo.jpg', expected: 'фото.jpg' },
  ]
  for (const example of aliases) {
    assert.equal(
      canvasItemFileName(item({ name: example.name, src: example.src })),
      example.expected,
    )
  }
})

test('один файл на планшете уходит в системное меню без ZIP', async () => {
  const module = await import('./zipExport.js') as Record<string, unknown>
  assert.equal(typeof module.downloadItems, 'function', 'нет отдельного пути для одиночного файла')
  const downloadItems = module.downloadItems as (
    items: CanvasItem[],
    share: { canShare(data: ShareData): boolean; share(data: ShareData): Promise<void> },
  ) => Promise<{ ok: number; failed: number; delivery?: string }>
  let shared: ShareData | undefined
  captured = null
  downloadClicks = 0

  const result = await downloadItems([
    item({ name: 'портрет', src: '/media/portrait.png', mime: 'image/png' }),
  ], {
    canShare: () => true,
    share: async (data) => { shared = data },
  })

  assert.deepEqual(result, { ok: 1, failed: 0, delivery: 'shared' })
  assert.equal(shared?.files?.length, 1)
  assert.equal(shared?.files?.[0]?.name, 'портрет.png')
  assert.equal(shared?.files?.[0]?.type, 'image/png')
  assert.equal(captured, null, 'для одного файла не должен собираться Blob архива')
  assert.equal(downloadClicks, 0, 'при доступном системном меню не нужен браузерный download')
})

test('один файл без системного меню скачивается напрямую, несколько — архивом', async () => {
  const module = await import('./zipExport.js') as Record<string, unknown>
  assert.equal(typeof module.downloadItems, 'function', 'нет отдельного пути для одиночного файла')
  const downloadItems = module.downloadItems as (
    items: CanvasItem[],
    share?: null,
  ) => Promise<{ ok: number; failed: number; delivery?: string }>

  captured = null
  downloadClicks = 0
  downloadName = ''
  assert.deepEqual(
    await downloadItems([item({ name: 'портрет', src: '/media/portrait.png', mime: 'image/png' })], null),
    { ok: 1, failed: 0, delivery: 'downloaded' },
  )
  assert.equal(downloadClicks, 1)
  assert.equal(downloadName, 'портрет.png')
  assert.ok(captured)

  captured = null
  downloadClicks = 0
  downloadName = ''
  assert.deepEqual(
    await downloadItems([
      item({ id: 'a', name: 'a', src: '/media/a.png' }),
      item({ id: 'b', name: 'b', src: '/media/b.png' }),
    ], null),
    { ok: 2, failed: 0, delivery: 'zip' },
  )
  assert.equal(downloadClicks, 1)
  // ⚠️ Прежде здесь стояло /^CanAI-выделение-/ — тест закреплял ровно то, что
  // человек просил убрать: архив звался именем программы. Правило одно на обе
  // кнопки скачивания, и проверяем теперь его (см. archiveName).
  assert.match(downloadName, / — selection — .*[.]zip$/)
  assert.doesNotMatch(downloadName, /CanAI/u)
})

test('repeated sketch names keep one extension and suffix', () => {
  assert.equal(sketchResultName('222.png'), '222 + sketch.png')
  assert.equal(sketchResultName('222 + скетч.png'), '222 + sketch.png')
  assert.equal(
    sketchResultName('222.png + скетч.png + скетч.png + скетч'),
    '222 + sketch.png',
  )
})

test('English sketch suffix removes an embedded source extension', () => {
  assert.equal(
    canvasItemFileName(item({ name: 'portrait.jpg + sketch.png', src: '/media/sketch.png' })),
    'portrait + sketch.png',
  )
})

test('имя в архиве сохраняет одно расширение и не накапливает суффиксы скетча', async () => {
  const { downloadItemsAsZip } = await import('./zipExport.js')
  const JSZip = (await import('jszip')).default

  const result = await downloadItemsAsZip([
    // Импортированное имя уже содержит расширение — второе добавлять нельзя.
    item({ id: 'a', name: 'обычная.png', src: '/media/plain.png' }),
    // после правки по F2 клиент хранит src с ?v=<mtime>
    // (useExternalEdit.ts: `${session.url}?v=${mtime}`)
    item({ id: 'b', name: 'из редактора', src: '/media/edit-a.png?v=1786012345' }),
    // Старые доски уже могли накопить такую цепочку после нескольких скетчей.
    item({
      id: 'c',
      name: '222.png + скетч.png + скетч.png + скетч',
      src: '/media/sketch-result.png',
    }),
  ])
  assert.equal(result.ok, 3)
  assert.ok(captured, 'архив не собрался')

  const zip = await JSZip.loadAsync(await captured!.arrayBuffer())
  const names = Object.keys(zip.files)

  // тот же контракт, что у safeBaseName: Windows запрещает \/:*?"<>| в именах
  const broken = names.filter((name) => /[\\/:*?"<>|]/.test(name))
  assert.deepEqual(broken, [], `недопустимые символы в именах: ${names.join(', ')}`)
  assert.ok(
    names.includes('из редактора.png'),
    `ожидали «из редактора.png», получили: ${names.join(', ')}`,
  )
  assert.ok(
    names.includes('обычная.png'),
    `ожидали одно расширение у импортированного файла, получили: ${names.join(', ')}`,
  )
  assert.ok(
    names.includes('222 + sketch.png'),
    `ожидали нормальное имя скетча, получили: ${names.join(', ')}`,
  )
})

/**
 * ⚠️ Архив называется по ДОСКЕ, а не по программе — и это правило одно на ОБЕ
 * кнопки скачивания. Его однажды уже применили, но только к экспорту по
 * меткам: скачивание выделения так и осталось «CanAI-выделение-<дата>», и
 * человек справедливо спросил «мы же это делали, почему опять» (19.09.2026).
 * Имя программы он и так знает; ему нужно знать, ОТКУДА этот архив.
 */
test('архив выделения подписан доской, а не названием программы', async () => {
  const { downloadItemsAsZip, setExportBoardName } = await import('./zipExport.js')
  setExportBoardName('шабашка')
  downloadName = ''
  const result = await downloadItemsAsZip([item({ id: 'a', name: 'кадр.png', src: '/media/a.png' })])
  assert.equal(result.ok, 1)
  assert.ok(downloadName.startsWith('шабашка — selection — '), downloadName)
  assert.ok(downloadName.endsWith('.zip'), downloadName)
  assert.doesNotMatch(downloadName, /CanAI/u, 'название программы в имени архива не нужно')
})

test('пачка из архива доски отличается от выделения прямо в имени', async () => {
  const { downloadItemsAsZip, setExportBoardName } = await import('./zipExport.js')
  setExportBoardName('шабашка')
  downloadName = ''
  await downloadItemsAsZip([item({ id: 'a', name: 'кадр.png', src: '/media/a.png' })], 'archive')
  assert.ok(downloadName.startsWith('шабашка — archive — '), downloadName)
})

/** ⚠️ Доска не назвалась — пусть будет «доска», но НЕ имя программы. */
test('без имени доски архив всё равно не зовётся именем программы', async () => {
  const { downloadItemsAsZip, setExportBoardName } = await import('./zipExport.js')
  setExportBoardName('')
  downloadName = ''
  await downloadItemsAsZip([item({ id: 'a', name: 'кадр.png', src: '/media/a.png' })])
  assert.ok(downloadName.startsWith('board — selection — '), downloadName)
  assert.doesNotMatch(downloadName, /CanAI/u)
})

test('a local asset without an extension uses the downloaded type when available', async () => {
  const { canvasItemExtension } = await import('./mediaFileName.js')
  const asset = item({ name: 'frame', src: '/media/asset-without-extension' })

  assert.equal(canvasItemExtension(asset), 'bin', 'без единой подсказки честно признаёмся')
  assert.equal(canvasItemExtension(asset, 'image/png'), 'png', 'тип от сервера спасает')
  // Заголовок приходит с довеском — он не должен мешать.
  assert.equal(canvasItemExtension(asset, 'image/jpeg; charset=binary'), 'jpg')

  // Свой `mime` объекта важнее типа, который мог подставить прокси.
  assert.equal(
    canvasItemExtension({ ...asset, mime: 'image/webp' } as typeof asset, 'application/octet-stream'),
    'webp',
  )

  // Адрес с нормальным суффиксом остаётся самым точным источником.
  assert.equal(canvasItemExtension(item({ src: '/media/a.png' }), 'application/octet-stream'), 'png')
})
