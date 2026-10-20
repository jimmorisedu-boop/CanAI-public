// @ts-expect-error Клиентские тесты запускаются через tsx с Node-типами.
import assert from 'node:assert/strict'
// @ts-expect-error Production-клиент не зависит от Node-типов.
import test from 'node:test'
import { orientationState } from './orientation'
import { shouldShowHomeScreenHint } from './homeScreenHint'
import { swipeVerdict } from './boardFingerGestures'
import { actionsForItem, actionsForMany, subjectDetails, subjectTitle } from './inspectorModel'
import { readFile } from 'node:fs/promises'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { installRemoteFetch, needsRemoteCsrf, previewSrc, remoteLogin, remoteLogout } from './remoteSession'
import { LanTabletRuntime } from './lanRuntime'
import { canGenerate } from '../spaces/canvas/generationAvailability'
import type { CanvasItem } from '../spaces/canvas/konva/types'
import type { CanvasStore } from '../spaces/canvas/konva/canvasStore'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { BoardItemView } from './BoardItemView'
import { TabletSnapGuides } from './TabletSnapGuides'
import './contextActionModel.test'
import './contextBarPlacement.test'
import './visualViewportModel.test'

// Правила ландшафтного планшета, которые нельзя проверить глазами: они
// срабатывают в повороте, в раздельном экране и на трёх пальцах.

const image = (patch: Partial<CanvasItem> = {}): CanvasItem => ({
  id: 'i1', kind: 'image', x: 0, y: 0, w: 100, h: 100, ...patch,
})

test('портрет и Split View позволяют продолжать работу на той же доске', () => {
  // Планшет повёрнут: окно портретное И экран портретный.
  assert.equal(orientationState({ viewport: { w: 820, h: 1180 }, screen: { w: 820, h: 1180 } }), 'ok')
  // Раздельный экран: планшет лежит горизонтально, а окно узкое. Сказать здесь
  // «поверните планшет» значит послать человека делать бессмысленное движение.
  assert.equal(orientationState({ viewport: { w: 507, h: 1080 }, screen: { w: 1366, h: 1024 } }), 'ok')
  assert.equal(orientationState({ viewport: { w: 1180, h: 820 }, screen: { w: 1180, h: 820 } }), 'ok')
})

test('нулевой замер окна не считается портретом', () => {
  // Пока идёт первая раскладка, размеры бывают нулевыми. Показать заставку по
  // ним — значит закрыть работающее приложение ни за чем.
  assert.equal(orientationState({ viewport: { w: 0, h: 0 }, screen: { w: 1180, h: 820 } }), 'ok')
})

test('подсказку про домашний экран показываем один раз и только в Safari', () => {
  assert.equal(shouldShowHomeScreenHint({ standalone: false, dismissed: false, appleTouch: true }), true)
  // Уже приложение — советовать нечего.
  assert.equal(shouldShowHomeScreenHint({ standalone: true, dismissed: false, appleTouch: true }), false)
  // Закрыли навсегда — значит навсегда.
  assert.equal(shouldShowHomeScreenHint({ standalone: false, dismissed: true, appleTouch: true }), false)
  // На компьютере такого пункта в меню нет.
  assert.equal(shouldShowHomeScreenHint({ standalone: false, dismissed: false, appleTouch: false }), false)
})

test('три пальца: влево — отменить, вправо — повторить, вниз — ничего', () => {
  assert.equal(swipeVerdict(-120, 10), 'undo')
  assert.equal(swipeVerdict(120, -10), 'redo')
  // Короткий ход — это дрожание пальцев, а не жест.
  assert.equal(swipeVerdict(-30, 0), null)
  // Вертикальный ход — прокрутка, а не отмена.
  assert.equal(swipeVerdict(-120, 200), null)
})

test('инспектор предлагает то, что применимо к этому объекту', () => {
  const forImage = actionsForItem(image())
  assert.ok(forImage.includes('view'))
  assert.ok(forImage.includes('resize'))
  assert.ok(forImage.includes('sketch'))
  assert.ok(forImage.includes('crop'))
  assert.ok(!forImage.includes('clip'), 'у картинки нет правки клипа')

  const forVideo = actionsForItem(image({ kind: 'video' }))
  assert.ok(forVideo.includes('view'))
  assert.ok(forVideo.includes('resize'))
  assert.ok(forVideo.includes('clip'))
  assert.ok(forVideo.includes('extract-audio'))
  assert.ok(!forVideo.includes('crop'), 'кроп видео живёт внутри правки клипа')

  const forText = actionsForItem(image({ kind: 'text', text: 'привет' }))
  assert.ok(forText.includes('resize'))
  assert.ok(forText.includes('edit-text'))
  assert.ok(!forText.includes('sketch'))
})

test('у группы остаются только групповые действия', () => {
  const many = actionsForMany([image(), image({ id: 'i2' }), image({ id: 'i3' })])
  assert.ok(many.includes('archive'))
  assert.ok(many.includes('download'))
  // Первый выбранный — исходник, остальные листаются как кандидаты.
  assert.ok(many.includes('compare'))
  assert.ok(actionsForMany([image(), image({ id: 'i2' })]).includes('compare'))
})

test('подпись объекта показывает материал, а не наше устройство', () => {
  assert.equal(subjectTitle(image({ name: 'портрет-3.png' })), 'портрет-3.png')
  assert.equal(subjectTitle(image({ kind: 'text', text: 'закатный свет' })), 'закатный свет')
  // Имя модели передаёт вызывающий: в объекте лежит только её id, и показывать
  // человеку `seedream-5-pro` вместо «Seedream 5 Pro» нельзя.
  const details = subjectDetails(image({ naturalWidth: 1024, naturalHeight: 1280 }), 'Seedream 5 Pro')
  assert.match(details, /1024 × 1280/)
  assert.match(details, /Seedream 5 Pro/)
  assert.ok(!subjectDetails(image({ modelId: 'seedream-5-pro' })).includes('seedream-5-pro'))
})

test('ключ планшетной двери нужен любой записи в /api — каким бы каналом она ни шла', () => {
  // ⚠️ Загрузка файлов ходит через XMLHttpRequest ради полосы прогресса, и
  // подмена fetch её не касалась: дверь отвечала 403 на КАЖДУЮ загрузку —
  // импорт снимков, скетч, кадр из клипа. Правило теперь одно на оба канала.
  const origin = 'http://192.168.1.5:8789'
  assert.equal(needsRemoteCsrf('POST', '/api/assets/upload', origin), true)
  assert.equal(needsRemoteCsrf('post', `${origin}/api/project`, origin), true)
  assert.equal(needsRemoteCsrf('PATCH', '/api/settings', origin), true)
  // Чтение ключа не требует: он защищает от чужой страницы, а не от чтения.
  assert.equal(needsRemoteCsrf('GET', '/api/models', origin), false)
  // Не наши адреса не трогаем вовсе.
  assert.equal(needsRemoteCsrf('POST', '/preview/a.png', origin), false)
  assert.equal(needsRemoteCsrf('POST', 'https://fal.ai/x', origin), false)
})

test('LAN capability client получает CSRF через установленный fetch bridge даже после создания runtime', async () => {
  const origin = 'http://192.168.1.5:53502'
  const calls: Array<{ path: string; method: string; headers: Headers }> = []
  const originalFetch = globalThis.fetch
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const originalLocation = Object.getOwnPropertyDescriptor(globalThis, 'location')
  const originalXmlHttpRequest = Object.getOwnPropertyDescriptor(globalThis, 'XMLHttpRequest')

  const nativeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const path = input instanceof Request ? new URL(input.url).pathname : new URL(String(input), origin).pathname
    calls.push({ path, method: init?.method ?? (input instanceof Request ? input.method : 'GET'), headers: new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)) })
    if (path === '/api/remote/login') return Response.json({ csrf: 'lan-csrf-1', device: 'tablet' })
    if (path === '/api/remote/logout') return Response.json({ ok: true })
    if (path === '/api/agent-tasks') return Response.json({ task: { taskId: 'task-lan-1', revision: 1 } }, { status: 201 })
    return Response.json({})
  }
  class FakeXmlHttpRequest {
    open(_method: string, _url: string): void {}
    send(_body?: Document | XMLHttpRequestBodyInit | null): void {}
    setRequestHeader(_name: string, _value: string): void {}
  }

  try {
    // Construct first: LanTabletRuntime must keep a lazy global transport, not
    // capture the pre-bridge native fetch used during module setup.
    globalThis.fetch = nativeFetch
    const runtime = new LanTabletRuntime()
    Object.defineProperty(globalThis, 'window', { configurable: true, value: globalThis })
    Object.defineProperty(globalThis, 'location', { configurable: true, value: { origin } })
    Object.defineProperty(globalThis, 'XMLHttpRequest', { configurable: true, writable: true, value: FakeXmlHttpRequest })
    installRemoteFetch()
    await remoteLogin('53500')

    const client = runtime.capabilities?.agents.client
    assert.ok(client, 'LAN runtime must expose its Host client capability')
    await client.startTask({
      requestId: 'lan-request-1', projectRef: { source: 'local', id: 'board-lan' },
      packageId: 'demo-agent', taskType: 'demo', instruction: 'Проверка', input: {}, inputs: [],
    })
    await client.commandTask('task-lan-1', 'pause', {
      requestId: 'lan-pause-1', expectedRevision: 1, reason: 'проверка',
    })
    await client.commandTask('task-lan-1', 'cancel', {
      requestId: 'lan-cancel-1', expectedRevision: 1, reason: 'проверка',
    })
    await client.decideReview('task-lan-1', 'review-1', {
      requestId: 'lan-review-1', expectedRevision: 1, reviewId: 'review-1', revision: 1,
      decision: 'changes-requested', comment: 'Нужна доработка', answers: {},
    })

    const writes = calls.filter((call) => call.method === 'POST' && call.path.startsWith('/api/agent-tasks'))
    assert.deepEqual(writes.map((call) => call.path), [
      '/api/agent-tasks',
      '/api/agent-tasks/task-lan-1/pause',
      '/api/agent-tasks/task-lan-1/cancel',
      '/api/agent-tasks/task-lan-1/reviews/review-1/decision',
    ])
    assert.ok(writes.every((call) => call.headers.get('x-canai-remote-csrf') === 'lan-csrf-1'))
    assert.ok(calls.every((call) => !call.path.startsWith('/api/agents/')), 'LAN task control does not install packages or request a provider key')
  } finally {
    await remoteLogout().catch(() => undefined)
    globalThis.fetch = originalFetch
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else delete (globalThis as typeof globalThis & { window?: unknown }).window
    if (originalLocation) Object.defineProperty(globalThis, 'location', originalLocation)
    else delete (globalThis as typeof globalThis & { location?: unknown }).location
    if (originalXmlHttpRequest) Object.defineProperty(globalThis, 'XMLHttpRequest', originalXmlHttpRequest)
    else delete (globalThis as typeof globalThis & { XMLHttpRequest?: unknown }).XMLHttpRequest
  }
})

test('превью доски просит растр не крупнее экранного размера', () => {
  // Без ступеней каждая мелкая карточка на общем плане декодируется
  // как 1920×1920. На большой доске Safari на iPad закрывает вкладку по памяти.
  assert.equal(previewSrc('/media/photo.png', 300), '/preview/photo.png?w=512')
  assert.equal(previewSrc('/media/photo.png?revision=7', 700), '/preview/photo.png?revision=7&w=1024')
  assert.equal(previewSrc('/media/photo.png', 80), '/preview/photo.png?w=256')
  assert.equal(previewSrc('/media/photo.png', 4000), '/preview/photo.png?w=1920')
  // Вне планшетного media-маршрута URL не переписываем.
  assert.equal(previewSrc('https://cdn.test/photo.png', 300), 'https://cdn.test/photo.png')
})

/**
 * ⚠️ Превью — удобство, а не обязательство: сервер мог не успеть его
 * собрать, запрос мог оборваться на переполненной очереди, файл мог
 * оказаться не картинкой. Без запасного пути на месте объекта оставался
 * значок битого файла, и со стороны это читалось как 'периодически картинки
 * пропадают' (жалоба 08.09.2026). На компьютере такой путь есть давно.
 */
test('не отдалось превью — планшет показывает оригинал, а не дыру', async () => {
  const source = await readFile(new URL('./BoardItemView.tsx', import.meta.url), 'utf8')
  assert.match(source, /onError={/, 'у картинки доски обязан быть запасной адрес')
  assert.match(source, /image.src = item.src/, 'и это оригинал объекта')
})

test('картинка на общем плане передаёт превью свой размер с учётом зума', () => {
  const html = renderToStaticMarkup(createElement(BoardItemView, {
    item: image({ src: '/media/portrait.png', w: 400, h: 900 }),
    selected: false,
    scale: 0.5,
    pixelRatio: 2,
    // В image-ветке стор не читается: передаём только обязательную границу компонента.
    store: {} as CanvasStore,
  }))
  // max(400, 900) × 0.5 × Retina 2 = 900, ближайшая ступень сверху — 1024.
  assert.match(html, /src="\/preview\/portrait\.png\?w=1024"/)
})

test('выбранное видео показывает отдельные крупные действия кадра и звука', () => {
  const html = renderToStaticMarkup(createElement(BoardItemView, {
    item: image({ kind: 'video', src: '/media/clip.mp4', muted: false }),
    selected: true,
    scale: 1,
    store: {} as CanvasStore,
  }))
  assert.match(html, /aria-label="Capture frame"/)
  assert.match(html, /aria-label="Turn sound off"/)
  assert.match(html, /tablet-video-actions/)
  const videoTag = html.match(/<video\b[^>]*>/)?.[0] ?? ''
  assert.doesNotMatch(videoTag, /controls|data-tablet-interactive/, 'само выделенное видео должно отдавать перетаскивание доске')
  assert.match(html, /aria-label="Play video"/)
  assert.match(html, /aria-label="Video position"/)
  // Звук стоит перед кадром — как на компьютере (просьба 21.09.2026).
  assert.ok(
    html.indexOf('aria-label="Turn sound off"') < html.indexOf('aria-label="Capture frame"'),
    'кнопка звука — раньше кнопки кадра',
  )
})

test('панель видео отстоит от края на одинаковые 12 экранных пикселей при любом масштабе', () => {
  // Отступ в единицах доски таял при отдалении: на масштабе 0.5 — 4 пикселя.
  const html = renderToStaticMarkup(createElement(BoardItemView, {
    item: image({ kind: 'video', src: '/media/clip.mp4' }),
    selected: true,
    scale: 0.5,
    store: {} as CanvasStore,
  }))
  const bar = html.match(/<div class="tablet-video-actions"[^>]*>/)?.[0] ?? ''
  assert.ok(bar.includes('style="top:24px;left:24px;transform:scale(2)"'), `панель: ${bar}`)
})

test('скругление и обводка выделения карточки держат экранный размер при любом масштабе', () => {
  // Заданные в пикселях масштабируемого слоя, они при приближении толстели,
  // а при отдалении обводка выделения таяла до долей пикселя (30.09.2026).
  const css = readFileSync(new URL('./tablet.css', import.meta.url), 'utf8')
  const rule = (selector: string): string => {
    const start = css.indexOf(`\n${selector} {`)
    assert.ok(start >= 0, `нет правила ${selector}`)
    return css.slice(start, css.indexOf('}', start))
  }
  const inverse = 'var(--tablet-inverse-scale, 1)'
  assert.ok(rule('.tablet-item-inner').includes(`border-radius: calc(var(--radius-compact) * ${inverse})`))
  const selected = rule('.tablet-item.selected .tablet-item-inner')
  assert.ok(selected.includes(`outline: calc(2px * ${inverse}) solid var(--accent)`), selected)
  // Зазор кольца общий с компьютером (SELECTION_GAP_PX в selectionRing.ts).
  assert.ok(selected.includes(`outline-offset: calc(3px * ${inverse})`), selected)
  // Обратный масштаб отдаёт сам слой доски — тот, что масштабируется.
  const canvas = readFileSync(new URL('./BoardCanvas.tsx', import.meta.url), 'utf8')
  assert.match(canvas, /'--tablet-inverse-scale': String\(1 \/ camera\.scale\)/)
})

test('в мультивыборе медиа отдаёт касание доске, а не своим контролам', () => {
  const html = renderToStaticMarkup(createElement(BoardItemView, {
    item: image({ kind: 'video', src: '/media/clip.mp4' }),
    selected: true,
    selectionMode: true,
    scale: 1,
    store: {} as CanvasStore,
  }))
  assert.doesNotMatch(html, /tablet-video-actions|controls=""|data-tablet-interactive/)
  assert.match(html, /tablet-selection-check on/)
})

test('рамка стилусом оставляет всю поверхность видео доступной для переноса группы', () => {
  const html = renderToStaticMarkup(createElement(BoardItemView, {
    item: image({ kind: 'video', src: '/media/clip.mp4' }),
    selected: true, selectionMode: false, groupSelected: true, scale: 0.5,
    store: {} as CanvasStore,
  }))
  assert.doesNotMatch(html, /tablet-video-actions|controls=""|data-tablet-interactive/)
})

test('ожидание аренды видео не отдаёт первый drag нативному плееру', () => {
  const html = renderToStaticMarkup(createElement(BoardItemView, {
    item: image({ kind: 'video', src: '/media/clip.mp4' }),
    selected: true, readOnly: true, playbackOnly: false, scale: 1,
    store: {} as CanvasStore,
  }))
  assert.doesNotMatch(html, /controls=""|data-tablet-interactive/)
})

test('направляющие выравнивания рисуются отдельным неперехватывающим слоем', () => {
  const html = renderToStaticMarkup(createElement(TabletSnapGuides, {
    guides: [
      [120, 20, 120, 240],
      [10, 80, 260, 80],
    ],
    scale: 2,
  }))

  assert.equal((html.match(/class="tablet-snap-guide /g) ?? []).length, 2)
  assert.match(html, /tablet-snap-guide vertical/)
  assert.match(html, /tablet-snap-guide horizontal/)
  assert.match(html, /aria-hidden="true"/)
})

test('маршрут генерации на планшете определяется локальным fal/mock состоянием', () => {
  assert.equal(canGenerate({ falConfigured: false, mockMode: false }, 'local'), false)
  assert.equal(canGenerate({ falConfigured: true, mockMode: false, accountCloudConfigured: false }, 'local'), true)
  assert.equal(canGenerate({ falConfigured: false, mockMode: true, accountCloudConfigured: false }, 'local'), true)
})

test('в клиенте нет прямых вызовов crypto.randomUUID и navigator.clipboard', () => {
  // ⚠️ Планшет открывает доску по адресу вида http://192.168.1.5:8789, и это
  // НЕ защищённый контекст: crypto.randomUUID там undefined, а
  // navigator.clipboard отсутствует вовсе (замерено вживую). Первый же вызов
  // бросал TypeError раньше, чем React рисовал хоть что-то, — человек видел
  // пустой экран. На компьютере страница живёт на localhost, который браузер
  // считает защищённым, поэтому в разработке на эти грабли не наступишь
  // никогда: сторож нужен именно потому, что своими руками это не поймать.
  const root = fileURLToPath(new URL('../', import.meta.url))
  const offenders: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) { walk(full); continue }
      if (!/\.tsx?$/.test(entry.name) || entry.name.includes('.test.')) continue
      if (full.endsWith(join('ui', 'ids.ts'))) continue
      const text = readFileSync(full, 'utf8')
      if (text.includes('crypto.randomUUID(')) offenders.push(`${full}: crypto.randomUUID`)
      if (/navigator\.clipboard\.(writeText|readText)/.test(text)) offenders.push(`${full}: navigator.clipboard`)
    }
  }
  walk(root)
  // clipboard.ts и окна компьютера проверяют наличие сами и живут только за
  // столом — они названы поимённо, а не прощены молча. Ряд макросов из списка
  // ушёл: копирование макроса переехало на общий copyText (useMacroClipboard).
  const allowed = [join('konva', 'clipboard.ts'), 'AssistantShelf.tsx', 'ShareDialog.tsx']
  const real = offenders.filter((entry) => !allowed.some((name) => entry.includes(name)))
  assert.deepEqual(real, [], `прямые вызовы вне ui/ids.ts:\n${real.join('\n')}`)
})

/**
 * ⚠️ «Соединяюсь…» без конца — это не состояние, а тупик: если сеть режет
 * доступ к серверу команды, запрос не отвечает и не падает, и человек смотрит
 * в надпись, не зная, ждать или это поломка (жалоба 07.09.2026 — планшет без
 * VPN). Ожидание обязано заканчиваться словами и кнопкой.
 */
test('ожидание сервера заканчивается понятным экраном с кнопкой', async () => {
  const source = await readFile(new URL('./TabletApp.tsx', import.meta.url), 'utf8')
  assert.match(source, /CONNECT_TIMEOUT_MS/, 'у ожидания есть срок')
  assert.match(source, /Server is not responding/)
  assert.match(source, /Try again/)
  // Отказ сети не должен всплывать необработанным: иначе аварийный экран
  // говорит «приложение не запустилось» там, где просто нет связи.
  assert.match(source, /\.catch\(\(\) => \{/)
})

/**
 * ⚠️ Аварийный экран — единственное, что приезжает с чужого планшета. Без
 * версии браузера по нему нельзя понять даже, поддерживается ли там то, на чём
 * приложение упало.
 */
test('аварийный экран планшета называет браузер и объясняет «Script error.»', async () => {
  const html = await readFile(new URL('../../tablet.html', import.meta.url), 'utf8')
  assert.match(html, /navigator\.userAgent/)
  assert.match(html, /the browser hid the details/)
})

async function readBootGuardScript(): Promise<string> {
  const html = await readFile(new URL('../../tablet.html', import.meta.url), 'utf8')
  // CSP запрещает inline-обработчики: перезагрузка должна быть обычной
  // подпиской из nonce-скрипта, а не onclick в HTML.
  assert.doesNotMatch(html, /onclick\s*=/i)
  const script = html.match(/<script>\s*(\(function \(\) \{[\s\S]*?\}\)\(\))\s*<\/script>/)?.[1]
  assert.ok(script, 'inline guard script is present')
  return script
}

function evaluateBootGuard(script: string) {
  const listeners = new Map<string, (event: unknown) => void>()
  let timerCleared = false
  let observerDisconnected = false
  let observerCallback: (() => void) | null = null
  let timeoutCallback: (() => void) | null = null
  let reloadCallback: (() => void) | null = null
  let reloads = 0
  const root = { childElementCount: 0 }
  const box = { className: '' }
  const note = { textContent: '' }
  const detail = { textContent: '', style: { display: '' } }
  const reload = {
    addEventListener(type: string, callback: () => void) {
      if (type === 'click') reloadCallback = callback
    },
  }
  class FakeMutationObserver {
    constructor(callback: () => void) { observerCallback = callback }
    observe() {}
    disconnect() { observerDisconnected = true }
  }
  const windowStub = {
    addEventListener(type: string, callback: (event: unknown) => void) { listeners.set(type, callback) },
    removeEventListener(type: string, callback: (event: unknown) => void) {
      if (listeners.get(type) === callback) listeners.delete(type)
    },
    setTimeout(callback: () => void) { timeoutCallback = callback; return 1 },
    clearTimeout() { timerCleared = true },
    location: { reload() { reloads++ } },
  }
  const documentStub = {
    getElementById(id: string) {
      return id === 'root' ? root
        : id === 'boot-error' ? box
          : id === 'boot-error-note' ? note
            : id === 'boot-error-detail' ? detail
              : reload
    },
  }
  runInNewContext(script, {
    window: windowStub,
    document: documentStub,
    MutationObserver: FakeMutationObserver,
    navigator: { userAgent: 'test browser' },
  })
  return {
    listeners,
    root,
    box,
    note,
    mount() { root.childElementCount = 1; observerCallback?.() },
    fireTimeout() { timeoutCallback?.() },
    clickReload() { reloadCallback?.() },
    get timerCleared() { return timerCleared },
    get observerDisconnected() { return observerDisconnected },
    get reloads() { return reloads },
  }
}

test('загрузочный сторож снимается после первого рендера и не ловит поздний rejection', async () => {
  const fixture = evaluateBootGuard(await readBootGuardScript())
  assert.ok(fixture.listeners.has('unhandledrejection'))

  // Первый коммит React завершает фазу запуска. Поздний отказ API должен
  // оставить доску на экране, а не показать заставку загрузки.
  fixture.mount()
  assert.equal(fixture.timerCleared, true)
  assert.equal(fixture.observerDisconnected, true)
  assert.equal(fixture.listeners.has('unhandledrejection'), false)
  assert.equal(fixture.box.className, '')
  fixture.clickReload()
  assert.equal(fixture.reloads, 1)
})

test('загрузочный сторож показывает ошибку до React и перезагружает страницу по клику', async () => {
  const fixture = evaluateBootGuard(await readBootGuardScript())
  fixture.listeners.get('unhandledrejection')?.({ reason: new Error('ошибка запуска') })
  assert.equal(fixture.box.className, 'on')
  assert.match(fixture.note.textContent, /The app could not start/)
  assert.equal(fixture.timerCleared, true)
  assert.equal(fixture.listeners.has('unhandledrejection'), false)
  fixture.clickReload()
  assert.equal(fixture.reloads, 1)
})

test('загрузочный сторож показывает ошибку, если React не появился за десять секунд', async () => {
  const fixture = evaluateBootGuard(await readBootGuardScript())
  fixture.fireTimeout()
  assert.equal(fixture.box.className, 'on')
  assert.match(fixture.note.textContent, /The app did not load/)
  fixture.clickReload()
  assert.equal(fixture.reloads, 1)
})
