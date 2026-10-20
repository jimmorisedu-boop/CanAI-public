import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { logNote } from './log.js'

export class DurableFileMissingError extends Error {
  constructor(
    public readonly file: string,
    public readonly backupFile: string,
  ) {
    super(`${path.basename(file)} and its backup are not present`)
    this.name = 'DurableFileMissingError'
  }
}

export class DurableRecoveryError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'DurableRecoveryError'
  }
}

export interface DurableJsonResult<T> {
  value: T
  recoveredFromBackup: boolean
}

interface DurableJsonOptions<T> {
  file: string
  label: string
  parse(raw: string): T
}

type RecoveryMarkerPhase = 'pending' | 'applied'

interface RecoveryMarker {
  format: 'canai-durable-recovery'
  label: string
  phase: RecoveryMarkerPhase
  createdAt: string
  appliedAt?: string
}

/** A marker survives a crash between backup validation and primary restore. */
export function recoveryMarkerPath(file: string): string {
  return `${file}.recovery-pending`
}

/**
 * Read-only status for the local UI. It intentionally reports only a boolean;
 * marker names and absolute data paths never leave the server process.
 */
export async function hasPendingDurableRecovery(dataDir: string): Promise<boolean> {
  for (const name of ['projects.json', 'jobs.json']) {
    try {
      await fs.access(recoveryMarkerPath(path.join(dataDir, name)))
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return true
    }
  }
  return false
}

function causeText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function readOptional(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function restoreText(file: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.recovery.tmp`
  try {
    await fs.writeFile(temporary, contents, 'utf8')
    await fs.rename(temporary, file)
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {})
  }
}

async function readRecoveryMarker(file: string): Promise<RecoveryMarkerPhase | null> {
  const raw = await readOptional(recoveryMarkerPath(file))
  if (raw === null) return null
  try {
    const parsed = JSON.parse(raw) as Partial<RecoveryMarker>
    return parsed.format === 'canai-durable-recovery' && parsed.phase === 'applied' ? 'applied' : 'pending'
  } catch {
    // Markers written by older builds were plain text. Treat any such marker
    // as pending so a crash cannot make a restored document look reviewed.
    return 'pending'
  }
}

async function writeRecoveryMarker(
  file: string,
  label: string,
  phase: RecoveryMarkerPhase,
): Promise<void> {
  const marker = recoveryMarkerPath(file)
  const contents: RecoveryMarker = {
    format: 'canai-durable-recovery',
    label,
    phase,
    createdAt: new Date().toISOString(),
    ...(phase === 'applied' ? { appliedAt: new Date().toISOString() } : {}),
  }
  try {
    await fs.mkdir(path.dirname(marker), { recursive: true })
    await restoreText(marker, `${JSON.stringify(contents)}\n`)
  } catch (error) {
    throw new DurableRecoveryError(
      `${label} has a valid backup, but its recovery safety marker could not be written: ${causeText(error)}. `
      + 'The primary file was left unchanged.',
      { cause: error },
    )
  }
}

async function ensureRecoveryMarker(file: string, label: string): Promise<void> {
  const current = await readRecoveryMarker(file)
  if (current === 'pending') return
  await writeRecoveryMarker(file, label, 'pending')
}

/**
 * Mark a recovered document safe after its caller has persisted any
 * application-specific quarantine/sanitization. The marker remains present
 * so media GC and the status endpoint continue to require manual review, but
 * later valid reads no longer treat newly-created jobs as backup data.
 */
export async function markRecoveryApplied(file: string, label: string): Promise<void> {
  const current = await readRecoveryMarker(file)
  if (current === null) return
  await writeRecoveryMarker(file, label, 'applied')
}

function recoveryFailure(
  label: string,
  file: string,
  backupFile: string,
  primaryReason: string,
  backupReason: string,
): DurableRecoveryError {
  return new DurableRecoveryError(
    `${label} cannot be recovered: the primary file is ${primaryReason}, and its backup `
    + `${path.basename(backupFile)} is ${backupReason}. Neither file was overwritten; `
    + `repair or restore ${path.basename(file)} before starting CanAI again.`,
  )
}

/**
 * Read a durable JSON document without turning corruption into an empty state.
 * A valid backup is restored atomically. A bad primary is copied aside first so
 * the original remains available for forensic/manual recovery.
 */
export async function readDurableJson<T>(options: DurableJsonOptions<T>): Promise<DurableJsonResult<T>> {
  const { file, label, parse } = options
  const backupFile = `${file}.bak`
  let markerPhase: RecoveryMarkerPhase | null = null
  try {
    markerPhase = await readRecoveryMarker(file)
  } catch (error) {
    throw new DurableRecoveryError(`${label} recovery marker cannot be read: ${causeText(error)}. The file was not changed.`, { cause: error })
  }
  let primary: string | null
  try {
    primary = await readOptional(file)
  } catch (error) {
    throw new DurableRecoveryError(`${label} cannot be read: ${causeText(error)}. The file was not changed.`, { cause: error })
  }

  if (primary !== null) {
    try {
      return { value: parse(primary), recoveredFromBackup: markerPhase === 'pending' }
    } catch (primaryError) {
      let backup: string | null
      try {
        backup = await readOptional(backupFile)
      } catch (backupReadError) {
        throw recoveryFailure(label, file, backupFile, causeText(primaryError), `unreadable (${causeText(backupReadError)})`)
      }
      if (backup === null) {
        throw recoveryFailure(label, file, backupFile, causeText(primaryError), 'missing')
      }
      let value: T
      try {
        value = parse(backup)
      } catch (backupError) {
        throw recoveryFailure(label, file, backupFile, causeText(primaryError), `corrupted (${causeText(backupError)})`)
      }
      const quarantine = `${file}.corrupt-${Date.now().toString(36)}-${randomUUID()}.json`
      try {
        // Write this before touching either source. If the process dies after
        // the rename, the next startup still knows to quarantine ambiguous
        // jobs and keep media GC paused.
        await ensureRecoveryMarker(file, label)
        await fs.copyFile(file, quarantine)
        await restoreText(file, backup)
      } catch (error) {
        throw new DurableRecoveryError(
          `${label} is corrupted and its backup is valid, but recovery could not be completed: ${causeText(error)}. `
          + `The original file was preserved where possible; neither source should be deleted manually.`,
          { cause: error },
        )
      }
      logNote('recovery', `${label} was restored from ${path.basename(backupFile)}; the corrupt primary was preserved as ${path.basename(quarantine)}.`)
      return { value, recoveredFromBackup: true }
    }
  }

  let backup: string | null
  try {
    backup = await readOptional(backupFile)
  } catch (error) {
    throw recoveryFailure(label, file, backupFile, 'missing', `unreadable (${causeText(error)})`)
  }
  if (backup === null) {
    if (markerPhase !== null) {
      throw recoveryFailure(label, file, backupFile, 'missing after an incomplete recovery', 'missing')
    }
    throw new DurableFileMissingError(file, backupFile)
  }

  let value: T
  try {
    value = parse(backup)
  } catch (backupError) {
    throw recoveryFailure(label, file, backupFile, 'missing', `corrupted (${causeText(backupError)})`)
  }
  try {
    // The marker must exist before the restore so a crash cannot turn this
    // recovered backup into an apparently fresh, unreviewed primary.
    await ensureRecoveryMarker(file, label)
    await restoreText(file, backup)
  } catch (error) {
    throw new DurableRecoveryError(
      `${label} is missing and its backup is valid, but the primary could not be restored: ${causeText(error)}. `
      + `The backup was left untouched.`,
      { cause: error },
    )
  }
  logNote('recovery', `${label} was missing; the valid ${path.basename(backupFile)} was restored before startup continued.`)
  return { value, recoveredFromBackup: true }
}
