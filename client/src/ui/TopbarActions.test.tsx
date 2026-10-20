import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { TopbarActions, topbarAttention } from './TopbarActions'

const slots = {
  save: <span>Saved ✓</span>,
  exportControl: <div id="top-bar-export-portal" />,
  tasks: <button type="button">Tasks</button>,
  balance: <button type="button">Balance</button>,
}

function render(compact: boolean, defaultMenuOpen = false, attention = false): string {
  return renderToStaticMarkup(
    <TopbarActions
      compact={compact}
      defaultMenuOpen={defaultMenuOpen}
      attention={attention}
      theme="dark"
      save={slots.save}
      shareActions={null}
      exportControl={slots.exportControl}
      tasks={slots.tasks}
      balance={slots.balance}
      onSettings={() => {}}
      onTheme={() => {}}
      onHelp={() => {}}
    />,
  )
}

test('ordinary topbar shows each local control exactly once', () => {
  const html = render(false)

  assert.doesNotMatch(html, /aria-label="More"/)
  assert.equal((html.match(/id="top-bar-export-portal"/g) ?? []).length, 1)
  assert.equal((html.match(/>Tasks</g) ?? []).length, 1)
  assert.equal((html.match(/>Balance</g) ?? []).length, 1)
  assert.doesNotMatch(html, /participants|share-actions|guest/u)
  assert.match(html, /class="tab settings-button icon-btn"/)
  assert.match(html, /aria-label="Settings"/)
  assert.doesNotMatch(html, />\s*Settings\s*<\/button>/)
  assert.ok(html.indexOf('help-button') < html.indexOf('top-bar-export-portal'))
})

test('closed compact topbar keeps the More menu and attention indicator', () => {
  const html = render(true, false, true)

  assert.match(html, /aria-label="More"/)
  assert.match(html, /data-attention="true"/)
  assert.match(html, /hidden=""/)
  assert.equal((html.match(/id="top-bar-export-portal"/g) ?? []).length, 1)
  assert.doesNotMatch(html, /participants|share-actions|guest/u)
})

test('open compact topbar presents local actions in a stable order', () => {
  const html = render(true, true)
  const labels = ['Saved ✓', 'Settings', 'top-bar-export-portal', 'Tasks', 'Balance', 'Light theme', 'Help']
  let cursor = -1
  for (const label of labels) {
    const next = html.indexOf(label, cursor + 1)
    assert.ok(next > cursor, `${label} must follow the previous action`)
    cursor = next
  }
  assert.equal((html.match(/id="top-bar-export-portal"/g) ?? []).length, 1)
})

test('attention is enabled only for states requiring action', () => {
  assert.equal(topbarAttention({ saveStatus: 'saved', activeTasks: 0, failedTasks: 0 }), false)
  assert.equal(topbarAttention({ saveStatus: 'saving', activeTasks: 0, failedTasks: 0 }), false)
  assert.equal(topbarAttention({ saveStatus: 'error', activeTasks: 0, failedTasks: 0 }), true)
  assert.equal(topbarAttention({ saveStatus: 'saved', activeTasks: 2, failedTasks: 0 }), true)
  assert.equal(topbarAttention({ saveStatus: 'saved', activeTasks: 0, failedTasks: 1 }), true)
})
