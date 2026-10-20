import { randomUUID } from 'node:crypto'
import { logNote } from './log.js'
import fs from 'node:fs/promises'
import path from 'node:path'
import { config } from './config.js'
import { assertGraphAcceptable } from './graphLimits.js'
import type { CatalogModel } from './catalog.js'
import { migrateGraphModel, modelUses } from '../../packages/model-catalog/macroModels.js'

// Нодовые workflow: макросы (data/macros.json) — по одному на слот-кнопку
// канваса (0..8). Черновик (data/workflow-draft.json) — легаси, оставлен для
// совместимости API. Всё переезжает вместе с папкой проекта.

const dataDir = path.dirname(config.projectFile)
const draftFile = path.join(dataDir, 'workflow-draft.json')
const macrosFile = path.join(dataDir, 'macros.json')

export const SLOT_COUNT = 9

// Где живёт кнопка макроса: 'canvas' — ряд слотов в строке генерации
// (картинки/видео), 'assistant' — ряд в окне помощника (только LLM-цепочки).
// Слоты нумеруются НЕЗАВИСИМО в каждой области.
export type MacroScope = 'canvas' | 'assistant'
export const MACRO_SCOPES: MacroScope[] = ['canvas', 'assistant']

export function normalizeScope(value: unknown): MacroScope {
  return value === 'assistant' ? 'assistant' : 'canvas'
}

export interface Macro {
  id: string
  name: string
  graph: unknown
  createdAt: number
  updatedAt: number
  revision: number
  // слот-кнопка (0..8); один макрос на слот В ПРЕДЕЛАХ СВОЕЙ области
  slot?: number
  // область; старые макросы без поля считаются канвасными
  scope?: MacroScope
}

export class MacroRevisionConflictError extends Error {
  constructor(
    readonly currentRevision: number,
  ) {
    super('Macro changed in other window')
    this.name = 'MacroRevisionConflictError'
  }
}

export class MacroNotFoundError extends Error {
  constructor() {
    super('Macro not found')
    this.name = 'MacroNotFoundError'
  }
}

// Список для перенумерации не совпал с тем, что лежит на диске: в другом окне
// макрос успели создать или удалить. Перенумеровывать вслепую нельзя.
export class MacroOrderMismatchError extends Error {
  constructor() {
    super('Macro list changed; reopen the library')
    this.name = 'MacroOrderMismatchError'
  }
}

/** Сколько нод в графе макроса. Форма графа приходит снаружи, поэтому считаем
 *  осторожно: у повреждённого объекта нод просто ноль. */
export function macroNodeCount(graph: unknown): number {
  const nodes = (graph as { nodes?: unknown })?.nodes
  return Array.isArray(nodes) ? nodes.length : 0
}

/** Заметно ли похудел макрос. Половина и больше — это уже не правка, а потеря:
 *  ровно так 20.08.2026 падение редактора записало 3 ноды вместо 10. Удаление
 *  руками тоже сюда попадёт — поэтому это ЗАПИСЬ В ЛОГ, а не отказ. */
export function macroShrinkNote(name: string, before: number, after: number): string | null {
  if (before < 4 || after > before / 2) return null
  return `macro «${name}»: nodes ${before} → ${after}; nearby lies macros.json.bak`
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return fallback
    throw err
  }
}

// ⚠️ У макросов не было НИ ОДНОЙ резервной копии — в отличие от досок, где
// перед каждой перезаписью пишется .bak. А терять там есть что: 20.08.2026
// падение редактора записало поверх макроса урезанный граф (осталось 3 ноды
// из 10), и восстановить его удалось только из посторонней копии. Теперь
// перед каждой перезаписью сохраняется предыдущее состояние — та же
// двухуровневая логика, что у project.json.
async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.copyFile(file, `${file}.bak`).catch(() => {})
  const tmp = `${file}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(tmp, JSON.stringify(value, null, 2))
    await fs.rename(tmp, file)
  } finally {
    await fs.unlink(tmp).catch(() => {})
  }
}

// «прочитал-изменил-записал» macros.json — по очереди: два параллельных
// сохранения макросов читали один список, вторая запись затирала первую
let macrosQueue: Promise<unknown> = Promise.resolve()
function withMacrosLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = macrosQueue.then(fn, fn)
  macrosQueue = next.then(
    () => undefined,
    () => undefined,
  )
  return next
}

let draftQueue: Promise<unknown> = Promise.resolve()
function withDraftLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = draftQueue.then(fn, fn)
  draftQueue = next.then(() => undefined, () => undefined)
  return next
}

// миграция старых макросов без слота: рассаживаем по свободным слотам
function assignMissingSlots(macros: Macro[]): boolean {
  // слоты считаются отдельно для каждой области: канвасный «Макрос 1» и
  // помощниковский «Макрос 1» — разные кнопки и не вытесняют друг друга
  const used = new Map<MacroScope, Set<number>>(
    MACRO_SCOPES.map((scope) => [scope, new Set<number>()]),
  )
  let changed = false
  for (const macro of macros) {
    if (!Number.isInteger(macro.revision) || macro.revision < 1) {
      macro.revision = 1
      changed = true
    }
    if (!Number.isFinite(macro.updatedAt)) {
      macro.updatedAt = macro.createdAt
      changed = true
    }
    const scope = normalizeScope(macro.scope)
    if (macro.scope !== scope) {
      macro.scope = scope
      changed = true
    }
    const slot = macro.slot
    if (slot == null) continue
    const taken = used.get(scope)!
    if (!Number.isInteger(slot) || slot < 0 || slot >= SLOT_COUNT || taken.has(slot)) {
      macro.slot = undefined
      changed = true
    } else {
      taken.add(slot)
    }
  }
  for (const m of macros) {
    if (m.slot != null) continue
    const taken = used.get(normalizeScope(m.scope))!
    const nextSlot = Array.from({ length: SLOT_COUNT }, (_, slot) => slot).find((slot) => !taken.has(slot))
    if (nextSlot == null) continue
    m.slot = nextSlot
    taken.add(nextSlot)
    changed = true
  }

  // Приводим технические имена «Макрос N» в соответствие с фактическим слотом (слот 0 → Макрос 1, слот 1 → Макрос 2...)
  for (const m of macros) {
    if (m.slot != null && /^(?:Макрос|Macro) \d+$/i.test(m.name.trim())) {
      const expectedName = `Macro ${m.slot + 1}`
      if (m.name !== expectedName) {
        m.name = expectedName
        changed = true
      }
    }
  }

  return changed
}

// Сжать номера области до 1..N без дырок, сохранив текущий порядок.
// Номер кнопки — это позиция в ряду, а не свойство макроса: дырок не бывает.
// Версию и updatedAt НЕ трогаем: это нормализация позиции, а не правка
// пользователя. Бамп ронял бы чужие открытые окна ложным конфликтом версий
// (так же ведёт себя assignMissingSlots).
function compactSlots(macros: Macro[], scope: MacroScope): boolean {
  const mine = macros
    .filter((macro) => normalizeScope(macro.scope) === scope && macro.slot != null)
    .sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0))
  let changed = false
  mine.forEach((macro, index) => {
    if (macro.slot === index) return
    macro.slot = index
    changed = true
  })
  return changed
}

function compactAllScopes(macros: Macro[]): boolean {
  let changed = false
  for (const scope of MACRO_SCOPES) {
    if (compactSlots(macros, scope)) changed = true
  }
  return changed
}

export const workflowStore = {
  loadDraft: () => readJson<unknown | null>(draftFile, null),
  saveDraft: (graph: unknown) =>
    withDraftLock(async () => {
      assertGraphAcceptable(graph)
      await writeJsonAtomic(draftFile, graph)
    }),
  async listMacros(): Promise<Macro[]> {
    return withMacrosLock(() => this.listMacrosUnlocked())
  },

  async listMacrosUnlocked(): Promise<Macro[]> {
    const macros = await readJson<Macro[]>(macrosFile, [])
    const filled = assignMissingSlots(macros)
    // дырки из старых данных схлопываются один раз при первом же чтении:
    // номер кнопки обязан быть позицией в ряду, иначе «подряд» — только на словах
    const compacted = compactAllScopes(macros)
    if (filled || compacted) await writeJsonAtomic(macrosFile, macros)
    return macros
  },

  async saveMacro(
    name: string,
    graph: unknown,
    id?: string,
    slot?: number,
    baseRevision?: number,
    scope: MacroScope = 'canvas',
  ): Promise<Macro> {
    return withMacrosLock(async () => {
      assertGraphAcceptable(graph)
      const macros = await this.listMacrosUnlocked()
      const now = Date.now()
      // слот эксклюзивен ВНУТРИ своей области: вытесняем прежнего владельца
      const sameSlot = (macro: Macro) =>
        macro.slot === slot && normalizeScope(macro.scope) === scope
      if (id) {
        const existing = macros.find((macro) => macro.id === id)
        if (!existing) throw new MacroNotFoundError()
        if (baseRevision !== existing.revision) {
          throw new MacroRevisionConflictError(existing.revision)
        }
        if (slot != null) {
          for (const macro of macros) {
            if (sameSlot(macro) && macro.id !== id) {
              macro.slot = undefined
              macro.updatedAt = now
              macro.revision += 1
            }
          }
        }
        const shrink = macroShrinkNote(existing.name, macroNodeCount(existing.graph), macroNodeCount(graph))
        if (shrink) logNote('macros', shrink)
        existing.name = name
        existing.graph = graph
        existing.updatedAt = now
        existing.revision += 1
        existing.scope = scope
        if (slot != null) existing.slot = slot
        await writeJsonAtomic(macrosFile, macros)
        return existing
      }

      if (slot != null) {
        for (const macro of macros) {
          if (sameSlot(macro)) {
            macro.slot = undefined
            macro.updatedAt = now
            macro.revision += 1
          }
        }
      }
      const macro: Macro = {
        id: randomUUID(),
        name,
        graph,
        createdAt: now,
        updatedAt: now,
        revision: 1,
        slot,
        scope,
      }
      macros.push(macro)
      await writeJsonAtomic(macrosFile, macros)
      return macro
    })
  },

  // Порядок кнопок задаётся ОДНОЙ атомарной записью: слот = позиция в списке.
  // Поштучные saveMacro тут не годятся — каждый следующий вытеснял бы соседа
  // из занятого слота, и на полпути список остался бы дырявым.
  async reorderMacros(scope: MacroScope, ids: string[]): Promise<Macro[]> {
    return withMacrosLock(async () => {
      const macros = await this.listMacrosUnlocked()
      const mine = macros.filter((macro) => normalizeScope(macro.scope) === scope)
      const byId = new Map(mine.map((macro) => [macro.id, macro]))
      // ids — это НОВЫЙ РЯД КНОПОК, а не «все макросы области». Сверять его с
      // полным списком нельзя: библиотека шлёт только тех, у кого кнопка есть,
      // и один макрос без кнопки (а такой появляется, когда заняты все девять)
      // делал перетаскивание невозможным НАВСЕГДА — каждый бросок отвечал 409,
      // и «откройте библиотеку заново» не помогало, потому что дело не в окне.
      // Требуем другое: ряд можно переставить и можно пополнить из «без кнопки»,
      // но нельзя молча выкинуть из него того, кто там уже стоит.
      const asked = new Set(ids)
      const droppedFromRow = mine.some((macro) => macro.slot != null && !asked.has(macro.id))
      if (
        ids.length > SLOT_COUNT ||
        asked.size !== ids.length ||
        ids.some((id) => !byId.has(id)) ||
        droppedFromRow
      ) {
        throw new MacroOrderMismatchError()
      }

      const now = Date.now()
      ids.forEach((id, index) => {
        const macro = byId.get(id)!
        if (macro.slot === index) return
        macro.slot = index
        macro.updatedAt = now
        macro.revision += 1
      })
      // технические имена «Макрос N» держатся за своим номером
      assignMissingSlots(macros)
      compactSlots(macros, scope)
      await writeJsonAtomic(macrosFile, macros)
      return macros
    })
  },

  async migrateModelsBatch(input: {
    fromFamily: string[]
    replacements: Array<{ macroId: string; revision: number; targetModelId: string }>
    models: CatalogModel[]
  }): Promise<Macro[]> {
    return withMacrosLock(async () => {
      const macros = await this.listMacrosUnlocked()
      const next = structuredClone(macros)
      const byId = new Map(next.map(macro => [macro.id, macro]))
      const originals = new Map(macros.map(macro => [macro.id, macro]))
      const seen = new Set<string>()
      const changed: Macro[] = []
      const now = Date.now()

      for (const replacement of input.replacements) {
        if (seen.has(replacement.macroId)) throw new Error('Macro specified for replacement twice')
        seen.add(replacement.macroId)
        const macro = byId.get(replacement.macroId)
        if (!macro) throw new MacroNotFoundError()
        if (macro.revision !== replacement.revision) throw new MacroRevisionConflictError(macro.revision)
        const target = input.models.find(model => model.id === replacement.targetModelId)
        if (!target) throw new Error('Model replacements not found')
        if (!input.fromFamily.some(id => modelUses(macro.graph, id).length > 0)) {
          throw new Error(`Model for replacements in macro «${macro.name}» not found`)
        }
        macro.graph = input.fromFamily.reduce(
          (graph, id) => migrateGraphModel(graph, id, target, input.models),
          macro.graph,
        )
        assertGraphAcceptable(macro.graph)
        macro.revision += 1
        macro.updatedAt = now
        changed.push(macro)
      }

      const archive = path.join(dataDir, 'macro-versions')
      await fs.mkdir(archive, { recursive: true })
      for (const macro of changed) {
        if (!/^[A-Za-z0-9_-]+$/.test(macro.id)) throw new Error('Invalid ID macro')
        const original = originals.get(macro.id)!
        await fs.writeFile(
          path.join(archive, `${macro.id}.${original.revision}.json`),
          JSON.stringify(original, null, 2),
          { flag: 'wx' },
        ).catch(error => {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        })
      }
      if (changed.length > 0) await writeJsonAtomic(macrosFile, next)
      return next
    })
  },

  async deleteMacro(id: string, baseRevision: number): Promise<void> {
    return withMacrosLock(async () => {
      const macros = await this.listMacrosUnlocked()
      const index = macros.findIndex((macro) => macro.id === id)
      if (index < 0) throw new MacroNotFoundError()
      const existing = macros[index]
      if (existing.revision !== baseRevision) {
        throw new MacroRevisionConflictError(existing.revision)
      }
      macros.splice(index, 1)
      // номера идут подряд: удаление из середины сдвигает хвост, а не
      // оставляет дырку в ряду кнопок
      compactSlots(macros, normalizeScope(existing.scope))
      await writeJsonAtomic(macrosFile, macros)
    })
  },
}
