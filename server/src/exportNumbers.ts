import fs from 'node:fs/promises'
import path from 'node:path'
import { config } from './config.js'

// Нумерация файлов экспорта, ПЕРЕЖИВАЮЩАЯ перезапуск.
//
// Требование пользователя: двух одинаково названных файлов не должно быть
// никогда, сколько бы раз ни экспортировали. Значит номер нельзя считать от
// нуля на каждом экспорте — его надо выдавать и запоминать. Счётчик живёт
// рядом с остальным состоянием (data/export-numbers.json), потому что
// портативность священна: унесли папку — унесли и нумерацию.
//
// Ключ — метка И имя доски, а не её id: доски нередко называются одинаково
// («Без названия»), и раздельные счётчики выдали бы им один и тот же
// «1-1_Без названия». По имени же они делят один счётчик и не сталкиваются.

const numbersFile = path.join(path.dirname(config.settingsFile), 'export-numbers.json')

let queue: Promise<unknown> = Promise.resolve()

/** Очередь на файл: параллельные экспорты не должны терять чужие номера. */
function withNumbersLock<T>(run: () => Promise<T>): Promise<T> {
  const next = queue.then(run, run)
  queue = next.then(() => undefined, () => undefined)
  return next
}

export interface ExportGroupRequest {
  mark: number
  count: number
}

/** Имя доски, пригодное для имени файла. Windows запрещает \/:*?"<>| */
export function exportBoardName(raw: string | null | undefined): string {
  const cleaned = (raw ?? '').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim()
  return cleaned.slice(0, 60) || 'board'
}

/** Ключ счётчика. Регистр не важен: «Доска» и «доска» — одно и то же имя. */
export function exportNumberKey(mark: number, board: string): string {
  return `${mark}_${board.toLowerCase()}`
}

async function readNumbers(): Promise<Record<string, number>> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(numbersFile, 'utf8'))
    if (!parsed || typeof parsed !== 'object') return {}
    const out: Record<string, number> = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) out[key] = Math.floor(value)
    }
    return out
  } catch {
    // Файла ещё нет (первый экспорт) или он повреждён — начинаем с нуля.
    // Терять тут нечего: хуже испорченной нумерации только её отсутствие.
    return {}
  }
}

/**
 * Выдать начальные номера для групп и СРАЗУ их занять.
 *
 * Возвращает, с какого номера начинать каждую метку: группе из трёх файлов с
 * ответом `{ '1': 4 }` достанутся 4, 5, 6, а следующий экспорт той же метки
 * начнётся с 7.
 */
export function reserveExportNumbers(
  board: string,
  groups: readonly ExportGroupRequest[],
): Promise<Record<string, number>> {
  return withNumbersLock(async () => {
    const numbers = await readNumbers()
    const starts: Record<string, number> = {}
    for (const group of groups) {
      if (!Number.isFinite(group.mark) || group.count <= 0) continue
      const key = exportNumberKey(group.mark, board)
      const issued = numbers[key] ?? 0
      starts[String(group.mark)] = issued + 1
      numbers[key] = issued + Math.floor(group.count)
    }
    await fs.mkdir(path.dirname(numbersFile), { recursive: true })
    const tmp = `${numbersFile}.tmp`
    await fs.writeFile(tmp, JSON.stringify(numbers, null, 2))
    await fs.rename(tmp, numbersFile)
    return starts
  })
}
