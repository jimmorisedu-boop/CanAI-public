import { isLocalClientSourcePath, transformLocalClientSource } from './local-edition-client.mjs'
import { isLocalServerSourcePath, transformLocalServerSource } from './local-edition-server.mjs'

export const LOCAL_EDITION = 'local'
export const LOCAL_OVERRIDE_ROOT = 'local-edition/overrides/'

export function isLocalEditionSourcePath(sourcePath) {
  const name = String(sourcePath).replaceAll('\\', '/')
  if (name.startsWith('/') || /^[a-z]:/iu.test(name) || name.split('/').some(part => !part || part === '.' || part === '..')) return false
  if (/^(?:client|server)\/src\/(?:.*\/)?(?:cloud|collaboration|shares|teams?)(?:\/|$)/iu.test(name)) return false
  if (/^packages\/(?:.*\/)?cloud(?:\/|$)/iu.test(name)) return false
  if (/^scripts\/(?:network-|hybrid-cloud-|package-cloud-tablet(?:\.|-))/u.test(name)) return false
  if (name === 'scripts/assistant-rules-sync.mjs' || /^packages\/.*\/cloud[^/]*\.[^/]+$/iu.test(name)) return false
  return isLocalClientSourcePath(name) && isLocalServerSourcePath(name)
}

// Both path policy and selection operate on the destination. Overrides are
// committed blobs, never an instruction to read arbitrary working-tree files.
export function localOverridePath(sourcePath) {
  if (!sourcePath.startsWith(LOCAL_OVERRIDE_ROOT)) return null
  const destination = sourcePath.slice(LOCAL_OVERRIDE_ROOT.length)
  if (!/^(?:client|server)\//u.test(destination) || !isLocalEditionSourcePath(destination)) {
    throw new Error(`Invalid local edition override: ${sourcePath}`)
  }
  return destination
}

export function transformLocalPackage(text) {
  const pkg = JSON.parse(text)
  if (!pkg.scripts) return text
  for (const name of Object.keys(pkg.scripts)) {
    // The desktop local snapshot intentionally excludes the separate web-demo
    // tree. Drop its scripts and any standalone gates that would otherwise
    // point at files absent from the exported source.
    if (/^(?:demo:[A-Za-z0-9:_-]+|build:tablet:cloud|test:network(?::.*)?|test:e2e)$/u.test(name)) {
      delete pkg.scripts[name]
      continue
    }
    pkg.scripts[name] = pkg.scripts[name].split(/\s*&&\s*/u).map(command => {
      if (/^npm\s+run\s+demo:[A-Za-z0-9:_-]+$/u.test(command.trim())) return ''
      let removed = false
      const filtered = command.replace(/(?:client|server|scripts)\/[\w./-]+\.(?:[cm]?[jt]sx?)/gu, filename => {
        if (isLocalEditionSourcePath(filename)) return filename
        removed = true
        return ''
      }).replace(/ {2,}/gu, ' ').trim()
      if (removed && /--test(?:\s|$)/u.test(filtered) && !/\.(?:[cm]?[jt]sx?)(?:\s|$)/u.test(filtered)) return ''
      return filtered
    }).filter(Boolean).join(' && ')
    if (!pkg.scripts[name]) delete pkg.scripts[name]
  }
  return `${JSON.stringify(pkg, null, 2)}\n`
}

export function transformLocalEditionSource(sourcePath, data) {
  if (!/\.(?:[cm]?[jt]sx?|json|css|html|md|svg|txt)$/u.test(sourcePath)) return data
  let text = data.toString('utf8')
  if (sourcePath === 'package.json') text = transformLocalPackage(text)
  text = transformLocalClientSource(sourcePath, text)
  text = transformLocalServerSource(sourcePath, text)
  return Buffer.from(text)
}

export function assertLocalEditionRuntime(sourcePath, data) {
  if (!/^(?:(?:client|server)\/src|packages)\/.*\.[cm]?[jt]sx?$/u.test(sourcePath) || /\.(?:test|spec)\./u.test(sourcePath)) return
  const source = data.toString('utf8')
  // This is an export gate, in addition to type checks. It catches a new
  // account or shared-board endpoint in an otherwise locally named module.
  const match = source.match(/\/api\/cloud(?:[\w/-]*)(?=[\s/'"`?}]|$)|\/v3\/(?:boards|auth)(?:[\w/-]*)(?=[\s/'"`?}]|$)/u)
  if (match) throw new Error(`Cloud endpoint in local edition ${sourcePath}: ${match[0]}`)
}
