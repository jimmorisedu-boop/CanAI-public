import { extractBoardMemory, type BoardMemory } from './boardMemory'
import type { CanvasItem } from './konva/types'

/**
 * Общий memo/incremental selector памяти доски (план, Этап 1 — «Ввести общий
 * memo/incremental selector и линейную дедупликацию»).
 *
 * Один экземпляр живёт столько же, сколько поверхность, использующая память
 * (шельф помощника), и держит прошлый результат. Полный обход items — дорогой
 * шаг (на 10 000 объектов это десятки тысяч полей), поэтому он выполняется
 * ТОЛЬКО когда меняется content-версия стора (реально изменилось содержимое
 * холста) или сменился сам массив items.
 *
 * То, что обход НЕ происходит «на каждый ответ/тик», гарантировано версией, а
 * не временем: тиканье секундомера ответа, ре-рендеры ленты, пан/зум/выделение
 * контент-версию НЕ трогают (canvasStore: contentVersion инкрементится только в
 * notifyContent при изменении items). Дополнительно сравнивается ссылка массива
 * (`getItems()` возвращает `this.items`) — страховка от смены массива без
 * инкремента версии.
 *
 * `recomputeCount` — детерминированный счётчик реальных полных обходов.
 * Регрессионные тесты читают его и доказывают «повторных обходов нет» без
 * хрупких wall-clock замеров (план, строка 574; T02 — 10 000 items × 30
 * сообщений → один обход).
 */
export class BoardMemoryCache {
  private version = -1
  private sourceItems: readonly CanvasItem[] | null = null
  private cached: BoardMemory | null = null
  private recomputations = 0

  constructor(
    private readonly extract: (items: readonly CanvasItem[]) => BoardMemory = extractBoardMemory,
  ) {}

  get(items: readonly CanvasItem[], contentVersion: number): BoardMemory {
    if (this.cached === null || this.version !== contentVersion || this.sourceItems !== items) {
      this.version = contentVersion
      this.sourceItems = items
      this.cached = this.extract(items)
      this.recomputations += 1
    }
    return this.cached
  }

  /** Сколько раз реально выполнялся полный обход доски (счётчик для тестов). */
  get recomputeCount(): number {
    return this.recomputations
  }

  reset(): void {
    this.version = -1
    this.sourceItems = null
    this.cached = null
    this.recomputations = 0
  }
}