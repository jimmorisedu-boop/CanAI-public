// Единственный способ задать пользователю вопрос. Нативные window.confirm и
// window.prompt в проекте запрещены: браузер предлагает их заглушить после
// серии подряд, и дальше «Отмена» приходит сама собой — действие молча не
// выполняется, а сказать об этом уже нечем.
//
// Шина, а не пропсы: вопрос нужен из мест, далёких от разметки (движок нод,
// сохранение макроса, промпт-бар), и всем им удобнее `await askConfirm(...)`.

export interface ConfirmRequest {
  title: string
  detail?: string
  // расшифровка последствий: [что, значение] — «Модель · Seedance 2»
  rows?: Array<[string, string]>
  // кнопка называет действие, а не «ОК»: «Запустить за $2.40», «Выйти и потерять»
  confirmLabel: string
  cancelLabel?: string
  // необратимое действие — кнопка красная
  danger?: boolean
}

type Listener = (request: ConfirmRequest, resolve: (ok: boolean) => void) => void

let listener: Listener | null = null

export function registerConfirmHost(fn: Listener | null): void {
  listener = fn
}

export function askConfirm(request: ConfirmRequest): Promise<boolean> {
  // Хоста нет (тесты, ранняя загрузка) — не блокируем работу и не выдумываем
  // согласие за пользователя: считаем, что подтверждения не было.
  if (!listener) return Promise.resolve(false)
  return new Promise<boolean>((resolve) => {
    listener!(request, resolve)
  })
}
