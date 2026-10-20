import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkHelpDocs } from './generate-help-docs.mjs'

const scriptDir = resolve(fileURLToPath(new URL('.', import.meta.url)))
const repoRoot = resolve(scriptDir, '..')
const REQUIRED_TOPICS = ['import', 'references', 'assistant-photos', 'assets', 'quick-start']
const TARGETS = new Set(['first-generation', 'reference-generation', 'recovery', 'save-for-later', 'export'])
const SOURCE_FILE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx'])

export class HelpCheckError extends Error {
  constructor(errors) {
    super(errors.join('\n'))
    this.name = 'HelpCheckError'
    this.errors = errors
  }
}

const readText = path => readFileSync(path, 'utf8')

function parseCoverage(root) {
  const path = join(root, 'docs', 'help-maintenance.md')
  if (!existsSync(path)) return { entries: [], errors: ['Missing docs/help-maintenance.md'] }
  const text = readText(path)
  const match = text.match(/<!-- HELP_COVERAGE_START\s*([\s\S]*?)\s*HELP_COVERAGE_END -->/)
  if (!match) return { entries: [], errors: ['docs/help-maintenance.md is missing the HELP_COVERAGE markers'] }
  try {
    const entries = JSON.parse(match[1])
    if (!Array.isArray(entries)) throw new Error('coverage must be an array')
    return { entries, errors: [] }
  } catch (error) {
    return { entries: [], errors: [`Invalid help coverage JSON: ${error.message}`] }
  }
}

function validateSvg(path, errors) {
  let text
  try { text = readText(path) } catch { errors.push(`Missing help image: ${path}`); return }
  if (text.length > 20_000) errors.push(`Help image is too large (>20KB): ${path}`)
  if (!/^\s*<svg\b[\s\S]*<\/svg>\s*$/i.test(text)) errors.push(`Help image is not a complete SVG: ${path}`)
  if (/<\s*(script|foreignObject|iframe|object|embed)\b/i.test(text)) errors.push(`Unsafe element in help image: ${path}`)
  if (/\b(?:href|xlink:href)\s*=\s*["']\s*(?:https?:|data:|javascript:)/i.test(text)) errors.push(`External href in help image: ${path}`)
  if (/\b(?:src|url)\s*=\s*["']?\s*(?:https?:|data:)/i.test(text) || /url\(\s*(?:https?:|data:)/i.test(text)) errors.push(`External asset reference in help image: ${path}`)
  if (/<\s*\w+[^>]*\bon\w+\s*=/i.test(text)) errors.push(`Inline event handler in help image: ${path}`)
  if (/[А-Яа-яЁё]/.test(text)) errors.push(`Cyrillic text in help image: ${path}`)
  for (const match of text.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/gi)) {
    const value = match[1].replace(/<[^>]+>/g, '').trim()
    if (value.length > 90) errors.push(`Oversized text label in help image: ${path}`)
  }
}

function validateContent(root) {
  const errors = []
  const guidePath = join(root, 'client', 'src', 'help', 'content', 'guide.json')
  const typesPath = join(root, 'client', 'src', 'help', 'content', 'types.ts')
  const indexPath = join(root, 'client', 'src', 'help', 'content', 'index.ts')
  if (!existsSync(guidePath)) errors.push('Missing client/src/help/content/guide.json')
  if (!existsSync(typesPath)) errors.push('Missing client/src/help/content/types.ts')
  if (!existsSync(indexPath)) errors.push('Missing client/src/help/content/index.ts')
  if (errors.length) return { errors, topics: [], images: [] }
  if (!/HelpTopic/.test(readText(typesPath)) || !/HelpTarget/.test(readText(typesPath))) errors.push('types.ts must declare HelpTopic and HelpTarget')
  const index = readText(indexPath)
  if (!/HELP_CATEGORIES/.test(index) || !/HELP_TOPICS/.test(index)) errors.push('index.ts must export HELP_CATEGORIES and HELP_TOPICS')

  let guide
  try { guide = JSON.parse(readText(guidePath)) } catch (error) {
    errors.push(`Invalid guide.json: ${error.message}`)
    return { errors, topics: [], images: [] }
  }
  if (!Array.isArray(guide.categories) || guide.categories.length === 0) errors.push('guide.json must have non-empty categories')
  if (!Array.isArray(guide.topics) || guide.topics.length < 30) errors.push('guide.json must contain at least 30 Help topics')
  const categories = Array.isArray(guide.categories) ? guide.categories : []
  const categoryIds = new Set()
  categories.forEach((category, index) => {
    if (!category || typeof category !== 'object' || typeof category.id !== 'string' || typeof category.title !== 'string' || !category.id || !category.title) errors.push(`Invalid help category at index ${index}`)
    if (category?.id && categoryIds.has(category.id)) errors.push(`Duplicate help category id: ${category.id}`)
    if (category?.id) categoryIds.add(category.id)
  })
  const topics = Array.isArray(guide.topics) ? guide.topics : []
  const topicIds = new Set()
  const images = new Set()
  topics.forEach((topic, index) => {
    if (!topic || typeof topic !== 'object') { errors.push(`Invalid help topic at index ${index}`); return }
    for (const field of ['id', 'category', 'title', 'summary']) if (typeof topic[field] !== 'string' || !topic[field].trim()) errors.push(`Topic ${topic.id ?? index} has empty ${field}`)
    if (typeof topic.title === 'string' && topic.title.length > 80) errors.push(`Topic ${topic.id ?? index} title is too long`)
    if (typeof topic.summary === 'string' && topic.summary.length > 220) errors.push(`Topic ${topic.id ?? index} summary is too long`)
    if (topic.id && topicIds.has(topic.id)) errors.push(`Duplicate help topic id: ${topic.id}`)
    if (topic.id) topicIds.add(topic.id)
    if (topic.category && !categoryIds.has(topic.category)) errors.push(`Topic ${topic.id ?? index} uses unknown category ${topic.category}`)
    if (!Array.isArray(topic.keywords) || topic.keywords.length === 0 || topic.keywords.some(value => typeof value !== 'string' || !value.trim())) errors.push(`Topic ${topic.id ?? index} needs non-empty keywords`)
    if (!Array.isArray(topic.steps) || topic.steps.length < 2 || topic.steps.length > 4) errors.push(`Topic ${topic.id ?? index} must have 2–4 steps`)
    for (const step of Array.isArray(topic.steps) ? topic.steps : []) {
      for (const field of ['title', 'body', 'image', 'alt']) if (typeof step?.[field] !== 'string' || !step[field].trim()) errors.push(`Topic ${topic.id ?? index} has an empty step ${field}`)
      if (typeof step?.title === 'string' && step.title.length > 80) errors.push(`Topic ${topic.id ?? index} step title is too long`)
      if (typeof step?.body === 'string' && step.body.length > 260) errors.push(`Topic ${topic.id ?? index} step body is too long`)
      if (typeof step?.alt === 'string' && step.alt.length > 140) errors.push(`Topic ${topic.id ?? index} step alt is too long`)
      if (step?.image && !/^\/help\/[A-Za-z0-9._-]+\.svg$/.test(step.image)) errors.push(`Topic ${topic.id ?? index} has an invalid image path: ${step.image}`)
      if (step?.image) images.add(step.image)
      if (/[А-Яа-яЁё]/.test(`${step?.title ?? ''} ${step?.body ?? ''} ${step?.alt ?? ''}`)) errors.push(`Cyrillic text in topic ${topic.id ?? index}`)
    }
    for (const field of ['notes', 'related']) if (topic[field] !== undefined && (!Array.isArray(topic[field]) || topic[field].some(value => typeof value !== 'string' || !value.trim()))) errors.push(`Topic ${topic.id ?? index} has invalid ${field}`)
    if (topic.shortcuts !== undefined && (!Array.isArray(topic.shortcuts) || topic.shortcuts.some(value => !value || typeof value.keys !== 'string' || typeof value.action !== 'string' || !value.keys.trim() || !value.action.trim()))) errors.push(`Topic ${topic.id ?? index} has invalid shortcuts`)
    if (topic.target !== undefined && !TARGETS.has(topic.target)) errors.push(`Topic ${topic.id ?? index} has invalid target ${topic.target}`)
  })
  for (const required of REQUIRED_TOPICS) if (!topicIds.has(required)) errors.push(`Missing required Help topic: ${required}`)
  for (const topic of topics) for (const related of topic.related ?? []) if (!topicIds.has(related)) errors.push(`Topic ${topic.id} references missing related topic ${related}`)
  const publicHelp = join(root, 'client', 'public', 'help')
  for (const image of images) validateSvg(join(root, 'client', 'public', image), errors)
  const diskImages = existsSync(publicHelp) ? readdirSync(publicHelp).filter(name => name.endsWith('.svg')) : []
  if (diskImages.length < topics.length) errors.push(`Expected at least one distinct SVG per topic; found ${diskImages.length} for ${topics.length} topics`)
  return { errors, topics, images: [...images] }
}

function changedFiles(root, base) {
  const output = gitOutput(root, ['diff', '--name-only', base], `Unable to read git diff for --base ${base}`)
  return output.split(/\r?\n/).map(file => file.replaceAll('\\', '/')).filter(Boolean)
}

function gitOutput(root, args, label) {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    const stderr = String(error?.stderr ?? '').trim()
    throw new HelpCheckError([`${label}: ${stderr || error.message}`])
  }
}

function changedHelpTopics(root, base, files, currentTopics) {
  const changed = new Set()
  const guidePath = join(root, 'client', 'src', 'help', 'content', 'guide.json')
  // A first public Help addition has no guide in the base commit. Check the
  // tree first so that this expected case is quiet while invalid git refs and
  // malformed base guides still fail with an actionable error.
  const baseGuideEntry = gitOutput(root, ['ls-tree', '-r', '--name-only', base, '--', 'client/src/help/content/guide.json'], 'Unable to inspect Help guide at base').trim()
  let previous = null
  if (baseGuideEntry) {
    const raw = gitOutput(root, ['show', `${base}:client/src/help/content/guide.json`], 'Unable to read Help guide at base')
    try {
      previous = JSON.parse(raw)
    } catch (error) {
      throw new HelpCheckError([`Invalid base Help guide: ${error.message}`])
    }
  }
  if (!previous) {
    if (files.includes('client/src/help/content/guide.json') || existsSync(guidePath)) for (const topic of currentTopics) changed.add(topic.id)
  } else {
    const oldById = new Map((previous.topics ?? []).map(topic => [topic.id, JSON.stringify(topic)]))
    for (const topic of currentTopics) if (oldById.get(topic.id) !== JSON.stringify(topic)) changed.add(topic.id)
    for (const oldId of oldById.keys()) if (!currentTopics.some(topic => topic.id === oldId)) changed.add(oldId)
  }
  for (const file of files) {
    if (!file.startsWith('client/public/help/') || !file.endsWith('.svg')) continue
    const name = file.slice('client/public/help/'.length)
    for (const topic of currentTopics) if (name.startsWith(`${topic.id}-`)) changed.add(topic.id)
  }
  return changed
}

function validateDrift(root, base, coverage, topics) {
  if (base === undefined || base === null || base === '') return base === '' ? ['--base requires a non-empty git ref'] : []
  const errors = []
  const files = changedFiles(root, base)
  const entries = coverage.entries
  const changedTopics = changedHelpTopics(root, base, files, topics)
  for (const file of files) {
    if (file.startsWith('client/src/help/')) continue
    const extension = file.slice(file.lastIndexOf('.'))
    if (!SOURCE_FILE_EXTENSIONS.has(extension) || /(?:\.test|\.spec)\./.test(file)) continue
    const match = entries
      .filter(entry => typeof entry.prefix === 'string' && file.startsWith(entry.prefix))
      .sort((left, right) => right.prefix.length - left.prefix.length)[0]
    if (!match) {
      if (file.startsWith('client/src/')) errors.push(`Changed user-facing source has no Help coverage mapping: ${file}`)
      continue
    }
    const topicIds = Array.isArray(match.topics) ? match.topics : []
    if (!topicIds.some(id => changedTopics.has(id))) errors.push(`Changed ${file} without an update to its mapped Help topics (${topicIds.join(', ')})`)
    for (const id of topicIds) if (!topics.some(topic => topic.id === id)) errors.push(`Coverage for ${file} names missing Help topic ${id}`)
  }
  return errors
}

export function checkHelp({ root = repoRoot, base } = {}) {
  const content = validateContent(root)
  const coverage = parseCoverage(root)
  const errors = [...content.errors, ...coverage.errors, ...checkHelpDocs({ root })]
  if (!coverage.errors.length) errors.push(...validateDrift(root, base, coverage, content.topics))
  if (errors.length) throw new HelpCheckError(errors)
  return { topics: content.topics.length, images: content.images.length, coverage: coverage.entries.length }
}

function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--base') {
      options.base = argv[++index]
      if (!options.base) throw new HelpCheckError(['--base requires a non-empty git ref'])
    }
    else if (argv[index] === '--root') options.root = resolve(argv[++index])
    else if (argv[index] === '--help') options.help = true
    else throw new HelpCheckError([`Unknown option: ${argv[index]}`])
  }
  return options
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    const options = parseArgs(process.argv.slice(2))
    if (options.help) {
      console.log('Usage: node scripts/check-help.mjs [--base <git-ref>] [--root <checkout>]')
    } else {
      const result = checkHelp(options)
      console.log(`Help check passed: ${result.topics} topics, ${result.images} step images, ${result.coverage} coverage mappings.`)
    }
  } catch (error) {
    console.error(`Help check failed: ${error.message}`)
    process.exitCode = 1
  }
}
