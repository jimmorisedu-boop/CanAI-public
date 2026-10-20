import { useEffect, useRef, type RefObject } from 'react'

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'

export function activateDialog(
  dialog: HTMLElement,
  previous: HTMLElement | null,
): () => void {
  const first = dialog.querySelector<HTMLElement>(FOCUSABLE)
  // ⚠️ `preventScroll` обязателен. Обычный focus() ПРОКРУЧИВАЕТ прокручиваемого
  // предка к элементу, а первой кнопкой окна бывает та, что лежит в самом низу
  // длинного текста: в справке по горячим клавишам ею оказалась «Пройти
  // заново», и окно открывалось прокрученным на 951 px — то есть с конца
  // (замер 09.09.2026, отсюда жалоба на справку). Окно обязано открываться с
  // начала: фокус — про клавиатуру, а не про то, что человек увидит первым.
  ;(first ?? dialog).focus({ preventScroll: true })
  return () => previous?.focus({ preventScroll: true })
}

export function useDialogFocus<T extends HTMLElement>(
  dialogRef: RefObject<T>,
  onClose: () => void,
): void {
  // Родитель часто передаёт inline-callback. Его новая ссылка не означает, что
  // диалог переоткрыли: перезапуск эффекта вернул бы фокус наружу, а затем снова
  // поставил бы его на первую кнопку внутри. В формах это отбирало фокус у поля
  // после каждого введённого символа. Ref сохраняет свежий обработчик Escape,
  // не перезапуская сам захват фокуса.
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    const previous = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    const restore = activateDialog(dialog, previous)

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onCloseRef.current()
        return
      }
      if (event.key !== 'Tab') return

      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE))
      if (focusable.length === 0) {
        event.preventDefault()
        dialog.focus()
        return
      }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    dialog.addEventListener('keydown', onKeyDown)
    return () => {
      dialog.removeEventListener('keydown', onKeyDown)
      restore()
    }
  }, [dialogRef])
}

/**
 * Возвращает фокус в окно, когда он «провалился» в никуда.
 *
 * ⚠️ Действие, убравшее строку (удаление, перенос на общую полку), убирает и
 * кнопку, на которой стоял фокус: он уходит на body, а Escape слушает само
 * окно — и окно переставало закрываться клавишей. `signal` — то, смена чего
 * значит «список перерисован» (например, число строк и признак занятости).
 */
export function useDialogFocusKeeper<T extends HTMLElement>(dialogRef: RefObject<T>, signal: unknown): void {
  useEffect(() => {
    const dialog = dialogRef.current
    const active = document.activeElement
    if (dialog && (!active || active === document.body)) dialog.focus({ preventScroll: true })
  }, [dialogRef, signal])
}
