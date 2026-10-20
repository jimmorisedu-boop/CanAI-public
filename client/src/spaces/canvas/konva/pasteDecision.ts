// Что делать по Ctrl+V: у холста ДВА буфера, и надо решить, чей ход.
//
// Внутренний буфер (`canai-clipboard` в localStorage) хранит скопированные
// объекты холста и живёт ВЕЧНО — он переживает перезагрузку и закрытие
// приложения. Системный буфер хранит то, что пользователь скопировал последним,
// в том числе где-то снаружи.
//
// Раньше внутренний побеждал всегда, если он не пуст. Итог: стоило один раз
// скопировать объект на холсте, и «вставить текст на холст» переставало работать
// НАВСЕГДА — вместо свежего текста появлялись старые объекты.
//
// Различить помогает наша же метка: `copySelected` кладёт в системный буфер JSON
// с `type: 'canai-clipboard'`. Если в системном буфере лежит НЕ она, значит
// пользователь копировал позже и снаружи — его копия и должна победить.

export type PasteChoice =
  // файлы картинок/видео из системного буфера
  | 'media'
  // фокус в поле ввода — пусть браузер вставляет сам
  | 'input'
  // объекты холста из внутреннего буфера
  | 'internal'
  // текст из системного буфера — новым объектом на холсте
  | 'text'
  // вставлять нечего
  | 'none'

export const OWN_CLIPBOARD_TYPE = 'canai-clipboard'

// Наша ли это метка в системном буфере.
export function isOwnClipboardText(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{')) return false
  try {
    return (JSON.parse(trimmed) as { type?: unknown }).type === OWN_CLIPBOARD_TYPE
  } catch {
    return false
  }
}

export function decidePaste(input: {
  hasMediaFiles: boolean
  focusInInput: boolean
  clipboardText: string
  hasInternalItems: boolean
  // ТОЧНО ли известно, что нашу копию не удалось положить в системный буфер.
  // Только это и мешает верить системному буферу: если запись не прошла, там
  // лежит чужой СТАРЫЙ текст, и принять его за свежую копию — значит сломать
  // обычный Ctrl+C→Ctrl+V по объектам холста.
  //
  // Важно, что вопрос именно такой, а не «удалось ли записать». Прежний
  // вариант требовал ПОДТВЕРЖДЁННОГО успеха в текущем сеансе, а внутренний
  // буфер живёт в localStorage и переживает перезапуск: сразу после запуска
  // подтверждения ещё нет, буфер уже есть — и ссылка, скопированная снаружи,
  // молча проигрывала давней копии объектов.
  mirrorFailed: boolean
}): PasteChoice {
  // Своя копия картинки содержит сразу PNG для внешних программ и JSON-метку
  // со ВСЕМИ объектами выделения. Метка важнее PNG: иначе внутри CanAI
  // вставлялась бы только первая картинка, а остальная группа терялась.
  if (input.hasInternalItems && isOwnClipboardText(input.clipboardText)) return 'internal'
  // ⚠️ Свою копию положить в системный буфер не удалось (или она ещё в пути) —
  // значит, файл в нём лежит с ПРОШЛОГО раза. Раньше файлы побеждали всегда, и
  // вместо только что скопированной картинки на доску падал давний снимок
  // экрана (жалоба 01.10.2026).
  if (input.hasMediaFiles && !(input.mirrorFailed && input.hasInternalItems)) return 'media'
  if (input.focusInInput) return 'input'

  const text = input.clipboardText.trim()
  const externalWins =
    text.length > 0 && !isOwnClipboardText(input.clipboardText) && !input.mirrorFailed
  if (externalWins) return 'text'

  if (input.hasInternalItems) return 'internal'
  return text.length > 0 ? 'text' : 'none'
}
