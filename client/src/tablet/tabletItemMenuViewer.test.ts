import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8')

test('меню объекта уплотняется в две колонки и сохраняет палец и доступные подписи', () => {
  const source = read('./TabletItemMenu.tsx')
  const css = read('./tabletCompactChrome.css')

  assert.match(source, /className="tablet-item-menu-actions"/u)
  assert.match(source, /role="menuitem"[\s\S]{0,500}aria-label=\{disabledReason/u)
  assert.match(css, /body \.tablet-item-menu-object\s*\{[\s\S]*?width:\s*min\(344px/u)
  assert.match(css, /\.tablet-item-menu-actions\s*\{[\s\S]*?grid-template-columns:\s*repeat\(2/u)
  assert.match(css, /\.tablet-item-menu \.tablet-menu-item\s*\{[\s\S]*?min-height:\s*max\(44px/u)
  assert.match(css, /\.tablet-item-menu \.tablet-menu-sep\s*\{[\s\S]*?display:\s*none/u)
})

test('просмотрщик центрирует вписанный материал после поворота, resize и смены режима', () => {
  const source = read('./TabletMediaViewer.tsx')
  const css = read('./tabletMediaViewer.css')

  assert.match(source, /useLayoutEffect/u)
  assert.match(source, /stageRef/u)
  assert.match(source, /visualViewport\?\.addEventListener\(['"]resize/u)
  assert.match(source, /orientationchange/u)
  assert.match(source, /view === 'fit'[\s\S]{0,500}scroll(?:Left|Top)\s*=\s*0/u)
  assert.match(css, /\.tablet-media-viewer-stage\s*\{[\s\S]*?display:\s*flex/u)
  assert.match(css, /\.tablet-media-viewer-stage\s*\{[\s\S]*?align-items:\s*center/u)
  assert.match(css, /\.tablet-media-viewer-stage\s*\{[\s\S]*?justify-content:\s*center/u)
  assert.match(css, /\.tablet-media-viewer-stage\.actual[\s\S]*?max-width:\s*none/u)
})
