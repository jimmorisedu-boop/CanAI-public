import fs from 'node:fs/promises'
import path from 'node:path'
import { config } from './config.js'

// Черновик сеанса — то, из чего складывается ощущение «продолжил с того же
// места». Доска, камера и заглушки генераций и так переезжают между
// устройствами (они в project.json), а вот набранный промпт, выбранная модель,
// параметры, счётчик и ручные референсы жили только в состоянии React: встал
// из-за компьютера, взял планшет — и набирать всё заново.
//
// Хранится рядом с остальным состоянием, по доске, и НАМЕРЕННО без резервных
// копий: это не материал пользователя, а положение рычагов. Потерять его
// неприятно, но не страшно, и городить .bak ради строки промпта незачем.
//
// Инвариант «без base64» действует и здесь: в референсах допустимы только
// ссылки /media/… — иначе черновик стал бы четвёртой дырой, через которую
// картинка попадает в json (первые три закрыты в canvasSnapshot и archive).

const MAX_PROMPT_CHARS = 8000
const MAX_REFS = 12
const MAX_SELECTION = 200
const MAX_PARAM_KEYS = 30
const MAX_TEXT_REF_CHARS = 4000

const ID_RE = /^[A-Za-z0-9_:-]{1,80}$/

export type SessionDraftKind = 'image' | 'video' | 'audio'
export type SessionDraftPane = 'prompt' | 'assistant'

export interface SessionDraftRef {
  id: string
  kind: 'image' | 'video' | 'audio' | 'text'
  src?: string
  text?: string
  name?: string
}

export interface SessionDraft {
  prompt: string
  kind: SessionDraftKind
  modelId?: string
  params?: Record<string, string | number | boolean>
  count?: number
  pane?: SessionDraftPane
  selection?: string[]
  manualRefs?: SessionDraftRef[]
}

export interface StoredSessionDraft {
  draft: SessionDraft
  device: string
  updatedAt: number
}

function draftsDir(): string {
  return path.join(path.dirname(config.settingsFile), 'session-drafts')
}

function draftFile(projectId: string): string {
  return path.join(draftsDir(), `${projectId}.json`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** Имя устройства показывается человеку («черновик с Windows»), поэтому чистим. */
export function normalizeDeviceName(raw: unknown): string {
  if (typeof raw !== 'string') return 'other device'
  const cleaned = raw.replace(/[\p{C}]+/gu, ' ').replace(/\s+/g, ' ').trim()
  return cleaned.slice(0, 40) || 'other device'
}

function sanitizeRef(value: unknown): SessionDraftRef | null {
  if (!isRecord(value)) return null
  const id = typeof value.id === 'string' ? value.id : ''
  if (!ID_RE.test(id)) return null
  const kind = value.kind
  if (kind !== 'image' && kind !== 'video' && kind !== 'audio' && kind !== 'text') return null
  const ref: SessionDraftRef = { id, kind }
  if (typeof value.src === 'string') {
    // Ровно тот же запрет, что у холста: наружу из json не должно торчать
    // ничего, кроме ссылки на файл в media.
    if (!value.src.startsWith('/media/')) return null
    ref.src = value.src.slice(0, 500)
  }
  if (typeof value.text === 'string') ref.text = value.text.slice(0, MAX_TEXT_REF_CHARS)
  if (typeof value.name === 'string') ref.name = value.name.slice(0, 200)
  if (kind !== 'text' && !ref.src) return null
  return ref
}

function sanitizeParams(value: unknown): Record<string, string | number | boolean> | undefined {
  if (!isRecord(value)) return undefined
  const out: Record<string, string | number | boolean> = {}
  for (const [key, raw] of Object.entries(value).slice(0, MAX_PARAM_KEYS)) {
    if (!ID_RE.test(key)) continue
    if (typeof raw === 'string') out[key] = raw.slice(0, 2000)
    else if (typeof raw === 'number' && Number.isFinite(raw)) out[key] = raw
    else if (typeof raw === 'boolean') out[key] = raw
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * Приводит присланный черновик к безопасному виду или отказывает.
 *
 * Отказ возвращает null: черновик — не материал, и лучше не сохранить его
 * вовсе, чем записать в состояние приложения что-то неразобранное.
 */
export function sanitizeSessionDraft(value: unknown): SessionDraft | null {
  if (!isRecord(value)) return null
  const kind = value.kind
  if (kind !== 'image' && kind !== 'video' && kind !== 'audio') return null
  const draft: SessionDraft = {
    prompt: typeof value.prompt === 'string' ? value.prompt.slice(0, MAX_PROMPT_CHARS) : '',
    kind,
  }
  if (typeof value.modelId === 'string' && ID_RE.test(value.modelId)) draft.modelId = value.modelId
  const params = sanitizeParams(value.params)
  if (params) draft.params = params
  if (typeof value.count === 'number' && Number.isFinite(value.count)) {
    draft.count = Math.min(8, Math.max(1, Math.floor(value.count)))
  }
  if (value.pane === 'prompt' || value.pane === 'assistant') draft.pane = value.pane
  if (Array.isArray(value.selection)) {
    const selection = value.selection
      .filter((id): id is string => typeof id === 'string' && ID_RE.test(id))
      .slice(0, MAX_SELECTION)
    if (selection.length > 0) draft.selection = selection
  }
  if (Array.isArray(value.manualRefs)) {
    const refs = value.manualRefs
      .map(sanitizeRef)
      .filter((ref): ref is SessionDraftRef => ref !== null)
      .slice(0, MAX_REFS)
    if (refs.length > 0) draft.manualRefs = refs
  }
  return draft
}

/** Пустой черновик хранить незачем — это то же самое, что его отсутствие. */
export function isEmptySessionDraft(draft: SessionDraft): boolean {
  return draft.prompt.trim() === ''
    && !draft.modelId
    && !draft.params
    && !draft.selection
    && !draft.manualRefs
    && (draft.count ?? 1) <= 1
}

export async function loadSessionDraft(projectId: string): Promise<StoredSessionDraft | null> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(draftFile(projectId), 'utf8'))
    if (!isRecord(parsed)) return null
    const draft = sanitizeSessionDraft(parsed.draft)
    if (!draft) return null
    return {
      draft,
      device: normalizeDeviceName(parsed.device),
      updatedAt: typeof parsed.updatedAt === 'number' && Number.isFinite(parsed.updatedAt)
        ? parsed.updatedAt
        : 0,
    }
  } catch {
    // Файла ещё нет или он повреждён. И то и другое означает одно: черновика
    // нет. Падать здесь нельзя — иначе доска не откроется из-за строки промпта.
    return null
  }
}

export async function saveSessionDraft(
  projectId: string,
  draft: SessionDraft,
  device: string,
  now: number = Date.now(),
): Promise<StoredSessionDraft> {
  const stored: StoredSessionDraft = { draft, device: normalizeDeviceName(device), updatedAt: now }
  await fs.mkdir(draftsDir(), { recursive: true })
  const file = draftFile(projectId)
  const tmp = `${file}.${process.pid}.tmp`
  await fs.writeFile(tmp, JSON.stringify({ version: 1, ...stored }, null, 2))
  await fs.rename(tmp, file)
  return stored
}

export async function deleteSessionDraft(projectId: string): Promise<void> {
  await fs.rm(draftFile(projectId), { force: true }).catch(() => {})
}
