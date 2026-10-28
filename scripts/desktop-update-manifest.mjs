import fs from 'node:fs/promises'
import path from 'node:path'

export const UPDATE_MANIFEST_FILE = 'update-manifest.json'

// Called only after the native package has passed the distribution smoke test.
export async function writeDesktopUpdateManifest({ directory, version, commit, platform, packagePath, sha256 }) {
  const targets = { windows: ['win32', 'x64'], macos: ['darwin', 'arm64'] }
  const target = targets[platform]
  if (!target || !/^[0-9a-f]{40}$/u.test(commit) || !/^[0-9a-f]{64}$/u.test(sha256)) {
    throw new Error('Invalid desktop update release metadata')
  }
  const file = path.basename(packagePath)
  const expectedFile = `CanAI-${version}-${platform === 'windows' ? 'windows-x64' : 'macos-arm64'}.zip`
  if (file !== expectedFile || path.resolve(packagePath) !== path.resolve(directory, file)) {
    throw new Error('Desktop update package must belong to this release')
  }
  const stat = await fs.lstat(packagePath)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0) throw new Error('Desktop update package is not a regular nonempty file')
  const manifest = {
    format: 'canai-desktop-update',
    schemaVersion: 1,
    edition: 'local',
    version,
    commit,
    platforms: [{ platform: target[0], arch: target[1], file, sha256, size: stat.size }],
  }
  await fs.writeFile(path.join(directory, UPDATE_MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' })
  return manifest
}

export async function verifyDesktopUpdateManifest(directory, provenance) {
  const file = path.join(directory, UPDATE_MANIFEST_FILE)
  const stat = await fs.lstat(file)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Desktop update manifest is not a regular file')
  const manifest = JSON.parse(await fs.readFile(file, 'utf8'))
  const target = provenance.platform === 'windows' ? ['win32', 'x64'] : provenance.platform === 'macos' ? ['darwin', 'arm64'] : null
  const entry = manifest?.platforms?.[0]
  const packageStat = await fs.lstat(path.join(directory, provenance.package.file))
  if (!target || manifest.format !== 'canai-desktop-update' || manifest.schemaVersion !== 1
    || manifest.edition !== 'local' || manifest.version !== provenance.version || manifest.commit !== provenance.publicCommit
    || manifest.platforms.length !== 1 || entry.platform !== target[0] || entry.arch !== target[1]
    || entry.file !== provenance.package.file || entry.sha256 !== provenance.package.sha256 || entry.size !== packageStat.size) {
    throw new Error('Desktop update manifest does not match the verified release')
  }
}
