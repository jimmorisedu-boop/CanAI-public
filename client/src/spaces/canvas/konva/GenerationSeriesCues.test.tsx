import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { CueDirection } from './generationSeriesGeometry'
import * as GenerationSeriesCuesModule from './GenerationSeriesCues'
import { resultWord, type GenerationSeriesCueModel } from './useGenerationSeriesReveal'

const componentSource = readFileSync(
  new URL('./GenerationSeriesCues.tsx', import.meta.url),
  'utf8',
)
const { GenerationSeriesCues } = GenerationSeriesCuesModule
const konvaCanvasSource = readFileSync(new URL('./KonvaCanvas.tsx', import.meta.url), 'utf8')
const canvasSpaceSource = readFileSync(new URL('../CanvasSpace.tsx', import.meta.url), 'utf8')
const promptBarSource = readFileSync(new URL('../PromptBar.tsx', import.meta.url), 'utf8')
const assetBarSource = readFileSync(new URL('../AssetBar.tsx', import.meta.url), 'utf8')
const archiveBarSource = readFileSync(new URL('../archive/ArchiveBar.tsx', import.meta.url), 'utf8')
const canvasUiSource = readFileSync(new URL('../../../styles/canvas-ui.css', import.meta.url), 'utf8')
const compactSource = readFileSync(new URL('../../../styles/compact.css', import.meta.url), 'utf8')
const motionSource = readFileSync(new URL('../../../styles/typography-motion.css', import.meta.url), 'utf8')
const geometrySource = readFileSync(new URL('./generationSeriesGeometry.ts', import.meta.url), 'utf8')

interface FocusKeeper {
  capturePointer(event: { preventDefault(): void }): void
  remember(target: unknown): void
  restoreForActivation(detail: number): void
}

const focusKeeperFactory = (
  GenerationSeriesCuesModule as unknown as {
    createGenerationSeriesCueFocusKeeper?: (getActiveElement: () => unknown) => FocusKeeper
  }
).createGenerationSeriesCueFocusKeeper

const accessibleNames: Record<CueDirection, string> = {
  left: 'Show more 3 results left',
  right: 'Show more 3 results right',
  up: 'Show more 3 results top',
  down: 'Show more 3 results bottom',
  mixed: 'Show all 4 results',
}

function cue(direction: CueDirection): GenerationSeriesCueModel {
  return {
    launchId: `launch-${direction}`,
    direction,
    hiddenCount: 3,
    totalCount: 4,
    x: 24,
    y: 36,
    accessibleName: accessibleNames[direction],
  }
}

test('pointer click сохраняет прежний постоянный DOM-фокус', () => {
  assert.equal(typeof focusKeeperFactory, 'function', 'нужен focus keeper для cue')
  let prevented = 0
  let focusCalls = 0
  const previous = {
    isConnected: true,
    matches: () => false,
    focus: () => { focusCalls++ },
  }
  const keeper = focusKeeperFactory!(() => previous)

  keeper.capturePointer({ preventDefault: () => { prevented++ } })
  keeper.restoreForActivation(1)

  assert.equal(prevented, 1, 'pointer не должен переводить фокус на исчезающий cue')
  assert.equal(focusCalls, 0, 'уже активный элемент не надо фокусировать повторно')
})

test('pointer activation возвращает фокус, если после click его забрал canvas', async () => {
  assert.equal(typeof focusKeeperFactory, 'function', 'нужен focus keeper для cue')
  const calls: unknown[] = []
  const previous = {
    isConnected: true,
    matches: () => false,
    focus: (options?: unknown) => { calls.push(options) },
  }
  const canvas = {
    isConnected: true,
    matches: () => false,
    focus: () => {},
  }
  let active: unknown = previous
  const keeper = focusKeeperFactory!(() => active)

  keeper.capturePointer({ preventDefault: () => {} })
  active = canvas
  keeper.restoreForActivation(1)
  await Promise.resolve()

  assert.deepEqual(calls, [{ preventScroll: true }])
})

test('Enter и Space возвращают фокус к предыдущему постоянному элементу без scroll', async () => {
  assert.equal(typeof focusKeeperFactory, 'function', 'нужен focus keeper для cue')

  for (const key of ['Enter', 'Space']) {
    const calls: unknown[] = []
    const previous = {
      isConnected: true,
      matches: () => false,
      focus: (options?: unknown) => { calls.push(options) },
    }
    const keeper = focusKeeperFactory!(() => null)
    keeper.remember(previous)

    // Нативная button сводит Enter и Space к click с detail=0.
    keeper.restoreForActivation(0)
    await Promise.resolve()

    assert.deepEqual(calls, [{ preventScroll: true }], `${key} должен вернуть прежний фокус один раз`)
  }
})

test('правый cue имеет человеческую подпись и нативную кнопку', () => {
  const html = renderToStaticMarkup(
    <GenerationSeriesCues cues={[cue('right')]} onShow={() => {}} />,
  )

  assert.match(html, /<button/)
  assert.match(html, /type="button"/)
  assert.match(html, /aria-label="Show more 3 results right"/)
  assert.match(html, />More 3<\/span>/)
})

test('каждое направление получает точное English доступное имя', () => {
  for (const direction of ['left', 'right', 'up', 'down', 'mixed'] as const) {
    const html = renderToStaticMarkup(
      <GenerationSeriesCues cues={[cue(direction)]} onShow={() => {}} />,
    )
    assert.match(html, new RegExp(`aria-label="${accessibleNames[direction]}"`))
  }
})

test('mixed cue показывает общее число результатов', () => {
  const html = renderToStaticMarkup(
    <GenerationSeriesCues cues={[cue('mixed')]} onShow={() => {}} />,
  )

  assert.match(html, />All 4<\/span>/)
})

test('result labels use plural English for counts other than one', () => {
  assert.equal(resultWord(1), 'result')
  assert.equal(resultWord(2), 'results')
  assert.equal(resultWord(21), 'results')
})

test('пустой список cue ничего не рендерит', () => {
  const html = renderToStaticMarkup(
    <GenerationSeriesCues cues={[]} onShow={() => {}} />,
  )

  assert.equal(html, '')
})

test('координаты задаются inline, а визуальные цвета остаются в CSS', () => {
  const html = renderToStaticMarkup(
    <GenerationSeriesCues cues={[cue('left')]} onShow={() => {}} />,
  )

  assert.match(html, /style="left:24px;top:36px"/)
  assert.doesNotMatch(html, /style="[^"]*(?:color|background|border|shadow)/i)
})

test('кнопки имеют стабильный key по launchId и передают тот же id в onShow', () => {
  assert.match(componentSource, /key=\{cue\.launchId\}/)
  assert.match(componentSource, /onShow\(cue\.launchId\)/)
})

test('нижняя панель и панели справа всегда учитываются при размещении результата', () => {
  // The assistant keeps its dock position while its height changes manually.
  assert.match(promptBarSource, /data-canvas-safe-edge="bottom"/)
  assert.match(assetBarSource, /data-canvas-safe-edge="right"/)
  assert.match(archiveBarSource, /data-canvas-safe-edge="right"/)
})

test('KonvaCanvas измеряет safe edges в локальных координатах и делит один viewport со store', () => {
  assert.match(konvaCanvasSource, /safeViewportFromOcclusions/)
  assert.match(konvaCanvasSource, /closest\('\.canvas-main'\)/)
  assert.match(konvaCanvasSource, /querySelectorAll<HTMLElement>\('\[data-canvas-safe-edge\]'\)/)
  assert.match(konvaCanvasSource, /new ResizeObserver\(apply\)/)
  assert.match(konvaCanvasSource, /store\.setGenerationSafeViewport\(safeViewport\)/)
  assert.match(konvaCanvasSource, /viewport:\s*safeViewport/)
  assert.match(konvaCanvasSource, /obstacles/)
})

test('CanvasSpace передаёт projectId, а reveal отключён в скетче и кропе', () => {
  assert.match(canvasSpaceSource, /<KonvaCanvas[\s\S]*?projectId=\{projectId\}/)
  assert.match(konvaCanvasSource, /projectId:\s*string/)
  assert.match(konvaCanvasSource, /useGenerationSeriesReveal\(\{/)
  assert.match(konvaCanvasSource, /enabled:\s*visible\s*&&\s*!sketching\s*&&\s*!cropping/)
})

test('HTML cue стоит сразу после Stage и до item toolbars', () => {
  const stageEnd = konvaCanvasSource.indexOf('</Stage>')
  const cueOverlay = konvaCanvasSource.indexOf('<GenerationSeriesCues')
  const itemToolbar = konvaCanvasSource.indexOf('<ItemToolbar')

  assert.ok(stageEnd >= 0 && stageEnd < cueOverlay)
  assert.ok(cueOverlay < itemToolbar)
})

test('cue CSS сохраняет 44px, nowrap, токены и сдержанное движение', () => {
  const base = canvasUiSource.match(/\.generation-series-cue\s*\{([^}]+)\}/)?.[1] ?? ''
  for (const rule of [
    /position:\s*absolute/,
    /z-index:\s*340/,
    /display:\s*inline-flex/,
    /align-items:\s*center/,
    /justify-content:\s*center/,
    /gap:\s*8px/,
    /min-height:\s*44px/,
    /padding:\s*0 16px/,
    /border:\s*1px solid var\(--border-strong\)/,
    /border-radius:\s*var\(--radius-pill\)/,
    /background:\s*var\(--material-regular\)/,
    /color:\s*var\(--text\)/,
    /box-shadow:\s*var\(--shadow-sm\)/,
    /white-space:\s*nowrap/,
  ]) assert.match(base, rule)

  assert.match(canvasUiSource, /\.generation-series-cue:hover:not\(:disabled\)/)
  assert.match(canvasUiSource, /\.generation-series-cue:active:not\(:disabled\)/)
  assert.match(canvasUiSource, /\.generation-series-cue:focus-visible/)
  assert.match(canvasUiSource, /\.generation-series-cue:disabled/)
  assert.doesNotMatch(canvasUiSource, /\.generation-series-cue[^{]*\{[^}]*transition:\s*all/)
  assert.doesNotMatch(canvasUiSource, /\.generation-series-cue[^{]*\{[^}]*scale\(/)
  assert.match(compactSource, /\.generation-series-cue\s*\{[^}]*padding:\s*0 12px/)
  assert.match(motionSource, /\.generation-series-cue[\s\S]*?0\.01ms/)
})

test('минимальная ширина cue совпадает с контрактом геометрии', () => {
  const base = canvasUiSource.match(/\.generation-series-cue\s*\{([^}]+)\}/)?.[1] ?? ''
  const cssWidth = Number(base.match(/min-width:\s*(\d+)px/)?.[1])
  const geometryWidth = Number(geometrySource.match(/const MIN_CUE_WIDTH = (\d+)/)?.[1])

  assert.ok(Number.isFinite(geometryWidth), 'контракт MIN_CUE_WIDTH должен быть числом')
  assert.equal(cssWidth, geometryWidth)
})

test('AssetBar и ArchiveBar локально стоят выше слоя cue', () => {
  const cueBase = canvasUiSource.match(/\.generation-series-cue\s*\{([^}]+)\}/)?.[1] ?? ''
  const barsBase = canvasUiSource.match(
    /\.canvas-main\s+\.asset-bar,\s*\.canvas-main\s+\.archive-bar\s*\{([^}]+)\}/,
  )?.[1] ?? ''
  const toolbarBase = canvasUiSource.match(/\.konva-item-toolbar\s*\{([^}]+)\}/)?.[1] ?? ''
  const cueZ = Number(cueBase.match(/z-index:\s*(\d+)/)?.[1])
  const barsZ = Number(barsBase.match(/z-index:\s*(\d+)/)?.[1])
  const toolbarZ = Number(toolbarBase.match(/z-index:\s*(\d+)/)?.[1])

  assert.ok(barsZ > cueZ, `ожидался scoped z-index выше ${cueZ}, получен ${barsZ}`)
  assert.ok(barsZ < toolbarZ, `ожидался scoped z-index ниже ${toolbarZ}, получен ${barsZ}`)
})
