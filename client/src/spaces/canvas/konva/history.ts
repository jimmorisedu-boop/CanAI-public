import type { ArchivedItem, CanvasItem } from './types'

// История холста для undo/redo. Снапшот — items + архив доски (иммутабельные
// копии); камера и штрихи скетча в историю не входят (как в Figma).
//
// Архив в снапшоте ОБЯЗАТЕЛЕН: отправка в архив снимает объект с холста и
// кладёт его в archive. Если бы архив жил вне истории, undo вернул бы объект
// на холст, не убрав его из архива (один id в двух местах), а redo потерял бы
// его совсем. Один общий снапшот делает «в архив» / «вернуть» / «удалить
// насовсем» обычными шагами Ctrl+Z.
/** Сколько шагов Ctrl+Z помнит доска — одно число на свою и сетевую (cloudUndo). */
export const HISTORY_LIMIT = 60
const LIMIT = HISTORY_LIMIT

export interface CanvasSnapshot {
  items: CanvasItem[]
  archive: ArchivedItem[]
}

export class History {
  private undoStack: CanvasSnapshot[] = []
  private redoStack: CanvasSnapshot[] = []

  // зовётся ПЕРЕД мутацией: кладём текущее состояние в undo, redo сбрасывается
  capture(snapshot: CanvasSnapshot): void {
    this.undoStack.push(snapshot)
    if (this.undoStack.length > LIMIT) this.undoStack.shift()
    this.redoStack = []
  }

  undo(current: CanvasSnapshot): CanvasSnapshot | null {
    const prev = this.undoStack.pop()
    if (!prev) return null
    this.redoStack.push(current)
    return prev
  }

  redo(current: CanvasSnapshot): CanvasSnapshot | null {
    const next = this.redoStack.pop()
    if (!next) return null
    this.undoStack.push(current)
    return next
  }

  clear(): void {
    this.undoStack = []
    this.redoStack = []
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0
  }
  get canRedo(): boolean {
    return this.redoStack.length > 0
  }
}
