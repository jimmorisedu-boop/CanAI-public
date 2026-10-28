import type { TimelineCommand } from './timelineKeys'
import { adjacentCutTime } from './timelineModel'

// Что делает каждая клавиша таймлайна. Разбор клавиши в команду — в
// timelineKeys (чисто, без DOM); здесь — выполнение команды через действия
// оверлея. Вынесено из компонента, чтобы арифметику перемотки можно было
// проверить без React и чтобы сам оверлей оставался тонким.

export interface TimelineCommandEnv {
  head: number
  inPoint: number
  outPoint: number
  cuts: readonly number[]
  duration: number
  /** Шаг стрелки — ровно кадр клипа. */
  frameStep: number
  /** Фокус на нативной кнопке: Enter она нажимает сама. */
  targetIsButton: boolean
  /** Команда съела событие — браузеру с ним делать нечего. */
  prevent(): void
  close(): void
  apply(): void
  togglePlay(): void
  pause(): void
  setHead(time: number): void
  cut(): void
  toggleDrop(): void
  trimLeft(): void
  trimRight(): void
  markIn(time: number): void
  markOut(time: number): void
  capture(): void
  crop(): void
  audio(): void
  toggleShelf(): void
  fit(): void
  showFrame(): void
  downloadFrame(): void
}

/** На сколько секунд и в какую сторону сдвигает команда перемотки (без «краёв»). */
export function seekDelta(
  command: Extract<TimelineCommand, { kind: 'seek' }>,
  env: Pick<TimelineCommandEnv, 'duration' | 'frameStep'>,
): number {
  const base = command.page
    ? Math.max(0.1, env.duration * 0.1)
    : (command.tenFrames ? env.frameStep * 10 : env.frameStep)
  return base * command.direction
}

export function runTimelineCommand(command: TimelineCommand, env: TimelineCommandEnv): void {
  switch (command.kind) {
    case 'close': env.prevent(); env.close(); break
    case 'apply':
      // Сфокусированную кнопку Enter нажимает сам, нативно. Если обработать
      // его ещё и здесь, «Применить» сработает дважды.
      if (env.targetIsButton) return
      env.prevent()
      env.apply()
      break
    case 'play': env.prevent(); env.togglePlay(); break
    case 'seek':
      env.prevent()
      env.pause()
      if (command.edge) {
        env.setHead(command.edge === 'start' ? env.inPoint : env.outPoint)
        break
      }
      env.setHead(env.head + seekDelta(command, env))
      break
    case 'jumpCut':
      env.prevent()
      env.pause()
      env.setHead(adjacentCutTime(env.head, env.inPoint, env.outPoint, env.cuts, command.direction))
      break
    case 'cut': env.prevent(); env.cut(); break
    case 'toggleDrop': env.prevent(); env.toggleDrop(); break
    case 'trimLeft': env.prevent(); env.trimLeft(); break
    case 'trimRight': env.prevent(); env.trimRight(); break
    case 'in': env.prevent(); env.markIn(env.head); break
    case 'out': env.prevent(); env.markOut(env.head); break
    case 'capture': env.prevent(); env.capture(); break
    case 'crop': env.prevent(); env.crop(); break
    case 'audio': env.prevent(); env.audio(); break
    case 'drawer': env.prevent(); env.toggleShelf(); break
    case 'fit': env.prevent(); env.fit(); break
    case 'showOnCanvas': env.prevent(); env.showFrame(); break
    case 'downloadFrame': env.prevent(); env.downloadFrame(); break
  }
}
