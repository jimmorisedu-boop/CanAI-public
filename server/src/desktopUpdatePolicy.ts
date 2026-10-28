import type {
  DesktopUpdateArch,
  DesktopUpdateEdition,
  DesktopUpdatePlatform,
} from '../../packages/desktop-updates/protocol.js'

export interface DesktopUpdateGitSource {
  kind: 'git'
  owner: 'jimmorisedu-boop'
  repository: 'CanAI'
  branch: 'main'
}

export interface DesktopUpdateReleaseSource {
  kind: 'release'
  owner: 'jimmorisedu-boop'
  repository: 'CanAI-public'
  manifestAsset: 'update-manifest.json'
}

export interface DesktopUpdatePolicy {
  edition: DesktopUpdateEdition
  source: DesktopUpdateGitSource | DesktopUpdateReleaseSource
  managedPaths: readonly string[]
  protectedPaths: readonly string[]
  launcher: {
    windows: 'start.ps1'
    macos: 'start.command'
  }
  supportedPlatforms: readonly DesktopUpdatePlatform[]
  supportedArchitectures: readonly DesktopUpdateArch[]
}

/** Public local edition: update only from a verified CanAI-public Release ZIP. */
export const desktopUpdatePolicy: DesktopUpdatePolicy = {
  edition: 'local',
  source: {
    kind: 'release',
    owner: 'jimmorisedu-boop',
    repository: 'CanAI-public',
    manifestAsset: 'update-manifest.json',
  },
  managedPaths: [
    'client',
    'packages',
    'scripts',
    'server',
    'start.ps1',
    'start.command',
    'stop.ps1',
    'stop.command',
    'Start CanAI.bat',
    'Stop CanAI.bat',
    'Start CanAI.command',
    'Stop CanAI.command',
    'package.json',
    'package-lock.json',
    'build-info.json',
  ],
  protectedPaths: [
    '.env',
    '.git',
    'server/.env',
    'server/data',
    'runtime',
    'node_modules',
    'client/node_modules',
    'server/node_modules',
    'artifacts',
    'dist-package',
    'releases-archive',
    '.worktrees',
  ],
  launcher: {
    windows: 'start.ps1',
    macos: 'start.command',
  },
  supportedPlatforms: ['win32', 'darwin'],
  supportedArchitectures: ['x64', 'arm64'],
}
