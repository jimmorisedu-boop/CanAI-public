import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { OverflowMenu } from './OverflowMenu'

test('закрытое меню сохраняет portal-target, но исключает панель из взаимодействия', () => {
  const html = renderToStaticMarkup(
    <OverflowMenu label="Ещё" panelLabel="Действия" attention compact>
      <button type="button">Настройки</button>
    </OverflowMenu>,
  )

  assert.match(html, /aria-haspopup="menu"/)
  assert.match(html, /aria-expanded="false"/)
  assert.match(html, /data-attention="true"/)
  assert.match(html, /hidden=""/)
  assert.match(html, />Настройки</)
})

test('открытое меню связывает trigger и панель и показывает действия', () => {
  const html = renderToStaticMarkup(
    <OverflowMenu label="Ещё" panelLabel="Действия" compact defaultOpen>
      <button type="button">Настройки</button>
    </OverflowMenu>,
  )

  const controls = html.match(/aria-controls="([^"]+)"/)?.[1]
  assert.ok(controls)
  assert.match(html, /aria-expanded="true"/)
  assert.match(html, new RegExp(`id="${controls}"`))
  assert.match(html, /role="menu"/)
  assert.match(html, /aria-label="Действия"/)
  assert.match(html, />Настройки</)
})

test('выбор действия закрывает компактное меню и не оставляет его поверх результата', () => {
  const source = readFileSync(new URL('./OverflowMenu.tsx', import.meta.url), 'utf8')

  assert.match(source, /onClickCapture=\{closeAfterAction\}/)
  assert.match(source, /closest\('button, a\[href\], \[role="menuitem"\]'\)/)
  assert.match(source, /setOpen\(false\)/)
})
