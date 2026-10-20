import { flushSync } from 'react-dom'

// Мягкий переход между экранами (View Transitions API, стили — в styles.css).
// Браузер без поддержки просто выполняет update мгновенно, как раньше.
// flushSync обязателен: React должен успеть перерисоваться внутри кадра,
// пока браузер держит снапшот старого экрана.
export function withViewTransition(update: () => void): void {
  if (typeof document.startViewTransition !== 'function') {
    update()
    return
  }
  const transition = document.startViewTransition(() => {
    flushSync(update)
  })
  // Прерванный переход — это НОРМА, а не сбой: второй быстрый переход отменяет
  // первый (галерея → доска → назад), а на скрытой вкладке браузер не начинает
  // его вовсе. Спецификация в обоих случаях ОТКЛОНЯЕТ ready/finished, и без
  // обработчика это всплывало необработанным отказом промиса — «Transition was
  // aborted because of invalid state» в консоли. Сам update при этом выполняется
  // (браузер зовёт колбэк даже у пропущенного перехода), поэтому запасного
  // вызова здесь быть не должно: он привёл бы к двойному применению.
  void transition.ready?.catch(() => {})
  void transition.finished?.catch(() => {})
  void transition.updateCallbackDone?.catch(() => {})
}
