const MAX = 5

// Квадрат 44×44 вмещает пять кириллических букв Onest 11px без случайного
// сжатия. Номера, пробелы и знаки в слот не попадают; полное имя остаётся в title.
export function macroShortLabel(name: string): string {
  const trimmed = name.trim()
  if (/^(?:сценарий|цепочка)/i.test(trimmed)) {
    return "Chain"
  }
  const firstWord = trimmed.match(/\p{L}+/u)?.[0] ?? "Macro"
  return Array.from(firstWord).slice(0, MAX).join('')
}
