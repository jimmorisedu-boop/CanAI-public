import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Какая сборка работает у человека (пункт 5.1 списка исправлений).
 *
 * ⚠️ Без этого разбор жалобы начинался с угадывания: у коллеги уже была
 * путаница сборок, а по журналу не видно, обновился ли он вообще. Поэтому
 * первая строка журнала при каждом запуске говорит версию, коммит и дату, а
 * `/api/status` отдаёт то же интерфейсу — он сравнивает со своей сборкой.
 *
 * Источников два, по надёжности:
 * 1. `build-info.json` в корне — его кладёт `make-dist` в поставку, потому что
 *    у покупателя папки `.git` нет;
 * 2. сам git — у разработчиков, которые обновляются через `Update CanAI.bat`.
 * Нет ни того, ни другого — честное «неизвестно», а не выдуманный номер.
 */

export interface BuildInfo {
  version: string
  /** Короткий номер коммита; null — узнать неоткуда. */
  commit: string | null
  /** Дата коммита (ISO); null — узнать неоткуда. */
  date: string | null
  /** В папке есть незакоммиченные правки — сборка «с правками». */
  dirty?: boolean
}

export const BUILD_INFO_FILE = 'build-info.json'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const COMMIT_RE = /^[0-9a-f]{7,40}$/

type GitRunner = (args: string[]) => string

function gitRunner(root: string): GitRunner {
  return (args) => {
    try {
      return execFileSync('git', args, {
        cwd: root,
        encoding: 'utf8',
        timeout: 3000,
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      }).trim()
    } catch {
      return ''
    }
  }
}

function readVersion(root: string): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { version?: unknown }
    return typeof pkg.version === 'string' && pkg.version ? pkg.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

function readBuildFile(root: string): Pick<BuildInfo, 'commit' | 'date'> | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(root, BUILD_INFO_FILE), 'utf8')) as { commit?: unknown; date?: unknown }
    const commit = typeof raw.commit === 'string' && COMMIT_RE.test(raw.commit) ? raw.commit : null
    if (!commit) return null
    const date = typeof raw.date === 'string' && !Number.isNaN(Date.parse(raw.date)) ? raw.date : null
    return { commit, date }
  } catch {
    return null
  }
}

export function readBuildInfo(root: string = ROOT, git: GitRunner = gitRunner(root)): BuildInfo {
  const version = readVersion(root)
  const file = readBuildFile(root)
  if (file) return { version, ...file }
  const commit = git(['rev-parse', '--short=12', 'HEAD'])
  if (!COMMIT_RE.test(commit)) return { version, commit: null, date: null }
  const date = git(['log', '-1', '--format=%cI'])
  // ⚠️ Правки ищем по СОДЕРЖИМОМУ (`diff HEAD`), а не `status`: при
  // core.autocrlf=true файл с LF, лежащий на месте выписанного с CRLF, для
  // `status` навсегда «изменён», хотя побайтно совпадает с коммитом. Так
  // `make-dist` заново пишет лицензии и в свежей копии КАЖДЫЙ раз кричал о
  // несохранённых правках — а к тревоге, которая звучит всегда, перестают
  // прислушиваться. Правки в индексе `diff HEAD` видит так же.
  const dirty = git(['diff', '--name-only', 'HEAD']) !== ''
  return {
    version,
    commit,
    date: date && !Number.isNaN(Date.parse(date)) ? date : null,
    ...(dirty ? { dirty: true } : {}),
  }
}

let cached: BuildInfo | null = null

/** Сведения считаются один раз за жизнь процесса: git зовём только при старте. */
export function buildInfo(): BuildInfo {
  cached ??= readBuildInfo()
  return cached
}

function day(iso: string | null): string {
  if (!iso) return ''
  const date = new Date(iso)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()}`
}

/** «CanAI 0.1.0 · сборка 9e84a03e519d от 26.09.2026» — одна строка для журнала. */
export function formatBuildLine(info: BuildInfo): string {
  if (!info.commit) return `CanAI ${info.version} · build unknown`
  const when = day(info.date)
  return `CanAI ${info.version} · build ${info.commit}${when ? ` from ${when}` : ''}${info.dirty ? ' (with uncommitted changes)' : ''}`
}
