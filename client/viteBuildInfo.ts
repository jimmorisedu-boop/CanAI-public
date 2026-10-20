import path from 'node:path'
import { readBuildInfo } from '../server/src/buildInfo'

/**
 * Номер сборки для страницы (пункт 5.1): вшивается сборщиком как
 * `__CANAI_BUILD__` и читается `client/src/diag/buildInfo.ts`.
 *
 * ⚠️ Правило ОДНО с сервером — `readBuildInfo` из `server/src/buildInfo.ts`:
 * две копии разъехались бы при первой правке одной. Корень репозитория
 * берём от рабочей папки сборщика (он всегда запускается из `client/`, тот же
 * приём, что у `viteOrt.ts`).
 */
export function buildDefine(): Record<string, string> {
  return { __CANAI_BUILD__: JSON.stringify(readBuildInfo(path.resolve(process.cwd(), '..'))) }
}
