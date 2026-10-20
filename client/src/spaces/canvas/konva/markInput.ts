// Ввод метки цифрами копится посимвольно: «1» затем быстро «2» → метка «12», а
// не два отдельных ввода. Третья цифра коммитит сразу (дальше цифр быть не
// может), одна-две ждут паузу. «0» первой цифрой снимает метку.
//
// Правила живут ЗДЕСЬ, а не в обработчике клавиш: метку ставят и на холсте, и
// в просмотрщике сравнения, и разъехавшиеся копии этих правил уже приводили к
// тому, что в просмотрщике работали только однозначные номера.

export const MARK_COMMIT_MS = 650
export const MARK_MAX_DIGITS = 3

export type MarkStep = {
  // новый буфер: пустой, если ввод завершён
  buffer: string
  // что записать в объекты; undefined — снять метку
  mark: number | undefined
  // первая цифра ввода — только она создаёт шаг истории (остальные дописывают)
  isFirstDigit: boolean
  // ввод завершён, паузу ждать не нужно
  commit: boolean
}

export function isMarkDigit(key: string): boolean {
  return /^[0-9]$/.test(key)
}

export function markStep(buffer: string, digit: string): MarkStep {
  const isFirstDigit = buffer.length === 0
  if (digit === '0' && isFirstDigit) {
    return { buffer: '', mark: undefined, isFirstDigit: true, commit: true }
  }
  const next = buffer + digit
  const commit = next.length >= MARK_MAX_DIGITS
  return {
    buffer: commit ? '' : next,
    mark: parseInt(next, 10),
    isFirstDigit,
    commit,
  }
}
