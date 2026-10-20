import { useEffect, useRef, useState } from 'react'
import type { ProjectSource, SessionDraft } from '../../../types'
import { deviceName } from './deviceIdentity'
import {
  buildSessionDraft,
  isForeignDraft,
  restoreSessionDraft,
  sameDraft,
  type DraftModelCatalog,
  type PromptDraftApply,
  type PromptDraftState,
} from './sessionDraftModel'
import {
  flushSessionDraft,
  loadSessionDraft,
  resetSessionDraftMemory,
  scheduleSessionDraftSave,
} from './sessionDraftSync'

// Черновик сеанса со стороны промпт-бара: что запоминать и когда возвращать.
// Логика живёт здесь, а не в PromptBar, — он и без того на полторы тысячи
// строк, а правило проекта требует делить около трёхсот.

export type { PromptDraftApply } from './sessionDraftModel'

export function usePromptDraft(input: {
  projectId: string
  projectSource?: ProjectSource
  /** Доска загружена; до этого подставлять что-либо некуда. */
  ready: boolean
  /** В режиме просмотра черновик не пишем — за рулём другое устройство. */
  canWrite: boolean
  /** Каталог моделей загружен: без него модель из черновика не выбрать. */
  modelsReady: boolean
  /** Каталог этого устройства: чужая версия могла записать модель, которой здесь нет. */
  catalog: DraftModelCatalog
  state: PromptDraftState
  apply: PromptDraftApply
  onRestored?(info: { device: string; foreign: boolean }): void
}): void {
  const { projectId, projectSource = 'local', ready, canWrite, modelsReady, catalog, state, apply, onRestored } = input

  const stateRef = useRef(state)
  stateRef.current = state
  const applyRef = useRef(apply)
  applyRef.current = apply
  const catalogRef = useRef(catalog)
  catalogRef.current = catalog
  const restoredForRef = useRef<string | null>(null)
  const lastSentRef = useRef<SessionDraft | null>(null)
  // Пока черновик не вернули (или не решили, что возвращать нечего), писать
  // НЕЛЬЗЯ. Иначе пустой промпт-бар успевает затереть настоящий черновик за те
  // доли секунды, пока он едет с сервера, — ровно та же ловушка, из-за которой
  // автосейв холста не включается до загрузки доски.
  const [restored, setRestored] = useState(false)
  const draftScope = `${projectSource}:${projectId}`

  // Возврат черновика. Ровно один раз на доску: повторное применение перебило
  // бы то, что человек уже набрал здесь.
  useEffect(() => {
    if (!ready || !modelsReady) return
    if (restoredForRef.current === draftScope) return
    let cancelled = false
    void loadSessionDraft(projectId, projectSource).then((stored) => {
      if (cancelled) return
      // React.StrictMode в development повторяет эффекты: первый запрос может
      // быть отменён cleanup'ом до ответа. Ставить маркер ДО await нельзя —
      // повторный эффект тогда навсегда пропустит восстановление.
      restoredForRef.current = draftScope
      if (stored) {
        // Что и в каком порядке возвращать, решает чистая функция (там же её
        // тесты): здесь только свежие состояние, способ и каталог.
        restoreSessionDraft({
          draft: stored.draft,
          current: stateRef.current,
          target: applyRef.current,
          catalog: catalogRef.current,
        })
        onRestored?.({ device: stored.device, foreign: isForeignDraft(stored.device, deviceName()) })
      }
      setRestored(true)
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftScope, projectId, projectSource, ready, modelsReady])

  // Смена доски: чужой черновик не должен считаться уже сохранённым.
  // Отметку о возврате здесь НЕ сбрасываем — она сравнивается с самим
  // projectId, а обнуление отсюда сработало бы уже ПОСЛЕ эффекта возврата и
  // позволило бы ему сработать второй раз, поверх набранного.
  useEffect(() => {
    resetSessionDraftMemory()
    lastSentRef.current = null
    setRestored(false)
    return () => {
      void flushSessionDraft()
    }
  }, [projectId, projectSource])

  // Запоминание. Пока доска не загрузилась, писать нечего: пустое состояние
  // промпт-бара затёрло бы настоящий черновик — ровно так же, как пустой холст
  // затёр бы настоящую доску, и защита тут та же по смыслу.
  useEffect(() => {
    if (!ready || !canWrite || !restored) return
    const draft = buildSessionDraft(state)
    if (lastSentRef.current && sameDraft(lastSentRef.current, draft)) return
    lastSentRef.current = draft
    scheduleSessionDraftSave(projectId, draft, projectSource)
  }, [projectId, projectSource, ready, canWrite, restored, state])

  // Вкладку сворачивают — дописываем немедленно: именно в этот момент человек
  // и уходит к другому устройству.
  useEffect(() => {
    const onHidden = () => {
      if (document.visibilityState === 'hidden') void flushSessionDraft()
    }
    document.addEventListener('visibilitychange', onHidden)
    return () => document.removeEventListener('visibilitychange', onHidden)
  }, [])
}
