import { useEffect, useState } from 'react'
import type { ArchivedItem } from '../konva/types'

// Размеры файлов архива — HEAD-запросами: кэш на модуль (переживает закрытие
// панели) и не больше трёх запросов одновременно.
//
// ⚠️ Три, а не шесть: у сетевой доски размер спрашивается у сервера команды
// через сеть, а браузер держит к приложению всего шесть соединений. Занять
// их все значило бы поставить в очередь за архивом проверку связи и запуск
// генерации (находка Ф-1 аудита 24.09.2026). Панель закрыли — недоспрошенное
// отменяется.

const cache = new Map<string, number>()
const failed = new Set<string>()
const CONCURRENCY = 3

async function head(src: string, signal: AbortSignal): Promise<void> {
  try {
    const res = await fetch(src, { method: 'HEAD', signal })
    const len = res.ok ? res.headers.get('content-length') : null
    const bytes = len ? Number.parseInt(len, 10) : NaN
    if (Number.isFinite(bytes)) cache.set(src, bytes)
    else failed.add(src)
  } catch {
    // Отменённый запрос — не отказ: откроют панель снова — спросим ещё раз.
    if (!signal.aborted) failed.add(src)
  }
}

// Возвращает карту «src → байты» и флаг «ещё считаю». Пока размер неизвестен,
// карточка просто не показывает вес, а сортировка «по размеру» держит такие
// записи в конце (см. sortArchive).
export function useArchiveSizes(entries: ArchivedItem[], enabled: boolean): {
  sizes: Map<string, number>
  loading: boolean
} {
  const [, setVersion] = useState(0)
  const [loading, setLoading] = useState(false)
  const wanted = entries
    .map((entry) => entry.src)
    .filter((src): src is string => Boolean(src) && !cache.has(src!) && !failed.has(src!))
  const key = enabled ? wanted.join('|') : ''

  useEffect(() => {
    if (!enabled || !key) return
    let alive = true
    const controller = new AbortController()
    const queue = key.split('|')
    setLoading(true)
    const worker = async (): Promise<void> => {
      while (alive) {
        const src = queue.shift()
        if (!src) return
        await head(src, controller.signal)
        if (alive) setVersion((v) => v + 1)
      }
    }
    void Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker)).finally(() => {
      if (alive) setLoading(false)
    })
    return () => {
      alive = false
      controller.abort()
    }
  }, [key, enabled])

  return { sizes: cache, loading }
}
