/**
 * Wire contract shared by the desktop updater service and Settings UI.
 *
 * Keep this module dependency-free: the public local edition overlays the
 * updater policy, while both desktop editions consume the same response
 * shape.  The server returns a `DesktopUpdateStatus` object directly for all
 * successful GET/check/prepare/apply responses.
 */

export type DesktopUpdatePhase =
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'preparing'
  | 'ready'
  | 'restarting'
  | 'complete'
  | 'error'
  | 'unsupported'

export type DesktopUpdateEdition = 'full' | 'local'

export type DesktopUpdatePlatform = 'win32' | 'darwin'
export type DesktopUpdateArch = 'x64' | 'arm64'

export interface DesktopUpdateCurrent {
  version: string
  commit: string | null
  date: string | null
}

export interface DesktopUpdateRelease {
  version: string
  commit: string | null
  date: string | null
  notes: string[]
  /** A server-validated commit, release tag, or manifest target. */
  target: string
}

export interface DesktopUpdateProgress {
  stage: string
  percent?: number
  detail?: string
}

export interface DesktopUpdateStatus {
  phase: DesktopUpdatePhase
  edition: DesktopUpdateEdition
  current: DesktopUpdateCurrent
  latest?: DesktopUpdateRelease
  jobId?: string
  progress?: DesktopUpdateProgress
  /** Actual main port after a launcher fallback selected another free pair. */
  port?: number
  /** Loopback URL to reopen when the fallback port changed during restart. */
  restartUrl?: string
  message?: string
  code?: string
}

export interface DesktopUpdatePrepareRequest {
  target: string
}

export interface DesktopUpdateApplyRequest {
  jobId: string
}
