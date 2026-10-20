import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { exportPublicSource } from './export-public-source.mjs'
import { scanSecrets } from './scan-secrets.mjs'
import { makeProjectTemp, removeProjectTemp } from './project-workspace.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function valueAfter(args, name) {
  const index = args.indexOf(name)
  return index < 0 ? undefined : args[index + 1]
}

function usage() {
  return [
    'Usage:',
    '  node scripts/public-release.mjs export [--output <new-or-empty-dir>] [--root <repo>]',
    '  node scripts/public-release.mjs scan --source <dir> [--mode dir|git] [--gitleaks <binary>]',
    '  node scripts/public-release.mjs check [--output <new-or-empty-dir>] [--root <repo>] [--gitleaks <binary>]',
    '',
    'Default export: artifacts/public-source/<revision>; temporary checks: artifacts/.tmp/',
  ].join('\n')
}

async function main(argv) {
  const command = argv[0]
  if (!command || command === '--help' || command === '-h') {
    console.log(usage())
    return
  }
  if (command === 'export') {
    const result = await exportPublicSource({ root: valueAfter(argv, '--root') ?? ROOT, output: valueAfter(argv, '--output') ?? valueAfter(argv, '--out') })
    console.log(`Exported ${result.files.length} files at ${result.sourceRevision} to ${result.output}`)
    return
  }
  if (command === 'scan') {
    const result = await scanSecrets({
      source: valueAfter(argv, '--source'),
      mode: valueAfter(argv, '--mode') ?? 'dir',
      gitleaks: valueAfter(argv, '--gitleaks'),
      requireGitleaks: argv.includes('--require-gitleaks'),
    })
    if (result.findings.length) throw new Error(`secret scan found ${result.findings.length} finding(s)`)
    console.log(`[public-release] clean (${result.filesScanned} files)`)
    return
  }
  if (command === 'check') {
    const requestedOutput = valueAfter(argv, '--output') ?? valueAfter(argv, '--out')
    const root = path.resolve(valueAfter(argv, '--root') ?? ROOT)
    const temporary = requestedOutput ? null : await makeProjectTemp(root, 'canai-public-release-')
    try {
      const exported = await exportPublicSource({
        root,
        output: requestedOutput ?? path.join(temporary, 'source'),
      })
      const result = await scanSecrets({
        source: exported.output,
        mode: 'dir',
        gitleaks: valueAfter(argv, '--gitleaks'),
        requireGitleaks: true,
      })
      if (result.findings.length) throw new Error(`secret scan found ${result.findings.length} finding(s)`)
      console.log(`[public-release] export and scan passed (${exported.files.length} files)`)
      return
    } finally {
      if (temporary) await removeProjectTemp(root, temporary, 'canai-public-release-')
    }
  }
  throw new Error(`Unknown public-release command: ${command}\n${usage()}`)
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    await main(process.argv.slice(2))
  } catch (error) {
    console.error(`[public-release] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}

export { main as runPublicRelease }
