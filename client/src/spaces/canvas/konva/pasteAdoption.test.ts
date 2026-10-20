import assert from 'node:assert/strict'
import test from 'node:test'
import { adoptPastedItem, needsAdoption, type AdoptedMedia, type MediaAdopter } from './pasteAdoption'
import type { CanvasItem } from './types'

const item = (patch: Partial<CanvasItem>): CanvasItem =>
  ({ id: 'i', kind: 'image', x: 0, y: 0, w: 10, h: 10, ...patch }) as CanvasItem

const cloud = { source: 'cloud' as const, id: 'prj_to' }
const otherCloud = { source: 'cloud' as const, id: 'prj_from' }
const local = { source: 'local' as const, id: 'p1' }

test('переселяем только то, у чего есть файл и нет места на доске назначения', () => {
  assert.equal(needsAdoption(item({ kind: 'video', src: '/media/a.mp4' }), cloud), true)
  // Уже свой для этой доски — трогать нечего.
  assert.equal(needsAdoption(item({ kind: 'video', src: '/api/cloud-assets/assets/ast_1', assetId: 'ast_1' }), cloud, cloud), false)
  // У текста и карточки ссылки файла нет вовсе.
  assert.equal(needsAdoption(item({ kind: 'text', text: 'привет' }), cloud), false)
  assert.equal(needsAdoption(item({ kind: 'link' }), cloud), false)
  // Доска назначения неизвестна (планшет) — переселять некуда.
  assert.equal(needsAdoption(item({ kind: 'video', src: '/media/a.mp4' }), null), false)
})

/**
 * ⚠️ Файл другой сетевой доски чужой, хотя `assetId` у него есть: читать его
 * пускают только тех, у кого есть доступ к доске-хозяйке (находка Ф-8
 * аудита 24.09.2026).
 */
test('файл другой сетевой доски переселяется, своей — нет', () => {
  const foreign = item({ kind: 'image', src: '/api/cloud-assets/assets/ast_1', assetId: 'ast_1' })
  assert.equal(needsAdoption(foreign, cloud, otherCloud), true)
  assert.equal(needsAdoption(foreign, cloud, cloud), false, 'вставка на ту же доску — свой файл')
  // Буфер из прежней версии не знает, откуда он, — считаем своим, как было.
  assert.equal(needsAdoption(foreign, cloud, null), false)
  // На локальную доску файл сетевой едет всегда.
  assert.equal(needsAdoption(foreign, local, cloud), true)
  assert.equal(needsAdoption(item({ kind: 'image', src: '/media/a.png' }), local, local), false)
})

test('переселённый объект получает assetId и новую ссылку, остальное прежнее', async () => {
  const calls: Array<{ url: string; name: string; assetId?: string }> = []
  const adopt: MediaAdopter = async (media, name) => {
    calls.push({ url: media.url, name, ...(media.assetId ? { assetId: media.assetId } : {}) })
    return { assetId: 'ast_new', url: '/api/cloud-assets/assets/ast_new', mime: 'video/mp4' }
  }
  const ready = await adoptPastedItem(
    item({ id: 'a', kind: 'video', src: '/media/клип.mp4', mime: 'video/mp4', name: 'клип.mp4' }),
    adopt,
    cloud,
  )
  assert.deepEqual(calls, [{ url: '/media/клип.mp4', name: 'клип.mp4' }])
  assert.equal(ready.assetId, 'ast_new')
  assert.equal(ready.src, '/api/cloud-assets/assets/ast_new')
  // Это тот же объект, только файл переехал.
  assert.equal(ready.id, 'a')

  // Файл другой сетевой доски уходит с assetId — его скопирует сервер команды.
  calls.length = 0
  const moved = await adoptPastedItem(
    item({ id: 'b', kind: 'image', src: '/api/cloud-assets/assets/ast_src', assetId: 'ast_src', name: 'кадр.png' }),
    adopt,
    cloud,
    otherCloud,
  )
  assert.deepEqual(calls, [{ url: '/api/cloud-assets/assets/ast_src', name: 'кадр.png', assetId: 'ast_src' }])
  assert.equal(moved.assetId, 'ast_new')
})

/**
 * ⚠️ Без исходника кроп не расширить: у коллеги он указывал бы на чужой файл
 * или на `/media/…` чужого компьютера.
 */
test('исходник неразрушающего кропа переселяется вместе с объектом', async () => {
  const adopt: MediaAdopter = async (media) => ({
    assetId: media.url.includes('source') ? 'ast_source' : 'ast_cropped',
    url: `/api/cloud-assets/assets/${media.url.includes('source') ? 'ast_source' : 'ast_cropped'}`,
    mime: 'image/png',
  })
  const ready = await adoptPastedItem(item({
    kind: 'image', src: '/media/cropped.png', mime: 'image/png', name: 'кадр.png',
    crop: { sourceSrc: '/media/source.png', sourceNaturalWidth: 100, sourceNaturalHeight: 100, rect: { x: 0, y: 0, w: 50, h: 50 } },
  }), adopt, cloud)
  assert.equal(ready.assetId, 'ast_cropped')
  assert.equal(ready.crop?.sourceAssetId, 'ast_source')
  assert.equal(ready.crop?.sourceSrc, '/api/cloud-assets/assets/ast_source')

  // Обратно на локальную доску: облачная отметка исходника не должна остаться.
  const home = await adoptPastedItem(ready, async () => ({ url: '/media/home.png', mime: 'image/png' }), local, cloud)
  assert.equal(home.assetId, undefined)
  assert.equal(home.crop?.sourceAssetId, undefined)
  assert.equal(home.crop?.sourceSrc, '/media/home.png')
})

test('сбой переселения бросает — призрака не будет', async () => {
  await assert.rejects(
    () => adoptPastedItem(item({ kind: 'video', src: '/media/клип.mp4' }), async () => { throw new Error('сеть недоступна') }, cloud),
    /сеть недоступна/u,
  )
})

// ── вставка по готовности: карточки сразу, файлы по нескольку ────────────────

interface Waiting {
  resolve(value: AdoptedMedia): void
  reject(error: unknown): void
}

async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

async function withCloudBoard(run: () => Promise<void>): Promise<void> {
  const { setBoardUploadTarget } = await import('./boardUploader')
  setBoardUploadTarget(cloud)
  try {
    await run()
  } finally {
    setBoardUploadTarget(null)
  }
}

const adopted = (id: string): AdoptedMedia => ({ assetId: `ast_${id}`, url: `/api/cloud-assets/assets/ast_${id}`, mime: 'image/png' })

/**
 * ⚠️ Раньше вставка молчала, пока не переедут ВСЕ файлы, и клала всё разом —
 * или ничего: 10 картинок при 1 МБ/с — около 42 секунд тишины (находка Ф-7
 * аудита 24.09.2026).
 */
test('карточки встают сразу, а объект — как только готов его файл', async () => {
  await withCloudBoard(async () => {
    const { CanvasStore } = await import('./canvasStore')
    const { pasteCanvasItems } = await import('./clipboard')
    const store = new CanvasStore()
    const waits = new Map<string, Waiting>()
    const adopt: MediaAdopter = (media) => new Promise((resolve, reject) => waits.set(media.url, { resolve, reject }))
    const pasting = pasteCanvasItems(store, [
      item({ id: 'a', src: '/media/a.png', name: 'a.png', x: 0 }),
      item({ id: 'b', src: '/media/b.png', name: 'b.png', x: 20 }),
      item({ id: 't', kind: 'text', text: 'заметка', x: 40 }),
    ], { x: 100, y: 100 }, undefined, { adopt })
    await settle()
    assert.deepEqual(store.getItems().map((entry) => entry.kind), ['text'], 'текст встал сразу')
    assert.equal(store.getPending().length, 2, 'на месте картинок — карточки')
    assert.deepEqual(store.getPending().map((card) => card.label), ['Transferring a.png', 'Transferring b.png'])

    waits.get('/media/b.png')!.resolve(adopted('b'))
    await settle()
    assert.deepEqual(store.getItems().map((entry) => entry.assetId ?? entry.kind), ['text', 'ast_b'], 'b не ждёт a')
    assert.equal(store.getPending().length, 1)

    waits.get('/media/a.png')!.resolve(adopted('a'))
    const placed = await pasting
    assert.equal(placed.length, 3)
    assert.deepEqual(store.getSelection(), placed, 'вставленное — выделение, в порядке группы')
    const a = store.getItems().find((entry) => entry.assetId === 'ast_a')!
    assert.deepEqual([a.x, a.y], [100, 100], 'объект встал на место своей карточки')
  })
})

test('файлы едут не больше трёх разом', async () => {
  await withCloudBoard(async () => {
    const { CanvasStore } = await import('./canvasStore')
    const { pasteCanvasItems } = await import('./clipboard')
    const { PASTE_PARALLEL } = await import('./pasteProgress')
    const store = new CanvasStore()
    let active = 0
    let most = 0
    const adopt: MediaAdopter = async (media) => {
      active += 1
      most = Math.max(most, active)
      await settle()
      active -= 1
      return adopted(media.url.replace(/\W/g, ''))
    }
    const items = Array.from({ length: 7 }, (_, index) => item({ id: `i${index}`, src: `/media/${index}.png`, x: index * 20 }))
    const placed = await pasteCanvasItems(store, items, { x: 0, y: 0 }, undefined, { adopt })
    assert.equal(placed.length, 7)
    assert.equal(most, PASTE_PARALLEL)
    assert.equal(PASTE_PARALLEL, 3)
  })
})

test('сорвавшийся файл не отменяет остальные, а его карточка предлагает повтор', async () => {
  await withCloudBoard(async () => {
    const { CanvasStore } = await import('./canvasStore')
    const { pasteCanvasItems } = await import('./clipboard')
    const { canRetryCard, retryCard } = await import('./transientCardRetry')
    const store = new CanvasStore()
    let badAttempts = 0
    const adopt: MediaAdopter = async (media) => {
      if (media.url === '/media/bad.png' && badAttempts++ === 0) throw new Error('Связь оборвалась')
      return adopted(media.url.includes('bad') ? 'bad' : 'good')
    }
    const placed = await pasteCanvasItems(store, [
      item({ id: 'good', src: '/media/good.png', name: 'good.png' }),
      item({ id: 'bad', src: '/media/bad.png', name: 'bad.png', x: 20 }),
    ], { x: 0, y: 0 }, undefined, { adopt })
    assert.equal(placed.length, 1, 'хороший файл на доске')
    const [card] = store.getPending()
    assert.equal(card?.status, 'error')
    assert.match(card?.error ?? '', /Связь оборвалась/u)
    assert.equal(canRetryCard(card!.id), true)

    assert.equal(retryCard(card!.id), true)
    assert.equal(retryCard(card!.id), false, 'второй клик второго переноса не затеет')
    await settle()
    assert.equal(store.getPending().length, 0)
    assert.deepEqual(store.getItems().map((entry) => entry.assetId).sort(), ['ast_bad', 'ast_good'])
  })
})

test('убранная карточка не воскресает объектом, подвинутая — ведёт его за собой', async () => {
  await withCloudBoard(async () => {
    const { CanvasStore } = await import('./canvasStore')
    const { pasteCanvasItems } = await import('./clipboard')
    const store = new CanvasStore()
    const waits = new Map<string, Waiting>()
    const adopt: MediaAdopter = (media) => new Promise((resolve, reject) => waits.set(media.url, { resolve, reject }))
    const pasting = pasteCanvasItems(store, [
      item({ id: 'gone', src: '/media/gone.png', name: 'gone.png' }),
      item({ id: 'moved', src: '/media/moved.png', name: 'moved.png', x: 20 }),
    ], { x: 0, y: 0 }, undefined, { adopt })
    await settle()
    const [gone, moved] = store.getPending()
    store.dismissPendingById(gone!.id)
    store.updatePending(moved!.id, { x: 500, y: 600 }, { system: true })
    waits.get('/media/gone.png')!.resolve(adopted('gone'))
    waits.get('/media/moved.png')!.resolve(adopted('moved'))
    await pasting
    assert.deepEqual(store.getItems().map((entry) => [entry.assetId, entry.x, entry.y]), [['ast_moved', 500, 600]])
  })
})

test('пока файлы ехали, человек выделил другое — выделение не отбираем', async () => {
  await withCloudBoard(async () => {
    const { CanvasStore } = await import('./canvasStore')
    const { pasteCanvasItems } = await import('./clipboard')
    const store = new CanvasStore()
    const other = store.addItem({ kind: 'text', x: 900, y: 900, w: 100, h: 40, text: 'своё' })
    const waits = new Map<string, Waiting>()
    const adopt: MediaAdopter = (media) => new Promise((resolve, reject) => waits.set(media.url, { resolve, reject }))
    const pasting = pasteCanvasItems(store, [item({ id: 'a', src: '/media/a.png' })], { x: 0, y: 0 }, undefined, { adopt })
    await settle()
    store.setSelection([other])
    waits.get('/media/a.png')!.resolve(adopted('a'))
    await pasting
    assert.deepEqual(store.getSelection(), [other])
  })
})

/**
 * ⚠️ После Ctrl+C объекты лежат и в системном буфере, и событие `paste`
 * клало их оттуда прямо в стор, мимо переселения: починка 20.09.2026 стояла
 * на пути, по которому настоящий Ctrl+V почти не ходит. Любой новый путь
 * вставки обязан идти через `pasteCanvasItems`.
 */
test('СТОРОЖ: объекты не кладутся на доску в обход переноса файлов', async () => {
  const { readdir, readFile } = await import('node:fs/promises')
  const path = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
  // Где прямой вызов законен и почему.
  const allowed = new Map([
    ['spaces/canvas/konva/clipboard.ts', 'сама дверь: переносит файлы перед вставкой'],
    ['spaces/canvas/konva/pasteProgress.ts', 'та же дверь: кладёт объект, когда его файл переехал'],
    ['spaces/canvas/konva/canvasStore.ts', 'объявление метода'],
    ['tablet/videoFrameSelection.ts', 'кадры уже залиты загрузчиком доски и несут assetId'],
  ])
  const offenders: string[] = []
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) { await walk(full); continue }
      if (!/\.(ts|tsx)$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) continue
      const rel = path.relative(src, full).split(path.sep).join('/')
      if (allowed.has(rel)) continue
      if (/\.(pasteItems|insertPasted)\(/u.test(await readFile(full, 'utf8'))) offenders.push(rel)
    }
  }
  await walk(src)
  assert.deepEqual(offenders, [], 'вставляйте через pasteCanvasItems из konva/clipboard.ts')
  const canvas = await readFile(path.join(src, 'spaces/canvas/konva/KonvaCanvas.tsx'), 'utf8')
  assert.match(canvas, /pasteCanvasItems\(store, systemCanvasItems/, 'вставка из системного буфера идёт через дверь')
  assert.match(canvas, /origin: systemClipboard\.origin/, 'и знает, с какой доски скопировано')
})
