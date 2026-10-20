// Локальные (браузерные) пресеты параметров моделей на канвасе.
// Не путать с серверным data/settings.json — это UX-память выбора ручек.

const PARAMS_STORAGE_KEY = 'canai-model-params'

export function loadSavedModelParams(): Record<string, Record<string, unknown>> {
  try {
    const raw = localStorage.getItem(PARAMS_STORAGE_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

export function saveModelParams(
  modelId: string,
  params: Record<string, unknown>,
  transientNames: string[] = [],
): void {
  try {
    const all = loadSavedModelParams()
    all[modelId] = { ...all[modelId], ...params }
    for (const name of transientNames) delete all[modelId][name]
    localStorage.setItem(PARAMS_STORAGE_KEY, JSON.stringify(all))
  } catch {
    // quota / private mode — молча
  }
}
