#!/usr/bin/env node

/*
 * Range-preserving i18n codemod for the React-owned UI.
 *
 * It deliberately works from the TypeScript AST instead of replacing arbitrary
 * strings. Only JSX text/attributes and string branches of JSX conditionals
 * are considered, and only when the English source key is present in the
 * checked Russian catalogue. Dynamic template expressions become positional
 * parameters, so board names, prompts and model names keep their value.
 *
 * The default mode is a dry run. Pass --write after reviewing the report.
 */

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import ts from '../client/node_modules/typescript/lib/typescript.js'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CATALOG_FILE = path.join(REPO_ROOT, 'client', 'src', 'i18n', 'ru.ts')
const DEFAULT_ROOTS = [
  'client/src/settings',
  'client/src/projects',
  'client/src/ui',
  'client/src/help',
  'client/src/App.tsx',
]
const TARGET_ATTRIBUTES = new Set([
  'alt',
  'aria-description',
  'aria-label',
  'data-label',
  'detail',
  'hint',
  'label',
  'placeholder',
  'summary',
  'title',
])

function usage() {
  return [
    'Usage: node scripts/i18n-codemod.mjs [--write] [--root <path>]...',
    '       node scripts/i18n-codemod.mjs --help',
    '',
    'Without --write the command reports range edits and writes nothing.',
  ].join('\n')
}

function parseArgs(argv) {
  const roots = []
  let write = false
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--write') write = true
    else if (value === '--root') roots.push(argv[++index] ?? '')
    else if (value === '--help' || value === '-h') return { help: true, roots, write }
    else throw new Error(`Unknown argument: ${value}`)
  }
  return { help: false, roots: roots.length ? roots : DEFAULT_ROOTS, write }
}

function readCatalogueKeys() {
  const source = fs.readFileSync(CATALOG_FILE, 'utf8')
  const keys = new Set()
  // The catalogue is generated with JSON-compatible quoted keys. Keep this
  // parser intentionally narrow: it is an allowlist, never an evaluator.
  const pattern = /^\s*"((?:\\.|[^"\\])*)"\s*:/gmu
  for (const match of source.matchAll(pattern)) {
    try { keys.add(JSON.parse(`"${match[1]}"`)) } catch { /* skip malformed line */ }
  }
  return keys
}

function sourceFiles(root) {
  const absolute = path.resolve(REPO_ROOT, root)
  if (!fs.existsSync(absolute)) return []
  const stat = fs.statSync(absolute)
  if (stat.isFile()) return /\.tsx?$/u.test(absolute) && !/\.test\.tsx?$/u.test(absolute) ? [absolute] : []
  const result = []
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const child = path.join(directory, entry.name)
      if (entry.isDirectory()) visit(child)
      else if (/\.tsx?$/u.test(entry.name) && !/\.test\.tsx?$/u.test(entry.name)) result.push(child)
    }
  }
  visit(absolute)
  return result
}

function quote(value) {
  return `'${String(value)
    .replaceAll('\\', '\\\\')
    .replaceAll("'", "\\'")
    .replaceAll('\r', '\\r')
    .replaceAll('\n', '\\n')}'`
}

function normaliseJsxText(value) {
  return value.trim().replace(/[ \t\r\n]+/gu, ' ')
}

function assignedComponentName(fn) {
  // A named function expression carries its component name itself, including
  // `memo(function Card() { ... })`.
  if ((ts.isFunctionExpression(fn) || ts.isArrowFunction(fn)) && fn.name && /^[A-Z]/u.test(fn.name.text)) {
    return fn.name.text
  }
  // `const Card = memo((props) => ...)` and forwardRef have a call wrapper
  // between the function and its variable declaration. Walk only transparent
  // expression wrappers so a nested callback cannot inherit an outer name.
  let parent = fn.parent
  while (parent && (
    ts.isCallExpression(parent)
    || ts.isParenthesizedExpression(parent)
    || ts.isAsExpression(parent)
    || ts.isTypeAssertionExpression(parent)
    || ts.isNonNullExpression(parent)
  )) parent = parent.parent
  if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text
  if (parent && ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) return parent.name.text
  return null
}

function componentFunctionFor(node) {
  let current = node.parent
  while (current) {
    if (ts.isFunctionDeclaration(current)) {
      const name = current.name?.text
      if (name && /^[A-Z]/u.test(name)) return current
    }
    if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
      if (current.name?.text && /^[A-Z]/u.test(current.name.text)) return current
      const name = assignedComponentName(current)
      if (name && /^[A-Z]/u.test(name)) return current
    }
    current = current.parent
  }
  return null
}

function componentHookInfo(component, sourceFile) {
  const source = sourceFile.text
  const body = component.body
  if (!body) return null
  const bodyText = body.getText(sourceFile)
  const existing = bodyText.match(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*useT\s*\(\s*\)/u)
  if (existing) return { alias: existing[1], hook: null }
  const alias = /\b(?:const|let|var|function)\s+t\b/u.test(bodyText) ? 'translate' : 't'

  if (ts.isBlock(body)) {
    const open = body.getStart(sourceFile) + 1
    const newline = source.slice(open).match(/^\r?\n/u)?.[0]
    if (newline) {
      const firstLine = open + newline.length
      const indent = source.slice(firstLine).match(/^[ \t]*/u)?.[0] ?? '  '
      return { alias, hook: { start: firstLine, end: firstLine, text: `${indent}const ${alias} = useT()${newline}` } }
    }
    const lineStart = source.lastIndexOf('\n', body.getStart(sourceFile)) + 1
    const outerIndent = source.slice(lineStart, body.getStart(sourceFile)).match(/^[ \t]*/u)?.[0] ?? ''
    const indent = `${outerIndent}  `
    return { alias, hook: { start: body.end - 1, end: body.end - 1, text: `\n${indent}const ${alias} = useT()\n${outerIndent}` } }
  }

  // Arrow components often use an expression body. Wrap that expression in a
  // block so the hook stays inside the component and its state is preserved.
  const lineStart = source.lastIndexOf('\n', component.getStart(sourceFile)) + 1
  const outerIndent = source.slice(lineStart, component.getStart(sourceFile)).match(/^[ \t]*/u)?.[0] ?? ''
  const indent = `${outerIndent}  `
  return {
    alias,
    hook: [
      { start: body.getStart(sourceFile), end: body.getStart(sourceFile), text: `{\n${indent}const ${alias} = useT()\n${indent}return ` },
      { start: body.end, end: body.end, text: `\n${outerIndent}}` },
    ],
  }
}

function templateParts(expression, sourceFile) {
  if (ts.isNoSubstitutionTemplateLiteral(expression)) return { key: expression.text, params: [] }
  if (!ts.isTemplateExpression(expression)) return null
  let key = expression.head.text
  const params = []
  expression.templateSpans.forEach((span, index) => {
    key += `{${index}}${span.literal.text}`
    params.push(span.expression.getText(sourceFile))
  })
  return { key, params }
}

function attributeTranslation(node, sourceFile, keys) {
  const source = sourceFile.text
  const name = node.name.text
  if (!TARGET_ATTRIBUTES.has(name)) return null
  const initializer = node.initializer
  if (!initializer) return null
  if (ts.isStringLiteral(initializer)) {
    return keys.has(initializer.text) ? { key: initializer.text, params: [], start: initializer.getStart(sourceFile), end: initializer.end } : null
  }
  if (!ts.isJsxExpression(initializer) || !initializer.expression) return null
  const expression = initializer.expression
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    const key = expression.text
    return keys.has(key) ? { key, params: [], start: initializer.getStart(sourceFile), end: initializer.end } : null
  }
  const template = templateParts(expression, sourceFile)
  if (template && keys.has(template.key)) {
    return { key: template.key, params: template.params, start: initializer.getStart(sourceFile), end: initializer.end }
  }
  return null
}

function replacementFor(alias, key, params) {
  const args = params.length
    ? `, { ${params.map((value, index) => `${index}: ${value}`).join(', ')} }`
    : ''
  return `${alias}(${quote(key)}${args})`
}

function transformSource(source, fileName, keys) {
  const scriptKind = /\.tsx$/u.test(fileName) ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKind)
  if (!/\.tsx$/u.test(fileName)) return { source, edits: [], changed: false, files: 0 }

  const specs = []
  const reactiveComponents = new Set()
  const seen = new Set()
  const addSpec = (node, key, params = [], range = null, kind = 'expression') => {
    const component = componentFunctionFor(node)
    if (!component || !keys.has(key)) return
    const start = range?.start ?? node.getStart(sourceFile)
    const end = range?.end ?? node.end
    const id = `${start}:${end}`
    if (seen.has(id)) return
    seen.add(id)
    specs.push({ start, end, key, params, component, kind })
  }

  const addAttribute = (node) => {
    const translation = attributeTranslation(node, sourceFile, keys)
    if (translation) {
      addSpec(
        node,
        translation.key,
        translation.params,
        { start: translation.start, end: translation.end },
        'attribute',
      )
    }
  }

  const addConditionalBranches = (node) => {
    // A nested ternary inside a template interpolation belongs to the
    // template's positional parameter. Rewriting both ranges would overlap
    // and leave malformed JSX, so only handle the outer JSX conditional.
    let ancestor = node.parent
    while (ancestor && !ts.isJsxExpression(ancestor)) {
      if (ts.isConditionalExpression(ancestor)) return
      if (
        ts.isCallExpression(ancestor)
        && ts.isIdentifier(ancestor.expression)
        && (ancestor.expression.text === 't' || ancestor.expression.text === 'translate')
      ) return
      ancestor = ancestor.parent
    }
    if (!ancestor) return
    // Only translate a ternary that is the JSX expression itself. Ternaries
    // nested in object/index expressions are runtime data (for example an
    // icon lookup) and must never become UI translations.
    if (ancestor.expression !== node) return
    const owner = ancestor.parent
    if (ts.isJsxAttribute(owner) && !TARGET_ATTRIBUTES.has(owner.name.text)) return
    const addBranch = (branch) => {
      if (ts.isStringLiteral(branch) || ts.isNoSubstitutionTemplateLiteral(branch)) {
        addSpec(branch, branch.text, [], null, 'conditional')
        return
      }
      const template = templateParts(branch, sourceFile)
      if (template) addSpec(branch, template.key, template.params, null, 'conditional')
    }
    addBranch(node.whenTrue)
    addBranch(node.whenFalse)
  }

  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 't') {
      const first = node.arguments[0]
      const translation = first && (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first))
        ? { key: first.text }
        : first ? templateParts(first, sourceFile) : null
      const component = translation && keys.has(translation.key) ? componentFunctionFor(node) : null
      if (component) reactiveComponents.add(component)
    }
    if (ts.isJsxText(node)) {
      const key = normaliseJsxText(node.text)
      if (key && keys.has(key)) {
        const leading = node.text.match(/^\s*/u)?.[0] ?? ''
        const trailing = node.text.match(/\s*$/u)?.[0] ?? ''
        addSpec(node, key, [], null, 'jsxText')
        const spec = specs.at(-1)
        if (spec && spec.start === node.getStart(sourceFile) && spec.end === node.end) {
          spec.leading = leading
          spec.trailing = trailing
        }
      }
    } else if (ts.isJsxAttribute(node)) {
      addAttribute(node)
    } else if (ts.isConditionalExpression(node)) {
      let parent = node.parent
      while (parent && !ts.isJsxExpression(parent)) parent = parent.parent
      if (parent) addConditionalBranches(node)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  for (const spec of specs) reactiveComponents.add(spec.component)
  if (!reactiveComponents.size) return { source, edits: [], changed: false, files: 0 }

  const componentInfo = new Map()
  for (const component of reactiveComponents) {
    if (!componentInfo.has(component)) componentInfo.set(component, componentHookInfo(component, sourceFile))
  }
  const edits = []
  for (const spec of specs) {
    const info = componentInfo.get(spec.component)
    if (!info) continue
    const replacement = replacementFor(info.alias, spec.key, spec.params)
    edits.push({
      start: spec.start,
      end: spec.end,
      text: spec.kind === 'jsxText'
        ? `${spec.leading}{${replacement}}${spec.trailing}`
        : spec.kind === 'attribute'
          ? `{${replacement}}`
          : replacement,
    })
  }
  for (const info of componentInfo.values()) {
    if (info?.hook) edits.push(...(Array.isArray(info.hook) ? info.hook : [info.hook]))
  }

  // Local-edition overrides mirror `client/src`. Resolve imports from that
  // logical tree so a file under `local-edition/overrides/client/src/**`
  // receives the same relative import as its source counterpart.
  const relativeFile = path.relative(REPO_ROOT, fileName).replaceAll(path.sep, '/')
  const segments = relativeFile.split('/')
  const clientIndex = segments.findLastIndex((segment, index) => segment === 'client' && segments[index + 1] === 'src')
  const logicalFile = clientIndex >= 0 ? segments.slice(clientIndex + 2).join('/') : relativeFile
  const importPath = path.posix.relative(
    path.posix.dirname(logicalFile),
    'i18n/context.js',
  )
  const modulePath = importPath.startsWith('.') ? importPath : `./${importPath}`
  const hasUseTImport = sourceFile.statements.some((statement) => (
    ts.isImportDeclaration(statement)
    && ts.isStringLiteral(statement.moduleSpecifier)
    && statement.moduleSpecifier.text === modulePath
    && statement.importClause?.namedBindings
    && ts.isNamedImports(statement.importClause.namedBindings)
    && statement.importClause.namedBindings.elements.some((element) => element.name.text === 'useT')
  ))
  if (!hasUseTImport) {
    const imports = sourceFile.statements.filter((statement) => ts.isImportDeclaration(statement))
    const end = imports.at(-1)?.end ?? 0
    const newline = source.includes('\r\n') ? '\r\n' : '\n'
    edits.push({ start: end, end, text: `${newline}import { useT } from ${quote(modulePath)}${newline}` })
  }

  edits.sort((a, b) => b.start - a.start || b.end - a.end)
  let output = source
  for (const edit of edits) output = `${output.slice(0, edit.start)}${edit.text}${output.slice(edit.end)}`
  return { source: output, edits, changed: output !== source, files: componentInfo.size }
}

export { readCatalogueKeys, transformSource }

export function runCodemod({ roots = DEFAULT_ROOTS, write = false } = {}) {
  const keys = readCatalogueKeys()
  const files = [...new Set(roots.flatMap(sourceFiles))].sort()
  const report = []
  for (const fileName of files) {
    const source = fs.readFileSync(fileName, 'utf8')
    const result = transformSource(source, fileName, keys)
    if (!result.changed) continue
    const entry = {
      file: path.relative(REPO_ROOT, fileName).replaceAll(path.sep, '/'),
      edits: result.edits.length,
      components: result.files,
    }
    if (write) {
      try {
        fs.writeFileSync(fileName, result.source)
      } catch (error) {
        report.push({
          ...entry,
          error: error instanceof Error ? error.message : String(error),
        })
        continue
      }
    }
    report.push(entry)
  }
  return { keys: keys.size, files: report }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2))
    if (options.help) {
      console.log(usage())
    } else {
      const report = runCodemod(options)
      const failures = report.files.filter((entry) => entry.error)
      console.log(`${options.write ? 'Updated' : 'Would update'} ${report.files.length - failures.length} file(s) using ${report.keys} catalogue keys.`)
      for (const entry of report.files) {
        if (entry.error) console.error(`${entry.file}: write failed: ${entry.error}`)
        else console.log(`${entry.file}: ${entry.edits} range edits, ${entry.components} component(s)`)
      }
      if (failures.length) process.exitCode = 1
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
