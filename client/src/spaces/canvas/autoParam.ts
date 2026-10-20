import type { ParamSpec } from '../../types'

/**
 * Параметры, у которых «Авто» значит «решает модель по референсу».
 * Имя задаёт каталог: у своего это `aspect_ratio`, `resolution`, `image_size`,
 * у сервера команды — `aspect` и `size`.
 */
export const AUTO_BY_REF_PARAMS: readonly string[] = ['aspect', 'aspect_ratio', 'size', 'resolution', 'image_size']

const ASPECT_PARAMS: readonly string[] = ['aspect', 'aspect_ratio']

export function isAspectParam(name: string): boolean {
  return ASPECT_PARAMS.includes(name)
}

/**
 * ⚠️ У канона сервера команды `auto` ПО УМОЛЧАНИЮ значит «параметр не задан»:
 * сервер не шлёт его провайдеру вовсе и принимает без референса (translate.ts
 * в canai-cloud: «Авто не отправляем»). Это не обещание «решит по референсу»,
 * которое некому выполнить, поэтому такой «Авто» нельзя ни вырезать из списка,
 * ни подменять первым пунктом: у видео первым стоит 1:1 (у Gemini Omni — 9:16),
 * и подмена молча превращала ролик 16:9 в квадрат или вертикаль за те же
 * деньги — причём уже при открытии сохранённого макроса (проверка 01.10.2026).
 *
 * Узнаём канон по ИМЕНИ: `aspect` и `size` есть только у каталога сервера
 * команды. Если умолчание там конкретное (GPT Image 2.5 — 4:3), правило общее:
 * без референса «Авто» решать не по чему.
 */
export function autoMeansUnset(param: ParamSpec | undefined | null): boolean {
  return Boolean(param && (param.name === 'aspect' || param.name === 'size') && param.default === 'auto')
}
