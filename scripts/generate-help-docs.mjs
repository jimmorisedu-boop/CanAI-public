import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SCRIPT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const GUIDE_RELATIVE = path.join('client', 'src', 'help', 'content', 'guide.json')
const OUTPUT_RELATIVE = path.join('docs', 'help')
const SAFE_TOPIC_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u
const SAFE_HELP_IMAGE = /^\/help\/[A-Za-z0-9._-]+\.svg$/u
const normalizeEol = value => value.replace(/\r\n?/gu, '\n')

function validateGuide(guide) {
  if (!guide || !Array.isArray(guide.categories) || !Array.isArray(guide.topics)) {
    throw new Error('Help guide must contain categories and topics arrays')
  }
  const topicIds = new Set()
  for (const topic of guide.topics) {
    const id = topic?.id
    if (typeof id !== 'string' || !SAFE_TOPIC_ID.test(id)) {
      throw new Error(`Unsafe Help topic id: ${String(id ?? '<missing>')}`)
    }
    if (topicIds.has(id)) throw new Error(`Duplicate Help topic id: ${id}`)
    topicIds.add(id)
    if (topic.related !== undefined && !Array.isArray(topic.related)) throw new Error(`Invalid related topics in ${id}`)
    for (const related of topic.related ?? []) {
      if (typeof related !== 'string' || !SAFE_TOPIC_ID.test(related)) {
        throw new Error(`Unsafe related Help topic id in ${id}: ${String(related)}`)
      }
    }
    if (topic.steps !== undefined && !Array.isArray(topic.steps)) throw new Error(`Invalid steps in ${id}`)
    for (const step of topic.steps ?? []) {
      if (typeof step?.image !== 'string' || !SAFE_HELP_IMAGE.test(step.image)) {
        throw new Error(`Unsafe Help image path in ${id}: ${String(step?.image ?? '<missing>')}`)
      }
    }
  }
  for (const topic of guide.topics) {
    for (const related of topic.related ?? []) {
      if (!topicIds.has(related)) throw new Error(`Unknown related Help topic in ${topic.id}: ${related}`)
    }
  }
  return guide
}

function readGuide(root) {
  const guidePath = path.join(root, GUIDE_RELATIVE)
  let guide
  try {
    guide = JSON.parse(fs.readFileSync(guidePath, 'utf8'))
  } catch (error) {
    throw new Error(`Unable to read Help guide ${GUIDE_RELATIVE}: ${error instanceof Error ? error.message : String(error)}`)
  }
  return validateGuide(guide)
}

function anchor(value) {
  return String(value)
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
}

function categoryMap(guide) {
  return new Map(guide.categories.map(category => [category.id, category]))
}

function topicPath(topic) {
  return `${topic.id}.md`
}

function renderTopic(topic, categories, topicsById) {
  const category = categories.get(topic.category)
  const lines = [
    `# ${topic.title}`,
    '',
    topic.summary,
    '',
    `**Category:** [${category?.title ?? topic.category}](./README.md#${anchor(category?.title ?? topic.category)})`,
  ]
  lines.push('', '## Steps', '')
  for (const [index, step] of topic.steps.entries()) {
    lines.push(`### ${index + 1}. ${step.title}`, '', step.body, '', `![${step.alt}](../../client/public${step.image})`, '')
  }
  if (topic.notes?.length) {
    lines.push('## Notes', '')
    for (const note of topic.notes) lines.push(`- ${note}`)
    lines.push('')
  }
  if (topic.shortcuts?.length) {
    lines.push('## Shortcuts', '')
    for (const shortcut of topic.shortcuts) lines.push(`- **${shortcut.keys}** — ${shortcut.action}`)
    lines.push('')
  }
  if (topic.related?.length) {
    lines.push('## Related topics', '')
    for (const relatedId of topic.related) {
      const related = topicsById.get(relatedId)
      lines.push(`- [${related?.title ?? relatedId}](./${relatedId}.md)`)
    }
    lines.push('')
  }
  lines.push('---', '', '[Help index](./README.md) · [README](../../README.md) · [Getting started](../../docs/GETTING-STARTED.md)', '')
  return `${lines.join('\n')}`
}

function renderIndex(guide) {
  const topicsByCategory = new Map(guide.categories.map(category => [category.id, []]))
  for (const topic of guide.topics) (topicsByCategory.get(topic.category) ?? topicsByCategory.get(guide.categories[0]?.id))?.push(topic)
  const lines = [
    '# CanAI Help',
    '',
    'Find a task, follow the steps, and keep working locally in CanAI.',
    '',
    'Open the `?` Help button in CanAI to view the same illustrated tasks.',
    '',
    '[Project README](../../README.md) · [Getting started](../../docs/GETTING-STARTED.md)',
    '',
    '## Quick links',
    '',
  ]
  const quickIds = ['quick-start', 'assets', 'assistant-photos', 'references', 'import', 'first-result', 'recovery']
  const byId = new Map(guide.topics.map(topic => [topic.id, topic]))
  for (const id of quickIds) {
    const topic = byId.get(id)
    if (topic) lines.push(`- [${topic.title}](./${topicPath(topic)}) — ${topic.summary}`)
  }
  lines.push('', '## Browse by category', '')
  for (const category of guide.categories) {
    lines.push(`### ${category.title}`, '')
    for (const topic of topicsByCategory.get(category.id) ?? []) lines.push(`- [${topic.title}](./${topicPath(topic)}) — ${topic.summary}`)
    lines.push('')
  }
  lines.push(
    '---',
    '',
    '<details>',
    '<summary>About this reference</summary>',
    '',
    'These pages are generated by `npm run docs:help` from `client/src/help/content/guide.json` and its local SVG illustrations. Run `npm run check:help` to detect stale pages.',
    '',
    '</details>',
    '',
  )
  return lines.join('\n')
}

export function renderHelpDocs(guide) {
  validateGuide(guide)
  const categories = categoryMap(guide)
  const topicsById = new Map(guide.topics.map(topic => [topic.id, topic]))
  const files = { 'README.md': renderIndex(guide) }
  for (const topic of guide.topics) files[topicPath(topic)] = renderTopic(topic, categories, topicsById)
  return files
}

function outputDirectory(root) {
  return path.join(root, OUTPUT_RELATIVE)
}

function pathInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function validateLocalLinks({ root, output, name, content, errors }) {
  const markdownLinks = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+["'][^)]*["'])?\)/gu
  for (const match of content.matchAll(markdownLinks)) {
    const target = match[1]
    if (!target || target.startsWith('#') || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/iu.test(target)) continue
    const [pathname] = target.split('#', 1)
    if (!pathname) continue
    const resolved = path.resolve(output, pathname)
    if (!pathInside(root, resolved)) {
      errors.push(`Generated Help link escapes checkout: ${name} -> ${target}`)
    } else if (!fs.existsSync(resolved)) {
      errors.push(`Broken generated Help link: ${name} -> ${target}`)
    }
  }
}

export function buildHelpDocs({ root = SCRIPT_ROOT } = {}) {
  const sourceRoot = path.resolve(root)
  const files = renderHelpDocs(readGuide(sourceRoot))
  const output = outputDirectory(sourceRoot)
  fs.mkdirSync(output, { recursive: true })
  for (const entry of fs.readdirSync(output, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.md')) fs.rmSync(path.join(output, entry.name))
  }
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(output, name), content, 'utf8')
  return { output, files: Object.keys(files) }
}

export function checkHelpDocs({ root = SCRIPT_ROOT } = {}) {
  const sourceRoot = path.resolve(root)
  const errors = []
  let guide
  let files
  try {
    guide = readGuide(sourceRoot)
    files = renderHelpDocs(guide)
  } catch (error) {
    return [`Generated Help source is invalid: ${error instanceof Error ? error.message : String(error)}`]
  }
  for (const topic of guide.topics) {
    for (const step of topic.steps ?? []) {
      const image = step.image.slice('/help/'.length)
      const imagePath = path.join(sourceRoot, 'client', 'public', 'help', image)
      if (!fs.existsSync(imagePath)) errors.push(`Missing generated Help image: client/public/help/${image}`)
    }
  }
  const output = outputDirectory(sourceRoot)
  if (!fs.existsSync(output)) return [`Missing generated Help directory: ${OUTPUT_RELATIVE}`]
  for (const [name, expected] of Object.entries(files)) {
    const target = path.join(output, name)
    if (!fs.existsSync(target)) {
      errors.push(`Missing generated Help page: ${path.posix.join(OUTPUT_RELATIVE.replaceAll(path.sep, '/'), name)}`)
      continue
    }
    const actual = fs.readFileSync(target, 'utf8')
    if (normalizeEol(actual) !== normalizeEol(expected)) errors.push(`Generated Help page is stale: ${path.posix.join(OUTPUT_RELATIVE.replaceAll(path.sep, '/'), name)}`)
    validateLocalLinks({ root: sourceRoot, output, name, content: expected, errors })
  }
  for (const entry of fs.readdirSync(output, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.md') && !(entry.name in files)) errors.push(`Unexpected generated Help page: ${entry.name}`)
  }
  return errors
}

function usage() {
  return 'Usage: node scripts/generate-help-docs.mjs <build|check> [--root <checkout>]'
}

function parseArgs(argv) {
  const command = argv[0] ?? 'build'
  if (!['build', 'check'].includes(command)) throw new Error(`Unknown command: ${command}\n${usage()}`)
  const rootIndex = argv.indexOf('--root')
  const root = rootIndex >= 0 ? argv[rootIndex + 1] : SCRIPT_ROOT
  if (rootIndex >= 0 && !root) throw new Error('--root requires a directory')
  return { command, root }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const { command, root } = parseArgs(process.argv.slice(2))
    if (command === 'build') {
      const result = buildHelpDocs({ root })
      console.log(`Generated ${result.files.length} Help pages in ${path.relative(root, result.output) || '.'}`)
    } else {
      const errors = checkHelpDocs({ root })
      if (errors.length) throw new Error(errors.join('\n'))
      console.log('Generated Help pages are current')
    }
  } catch (error) {
    console.error(`[help-docs] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
