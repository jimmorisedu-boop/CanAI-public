import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { HELP_TOPICS } from './content/index.js'
import { filterHelpTopics, helpImageSrc, HelpPanel } from './HelpPanel.js'

test('help image paths follow the Vite base while SSR keeps public-root paths', () => {
  assert.equal(helpImageSrc('/help/example.svg', '/'), '/help/example.svg')
  assert.equal(helpImageSrc('/help/example.svg', '/tablet/'), '/tablet/help/example.svg')
  assert.equal(helpImageSrc('https://example.invalid/example.svg', '/tablet/'), 'https://example.invalid/example.svg')
})

test('help search includes assistant, photo, assets, and reference synonyms', () => {
  for (const query of ['assistant', 'photo', 'assets', 'reference']) {
    assert.ok(filterHelpTopics(query).length > 0, `expected a guide for ${query}`)
  }
})

test('help panel presents local images, accessible search, and a selected guide', () => {
  const topic = HELP_TOPICS[0]
  const html = renderToStaticMarkup(<HelpPanel initialTopicId={topic.id} onClose={() => {}} />)
  assert.match(html, /aria-label="Search guides"/)
  assert.match(html, /aria-label="Guides"/)
  assert.ok(!topic.steps[0]?.image || html.includes(topic.steps[0].image))
  assert.ok(html.includes(topic.title))
})

test('board actions are hidden when Help is opened from a gallery or tablet', () => {
  const topic = HELP_TOPICS.find((entry) => entry.id === 'quick-start') ?? HELP_TOPICS[0]
  const gallery = renderToStaticMarkup(<HelpPanel initialTopicId={topic.id} showBoardActions={false} />)
  const board = renderToStaticMarkup(<HelpPanel initialTopicId={topic.id} showBoardActions />)
  assert.doesNotMatch(gallery, /Show the prompt|Open on the board/)
  if (topic.target) assert.match(board, /Show the prompt|Open on the board/)
})
