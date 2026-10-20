import { useEffect, useRef, useState } from 'react'
import { api, ApiError } from '../../../api'
import type { CanvasItem } from '../konva/types'
import { DEFAULT_FACE_THRESHOLD, faceVerdict, formatSimilarity } from './faceMath'
import { compareFaces, type FaceComparison } from './faceSimilarity'
import { systemErrorMessage } from '../../../ui/systemMessage'

// Сходство лиц в просмотрщике сравнения.
//
// Правило, ради которого всё и написано: сравнение НЕ превращается в
// «сравнение лиц». Пейзажи, товарка и кадры сравниваются как раньше — плашка
// просто не появляется. Лиц нет — молчим, лицо на одной картинке — говорим об
// этом словами, а не выдумываем число.
//
// Считается только видимая пара и только для картинок: у видео кадр меняется,
// и посчитанное само по себе число врало бы.

export type FaceState =
  | { kind: 'off' }
  | { kind: 'busy' }
  | { kind: 'result'; value: FaceComparison }
  | { kind: 'no-models' }
  /** Сервер старый: приложение обновили, но не перезапустили. */
  | { kind: 'stale' }
  | { kind: 'error'; message: string }

function comparable(item: CanvasItem | undefined): boolean {
  return item?.kind === 'image' && Boolean(item.src)
}

export function useFaceSimilarity(
  baseline: CanvasItem | undefined,
  candidate: CanvasItem | undefined,
  /** Меняется после докачки моделей — тогда стоит попробовать снова. */
  attempt: number,
  /** Какое лицо мерить, если их несколько. По умолчанию самое крупное. */
  faceIndexA = 0,
  faceIndexB = 0,
): FaceState {
  const [state, setState] = useState<FaceState>({ kind: 'off' })
  // Гонка при быстром листании кандидатов: ответ на прошлую пару не должен
  // перебивать текущую.
  const runRef = useRef(0)

  useEffect(() => {
    if (!comparable(baseline) || !comparable(candidate)) {
      setState({ kind: 'off' })
      return
    }
    const run = ++runRef.current
    setState({ kind: 'busy' })
    void (async () => {
      try {
        // ⚠️ Спрашиваем СЕРВЕР, есть ли модели, и только потом трогаем движок.
        // Раньше причину угадывали по тексту ошибки движка — на чужой машине
        // он говорит своё («no available backend found»), под шаблон не
        // попадал, и вместо понятного «включить сравнение лиц» человек видел
        // «сходство не посчиталось» (жалоба 20.08.2026, чужой компьютер).
        const models = await api.faceModelsState()
        if (runRef.current !== run) return
        if (models.state !== 'ready') {
          setState({ kind: 'no-models' })
          return
        }
        const value = await compareFaces(baseline!.src!, candidate!.src!, faceIndexA, faceIndexB)
        if (runRef.current === run) setState({ kind: 'result', value })
      } catch (error: unknown) {
        if (runRef.current !== run) return
        // Ручки нет вовсе — приложение обновили, но не перезапустили: сервер
        // старый. Это не «не посчиталось», это «перезапусти».
        if (error instanceof ApiError && error.status === 404) {
          setState({ kind: 'stale' })
          return
        }
        // Движок не поднялся — чаще всего потому, что интерфейс собран прежней
        // версией и файлов движка в сборке ещё нет. Проверяем прямо, а не
        // гадаем по тексту: совет от этого меняется на выполнимый.
        const engineOk = await fetch('/ort/ort-wasm-simd-threaded.wasm', { method: 'HEAD' })
          .then((response) => response.ok)
          .catch(() => false)
        if (runRef.current !== run) return
        if (!engineOk) {
          setState({ kind: 'stale' })
          return
        }
        setState({
          kind: 'error',
          message: error instanceof Error ? error.message : 'Failed to compare faces',
        })
      }
    })()
  }, [attempt, baseline?.id, baseline?.src, candidate?.id, candidate?.src, faceIndexA, faceIndexB])

  return state
}

export function FaceSimilarityChip({
  state,
  threshold,
  onThreshold,
  onEnable,
  onPick,
}: {
  state: FaceState
  threshold: number
  onThreshold(value: number): void
  onEnable(): void
  /** Открыть выбор лица. Не передан — приписка остаётся просто пояснением. */
  onPick?(side: 'a' | 'b'): void
}) {
  const [open, setOpen] = useState(false)

  if (state.kind === 'off') return null

  if (state.kind === 'no-models') {
    // Тихое предложение, а не требование: ничего не качается без спроса.
    return (
      <button type="button" className="face-chip face-chip-offer" onClick={onEnable}>
        enable face comparison
      </button>
    )
  }

  if (state.kind === 'stale') {
    // Ручки моделей на сервере нет: файлы обновились, а процесс остался старым.
    // Говорим ровно то, что надо сделать, — «не посчиталось» тут бесполезно.
    return (
      <span className="face-chip" title="Server is running an older version">
        <i className="face-dot" aria-hidden="true" />restart CanAI; the server is outdated
      </span>
    )
  }

  if (state.kind === 'busy') {
    return <span className="face-chip"><i className="face-dot" aria-hidden="true" />calculating similarity…</span>
  }

  if (state.kind === 'error') {
    return <span className="face-chip face-chip-bad" title={systemErrorMessage(state.message, 'Similarity could not be calculated')}><i className="face-dot" aria-hidden="true" />similarity could not be calculated</span>
  }

  const { value } = state
  if (value.kind === 'no-face') {
    const where = value.where === 'both'
      ? 'no faces found'
      : value.where === 'a'
        ? 'no face in the source'
        : 'no face in the candidate'
    return <span className="face-chip"><i className="face-dot" aria-hidden="true" />{where} — nothing to compare</span>
  }

  const verdict = faceVerdict(value.similarity, threshold)
  const multipleA = value.facesA > 1
  const multipleB = value.facesB > 1
  const hasMultipleFaces = multipleA || multipleB
  const multipleFacesLabel = multipleA && multipleB
    ? 'Multiple faces in both frames'
    : multipleA
      ? 'Multiple faces in the source'
      : 'Multiple faces in the candidate'
  const thresholdLabel = `${Math.round(threshold * 100)}%`

  return (
    <span className={`face-chip face-chip-comparison ${verdict === 'same' ? 'face-chip-same' : ''}`}>
      <span className="face-chip-result">
        <b>{formatSimilarity(value.similarity)}</b>
        <span className="face-chip-verdict">{verdict === 'same' ? 'same person' : 'different person'}</span>
        <button
          type="button"
          className="face-chip-threshold"
          aria-expanded={open}
          title="Threshold used for the verdict"
          onClick={() => setOpen((current) => !current)}
        >
          Threshold {thresholdLabel}
        </button>
      </span>
      {open && (
        <span className="face-threshold-popover">
          <input
            type="range"
            min={0.2}
            max={0.8}
            step={0.01}
            value={threshold}
            aria-label="Face-similarity threshold"
            onChange={(event) => onThreshold(Number(event.target.value))}
          />
          <button type="button" onClick={() => onThreshold(DEFAULT_FACE_THRESHOLD)}>
            Return {Math.round(DEFAULT_FACE_THRESHOLD * 100)}%
          </button>
        </span>
      )}
      {/* ⚠️ Выбор лица включается ОТДЕЛЬНО и только там, где есть из чего
          выбирать. По умолчанию меряется самое крупное лицо, а рамки поверх
          картинки мешали бы всем, кто просто сравнивает кадры (просьба
          пользователя 21.08.2026). Поэтому приписка «в кадре несколько лиц» и
          есть кнопка: сообщение о неоднозначности и способ её снять — одно и
          то же место. */}
      {hasMultipleFaces ? (
        <span className="face-chip-context">
          <span>{multipleFacesLabel}</span>
          {onPick && multipleA && (
            <button type="button" className="face-chip-pick" onClick={() => onPick('a')}>
              {multipleB ? 'Select on source' : 'Select face'}
            </button>
          )}
          {onPick && multipleB && (
            <button type="button" className="face-chip-pick" onClick={() => onPick('b')}>
              {multipleA ? 'Select on candidate' : 'Select face'}
            </button>
          )}
        </span>
      ) : null}
    </span>
  )
}
