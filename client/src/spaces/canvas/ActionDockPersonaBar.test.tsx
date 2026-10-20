import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ActionDockPersonaBar } from './ActionDockPersonaBar'
import { dockHelperHint, dockHelperEligibility } from './dockHelper'

test('ActionDockPersonaBar: renders child slot and hint text', () => {
  const html = renderToStaticMarkup(
    <ActionDockPersonaBar hintText="Creates a result after running">
      <div id="test-picker">Selection</div>
    </ActionDockPersonaBar>
  )
  assert.match(html, /<div class="action-dock-persona-bar">/u)
  assert.match(html, /id="test-picker">Selection/u)
  assert.match(html, /<span class="action-dock-mode-hint">Creates a result after running<\/span>/u)
  assert.doesNotMatch(html, /role="status"/u)
})

test('ActionDockPersonaBar: renders four standard hint texts through dockHelperHint', () => {
  // 1. Make + Universal
  const univElig = dockHelperEligibility({
    kind: 'image',
    assistantId: null,
    imageRefsCount: 1,
  })
  const univHint = dockHelperHint('make', univElig)
  assert.equal(univHint, 'Creates a result after running')
  const univHtml = renderToStaticMarkup(
    <ActionDockPersonaBar hintText={univHint}>
      <span>Picker</span>
    </ActionDockPersonaBar>
  )
  assert.match(univHtml, /Creates a result after running/u)

  // 2. Make + Helper eligible
  const helpElig = dockHelperEligibility({
    kind: 'image',
    assistantId: 'asst_1',
    imageRefsCount: 1,
  })
  const helpHint = dockHelperHint('make', helpElig, 0.01)
  assert.equal(helpHint, 'Assistant · ≈ $0.01')
  const helpHtml = renderToStaticMarkup(
    <ActionDockPersonaBar hintText={helpHint}>
      <span>Picker</span>
    </ActionDockPersonaBar>
  )
  assert.match(helpHtml, /Assistant · ≈ \$0\.01/u)

  // 3. Make + Cloud tablet missing images
  const cloudElig = dockHelperEligibility({
    kind: 'image',
    assistantId: 'asst_1',
    imageRefsCount: 0,
    isStandaloneCloudTablet: true,
  })
  const cloudHint = dockHelperHint('make', cloudElig)
  assert.equal(cloudHint, 'Without an assistant: you need reference pictures')
  const cloudHtml = renderToStaticMarkup(
    <ActionDockPersonaBar hintText={cloudHint}>
      <span>Picker</span>
    </ActionDockPersonaBar>
  )
  assert.match(cloudHtml, /Without an assistant: you need reference pictures/u)

  // 4. Discuss
  const discussHint = dockHelperHint('discuss', helpElig)
  assert.equal(discussHint, 'Text only · no actions')
  const discussHtml = renderToStaticMarkup(
    <ActionDockPersonaBar hintText={discussHint}>
      <span>Picker</span>
    </ActionDockPersonaBar>
  )
  assert.match(discussHtml, /Text only · no actions/u)
})

test('ActionDockPersonaBar: does not contain "Настроить" or "цена по расходу" in Make mode', () => {
  const html = renderToStaticMarkup(
    <ActionDockPersonaBar hintText="Assistant · ≈ $0.01">
      <div className="assistant-picker-compact">
        <select aria-label="Choose assistant">
          <option>Universal</option>
          <option>Retoucher</option>
        </select>
      </div>
    </ActionDockPersonaBar>
  )
  assert.doesNotMatch(html, /Настроить/u)
  assert.doesNotMatch(html, /цена по расходу/u)
})

test('ActionDockPersonaBar: renders status and stop button when isPreparing is true', () => {
  const html = renderToStaticMarkup(
    <ActionDockPersonaBar
      hintText="Assistant · ≈ $0.01"
      isPreparing={true}
      preparingText="Retoucher is preparing the request…"
      onStop={() => {}}
    >
      <span>Picker</span>
    </ActionDockPersonaBar>
  )
  assert.match(html, /role="status"/u)
  assert.match(html, /Retoucher is preparing the request…/u)
  assert.match(html, /<button[^>]*class="action-dock-persona-stop"[^>]*>Stop<\/button>/u)
})
