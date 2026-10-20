// Шина режима сравнения — мостик между контекстным меню, холстом и
// просмотрщиком (тот же приём, что cropBus/sketchBus/archiveBus).
//
// Два состояния подряд:
//   picking — исходник назначен, пользователь набирает кандидатов на холсте
//   viewing — набор закрыт, открыт просмотрщик

export type ComparePicking = {
  phase: 'picking'
  baselineId: string
  candidateIds: string[]
}

export type CompareViewing = {
  phase: 'viewing'
  baselineId: string
  candidateIds: string[]
  // исходник подтянут по родословной, а не выбран руками — скажем об этом в UI
  pulledIn: boolean
}

export type CompareSession = ComparePicking | CompareViewing

type Listener = (session: CompareSession | null) => void

let session: CompareSession | null = null
const listeners = new Set<Listener>()

function emit(): void {
  listeners.forEach((listener) => listener(session))
}

export function getCompareSession(): CompareSession | null {
  return session
}

export function onCompareSession(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function closeCompare(): void {
  if (!session) return
  session = null
  emit()
}

// ПКМ по объекту → «Сравнить с…»: назначили исходник, ждём кандидатов
export function startComparePicking(baselineId: string): void {
  session = { phase: 'picking', baselineId, candidateIds: [] }
  emit()
}

// Клик по объекту в режиме набора: первый раз добавляет, повторный — убирает.
// Порядок кликов = порядок панелей, поэтому добавляем в конец.
export function toggleCompareCandidate(id: string): void {
  if (!session || session.phase !== 'picking') return
  if (id === session.baselineId) return
  const has = session.candidateIds.includes(id)
  session = {
    ...session,
    candidateIds: has
      ? session.candidateIds.filter((candidateId) => candidateId !== id)
      : [...session.candidateIds, id],
  }
  emit()
}

export function setCompareCandidates(ids: string[]): void {
  if (!session || session.phase !== 'picking') return
  session = { ...session, candidateIds: ids.filter((id) => id !== session!.baselineId) }
  emit()
}

// «Сравнить (N)» — закрываем набор, открываем просмотрщик
export function openCompareViewer(
  baselineId: string,
  candidateIds: string[],
  pulledIn = false,
): void {
  if (candidateIds.length === 0) return
  session = { phase: 'viewing', baselineId, candidateIds, pulledIn }
  emit()
}

export function confirmComparePicking(): void {
  if (!session || session.phase !== 'picking' || session.candidateIds.length === 0) return
  openCompareViewer(session.baselineId, session.candidateIds)
}
