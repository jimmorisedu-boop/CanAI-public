// @ts-expect-error Клиентские тесты запускаются через tsx с Node-типами.
import assert from 'node:assert/strict'
// @ts-expect-error Production-клиент не зависит от Node-типов.
import test from 'node:test'
// @ts-expect-error Node-типы не подключены к production-клиенту.
import { readdirSync, readFileSync } from 'node:fs'
// @ts-expect-error Node-типы не подключены к production-клиенту.
import path from 'node:path'
// @ts-expect-error Production-клиент не зависит от Node-типов.
import { fileURLToPath } from 'node:url'

// Списки тестов в package.json — РУЧНЫЕ. Файл, который забыли туда вписать,
// не падает и не ругается: он просто молча не запускается, и написанная защита
// не защищает ничего. Так уже случилось с assistantCascade и pasteArbiter —
// восемь тестов пролежали мёртвыми. Этот сторож ловит следующий такой случай.
//
// Файл считается живым, если он либо перечислен в скрипте, либо импортируется
// из перечисленного (в проекте есть такой приём — один тест подтягивает
// соседний ради общих проверок).

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

function readScripts(pkg: string): string {
  const json = JSON.parse(readFileSync(path.join(repoRoot, pkg, 'package.json'), 'utf8'))
  const scripts = json.scripts ?? {}
  // Windows limits a command to 8191 characters, so larger suites delegate
  // to short npm scripts. Count only scripts reachable from npm test.
  const seen = new Set<string>()
  function expand(name: string): string {
    if (seen.has(name)) return ''
    seen.add(name)
    const command = String(scripts[name] ?? '')
    const children = [...command.matchAll(/npm run ([A-Za-z0-9:_-]+)/g)].map(match => expand(match[1]))
    return [command, ...children].join(' ')
  }
  return ['pretest','test','posttest'].map(expand).join(' ')
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', '.git', '.codegraph'].includes(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, acc)
    else if (/\.test\.(ts|tsx|mjs)$/.test(entry.name)) acc.push(full)
  }
  return acc
}

test('каждый тестовый файл действительно запускается', () => {
  const listed = [readScripts('server'), readScripts('client'), readScripts('.')].join(' ')

  const files = [
    ...walk(path.join(repoRoot, 'server', 'src')),
    ...walk(path.join(repoRoot, 'client', 'src')),
  ]
  assert.ok(files.length > 50, 'сторож не нашёл тесты — проверь путь к корню репозитория')

  // что перечислено напрямую
  const isListed = (file: string): boolean => {
    const rel = path.relative(repoRoot, file).split(path.sep).join('/')
    return listed.includes(rel) || listed.includes(rel.replace(/^(server|client)\//, ''))
  }
  const direct = files.filter(isListed)

  // что подтягивается импортом из перечисленного
  const importedNames = new Set<string>()
  for (const file of direct) {
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(/from\s+'([^']*\.test[^']*)'/g)) {
      importedNames.add(path.basename(match[1]).replace(/\.(js|ts|tsx)$/, ''))
    }
    for (const match of source.matchAll(/import\s+'([^']*\.test[^']*)'/g)) {
      importedNames.add(path.basename(match[1]).replace(/\.(js|ts|tsx)$/, ''))
    }
  }

  const dead = files.filter((file) => {
    if (isListed(file)) return false
    const base = path.basename(file).replace(/\.(ts|tsx|mjs)$/, '')
    return !importedNames.has(base)
  })

  assert.deepEqual(
    dead.map((file) => path.relative(repoRoot, file).split(path.sep).join('/')),
    [],
    'эти тесты не запускаются ни одной командой — впиши их в scripts.test своего пакета',
  )
})

// Литеральный нулевой байт в исходнике уже дважды ломал работу: grep считает
// такой файл двоичным, точечные правки перестают находить строки, а diff
// показывает «Binary files differ» вместо изменений. В коде он не нужен
// никогда — если нужен сам символ, пишется экранированная последовательность.
test('в исходниках нет литерального нулевого байта', () => {
  const dirty: string[] = []
  const scan = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        scan(full)
        continue
      }
      if (!/\.tsx?$/.test(entry.name)) continue
      if (readFileSync(full).indexOf(0) >= 0) {
        dirty.push(path.relative(repoRoot, full).split(path.sep).join('/'))
      }
    }
  }
  scan(path.join(repoRoot, 'client', 'src'))
  scan(path.join(repoRoot, 'server', 'src'))
  assert.deepEqual(dirty, [], `нулевой байт в исходнике: ${dirty.join(', ')}`)
})
