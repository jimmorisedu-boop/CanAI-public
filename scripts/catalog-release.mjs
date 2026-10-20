import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
const root = new URL('../packages/model-catalog/', import.meta.url)
const names = ['catalog.ts', 'imageCapacity.ts', 'imageParams.ts', 'gptImagePricing.ts', 'mediaCost.ts', 'canonBridge.ts', 'macroModels.ts', 'parameterRules.ts', 'version.ts', 'package.json']
const files = {}
// ⚠️ Хеш — по тексту с переводами строк LF, как он лежит в git: на Windows
// git выдаёт файлы с CRLF, и сырые байты давали бы разные хеши на разных
// машинах одного и того же выпуска.
const text = async (name) => (await readFile(new URL(name, root), 'utf8')).replace(/\r\n/g, '\n')
for (const name of names) files[name] = createHash('sha256').update(await text(name)).digest('hex')
const manifest = { schemaVersion: 1, revision: '2026-10-20.4', files }
const target = new URL('release.json', root)
if (process.argv.includes('--check')) {
  const saved = JSON.parse(await readFile(target, 'utf8'))
  if (JSON.stringify(saved) !== JSON.stringify(manifest)) throw new Error('Catalog release changed without updating the manifest')
  console.log(`Catalog ${saved.revision}: files match the pinned release`)
} else {
  await writeFile(target, JSON.stringify(manifest, null, 2) + '\n')
  console.log(fileURLToPath(target))
}
