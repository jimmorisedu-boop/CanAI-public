import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { buildHelpDocs, checkHelpDocs, renderHelpDocs } from './generate-help-docs.mjs'

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-help-docs-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const guide = {
    categories: [{ id: 'basics', title: 'Basics' }],
    topics: [{
      id: 'quick-start',
      category: 'basics',
      title: 'Start a local board',
      summary: 'Open a board and keep the first result nearby.',
      keywords: ['board', 'start'],
      steps: [{ title: 'Open CanAI', body: 'Start the local app.', image: '/help/quick-start-1.svg', alt: 'Canvas with the start control' }, { title: 'Create a board', body: 'Choose New board.', image: '/help/quick-start-2.svg', alt: 'New board dialog' }],
      notes: ['The board stays local.'],
      shortcuts: [{ keys: 'Ctrl+S', action: 'Save the board' }],
      related: ['quick-start'],
      target: 'save-for-later',
    }],
  }
  await fs.mkdir(path.join(root, 'client', 'src', 'help', 'content'), { recursive: true })
  await fs.mkdir(path.join(root, 'client', 'public', 'help'), { recursive: true })
  await fs.mkdir(path.join(root, 'docs'), { recursive: true })
  await fs.writeFile(path.join(root, 'client', 'src', 'help', 'content', 'guide.json'), JSON.stringify(guide, null, 2))
  await fs.writeFile(path.join(root, 'client', 'public', 'help', 'quick-start-1.svg'), '<svg></svg>')
  await fs.writeFile(path.join(root, 'client', 'public', 'help', 'quick-start-2.svg'), '<svg></svg>')
  await fs.writeFile(path.join(root, 'README.md'), '# CanAI\n')
  await fs.writeFile(path.join(root, 'docs', 'GETTING-STARTED.md'), '# Getting started\n')
  return { root, guide }
}

test('Help docs generation preserves topics, optional fields, links, and local images', async (t) => {
  const { root, guide } = await fixture(t)
  const rendered = renderHelpDocs(guide)
  assert.deepEqual(Object.keys(rendered), ['README.md', 'quick-start.md'])
  assert.match(rendered['README.md'], /Open the `\?` Help button in CanAI/u)
  assert.match(rendered['README.md'], /\[Start a local board\]\(\.\/quick-start\.md\)/u)
  assert.match(rendered['quick-start.md'], /!\[Canvas with the start control\]\(\.\.\/\.\.\/client\/public\/help\/quick-start-1\.svg\)/u)
  assert.match(rendered['quick-start.md'], /\*\*Category:\*\* \[Basics\]\(\.\/README\.md#basics\)/u)
  assert.match(rendered['quick-start.md'], /\[Help index\]\(\.\/README\.md\)/u)
  assert.match(rendered['quick-start.md'], /\[README\]\(\.\.\/\.\.\/README\.md\)/u)
  assert.match(rendered['quick-start.md'], /\[Getting started\]\(\.\.\/\.\.\/docs\/GETTING-STARTED\.md\)/u)
  assert.doesNotMatch(rendered['quick-start.md'], /Guide target|Keywords/u)
  const result = buildHelpDocs({ root })
  assert.equal(result.files.length, 2)
  assert.deepEqual(checkHelpDocs({ root }), [])

  const generatedPath = path.join(root, 'docs', 'help', 'quick-start.md')
  const generated = await fs.readFile(generatedPath, 'utf8')
  await fs.writeFile(generatedPath, generated.replace(/\n/gu, '\r\n'))
  assert.deepEqual(checkHelpDocs({ root }), [])
  await fs.rm(path.join(root, 'docs', 'GETTING-STARTED.md'))
  assert.ok(checkHelpDocs({ root }).some(error => /Broken generated Help link: README\.md -> \.\.\/\.\.\/docs\/GETTING-STARTED\.md/u.test(error)))
})

test('Help docs check reports missing, stale, and unexpected generated pages', async (t) => {
  const { root } = await fixture(t)
  buildHelpDocs({ root })
  await fs.rm(path.join(root, 'docs', 'help', 'quick-start.md'))
  await fs.writeFile(path.join(root, 'docs', 'help', 'old-topic.md'), '# old\n')
  const errors = checkHelpDocs({ root })
  assert.ok(errors.some(error => /Missing generated Help page: docs\/help\/quick-start\.md/u.test(error)))
  assert.ok(errors.some(error => /Unexpected generated Help page: old-topic\.md/u.test(error)))

  await fs.writeFile(path.join(root, 'docs', 'help', 'quick-start.md'), '# stale\n')
  const stale = checkHelpDocs({ root })
  assert.ok(stale.some(error => /Generated Help page is stale: docs\/help\/quick-start\.md/u.test(error)))
})

test('Help docs reject unsafe topic and image paths before writing', async (t) => {
  const { root, guide } = await fixture(t)
  const unsafeTopic = structuredClone(guide)
  unsafeTopic.topics[0].id = '../outside'
  assert.throws(() => renderHelpDocs(unsafeTopic), /Unsafe Help topic id/u)

  const unsafeImage = structuredClone(guide)
  unsafeImage.topics[0].steps[0].image = '/help/../secret.svg'
  assert.throws(() => renderHelpDocs(unsafeImage), /Unsafe Help image path/u)

  const unknownRelated = structuredClone(guide)
  unknownRelated.topics[0].related = ['missing-topic']
  assert.throws(() => renderHelpDocs(unknownRelated), /Unknown related Help topic/u)

  buildHelpDocs({ root })
  await fs.rm(path.join(root, 'client', 'public', 'help', 'quick-start-2.svg'))
  const errors = checkHelpDocs({ root })
  assert.ok(errors.some(error => /Missing generated Help image: client\/public\/help\/quick-start-2\.svg/u.test(error)))
})
