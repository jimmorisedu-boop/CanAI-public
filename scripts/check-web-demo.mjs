import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const site = path.join(root, 'artifacts', 'web-demo', 'site')

async function filesUnder(directory, prefix = '') {
  const entries = await fs.readdir(directory, { withFileTypes: true })
  const groups = await Promise.all(entries.map(async (entry) => {
    const relative = prefix + entry.name
    assert(!entry.isSymbolicLink(), `Unexpected symbolic link: ${relative}`)
    return entry.isDirectory()
      ? filesUnder(path.join(directory, entry.name), `${relative}/`)
      : [relative]
  }))
  return groups.flat().sort()
}

export async function checkWebDemo() {
  const files = await filesUnder(site)
  const required = ['index.html', 'demo-worker.js', 'favicon.svg',
    'fonts/onest-latin.woff2', 'fonts/onest-cyrillic.woff2',
    'help/demo-overview.svg', 'samples/cat-director.webp',
    'samples/capybara-space.webp', 'samples/raccoon-chef.webp',
    'samples/moon-break.mp4', 'samples/creative-review.mp4',
    'samples/tiny-victory.wav', 'samples/SOURCES.md']
  for (const file of required) assert(files.includes(file), `Missing demo asset: ${file}`)
  for (const file of files) {
    assert(!/(?:^|\/)(?:\.env(?:\.|$)|data|node_modules|\.git|server)(?:\/|$)/u.test(file), `Private file in demo: ${file}`)
    assert(!file.endsWith('.map'), `Source maps must not ship: ${file}`)
    assert(!file.includes('cloud-boundary'), `Cloud help in local demo: ${file}`)
  }
  const manifest = []
  for (const file of files) {
    const data = await fs.readFile(path.join(site, file))
    if (file.startsWith('assets/') && file.endsWith('.js')) {
      const text = data.toString('utf8')
      assert(!/\/api\/cloud(?:[-/]|\b)|\/v3\/(?:auth|boards)(?:\/|\b)/u.test(text), `Cloud API implementation bundled: ${file}`)
    }
    manifest.push({ file, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') })
  }
  const report = { files: manifest.length, bytes: manifest.reduce((sum, entry) => sum + entry.bytes, 0), manifest }
  await fs.writeFile(path.join(site, '..', 'build-report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(`Demo artifact passed: ${report.files} files, ${(report.bytes / 1024 / 1024).toFixed(1)} MiB; isolated local UI and bundled samples.`)
  return report
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await checkWebDemo()
}
