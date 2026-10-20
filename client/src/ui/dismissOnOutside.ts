import { useEffect, type RefObject } from 'react'

// Клик мимо гасит сообщение. Приём общий для всех оповещений приложения:
// и для всплывашек в углу, и для плашки посреди кадра в таймлайне.
//
// Слушаем pointerdown, а не click, по двум причинам: пользователь считает
// сообщение убранным уже в момент нажатия, а при перетаскивании холста
// (нажал — увёл — отпустил) события click вообще не будет, и оповещение
// висело бы до конца своего срока.
//
// Слушатель в ФАЗЕ ПЕРЕХВАТА, но событие не гасится: клик мимо обязан и
// убрать плашку, и сделать то, ради чего кликали. Само сообщение из-под
// удара выведено проверкой contains — иначе нажатие на «Отменить» гасило бы
// плашку раньше, чем сработала бы её кнопка.
export function useDismissOnOutsidePointer(
  active: boolean,
  container: RefObject<HTMLElement | null>,
  dismiss: () => void,
  keepOpen?: (target: EventTarget | null) => boolean,
): void {
  useEffect(() => {
    if (!active) return
    const onPointerDown = (event: PointerEvent) => {
      const node = container.current
      if (node && event.target instanceof Node && node.contains(event.target)) return
      if (keepOpen?.(event.target)) return
      dismiss()
    }
    window.addEventListener('pointerdown', onPointerDown, true)
    return () => window.removeEventListener('pointerdown', onPointerDown, true)
  }, [active, container, dismiss, keepOpen])
}
