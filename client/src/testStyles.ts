import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = path.dirname(fileURLToPath(import.meta.url))

// Весь лист стилей одной строкой — для тестов, которые сверяют правила.
//
// Раньше они читали styles.css напрямую. После разбиения на разделы там
// остались только @import, и такая проверка молча ослабла бы: assert.match
// начал бы падать, а assert.doesNotMatch — проходить всегда, что хуже.
//
// Файлы склеиваются В ПОРЯДКЕ ИМПОРТОВ, а не по алфавиту: порядок и есть
// каскад. Заодно это сторож самого списка — забыть дописать туда новый файл
// не выйдет, его правила просто не попадут в проверки.
export function readAllStyles(): string {
  const index = readFileSync(path.join(SRC, 'styles.css'), 'utf8')
  const parts = [...index.matchAll(/@import\s+'\.\/([^']+)'/g)].map((match) => match[1])
  if (parts.length === 0) throw new Error('No @import rules found in styles.css')
  return parts.map((rel) => readFileSync(path.join(SRC, rel), 'utf8')).join('\n')
}
