import type { Macro } from '../../api'
import type { ProjectSource } from '../../types'
import { importMacroFromText, type MacroLibraryApi } from './macroFileActions'
import { LOCAL_MODELS, edge, node, seeded } from './macroFileTestKit'
import { createMacroClipboardHandlers } from './useMacroClipboard'
import type { LibraryNotice } from './useMacroLibraryActions'

// Стенд для тестов Ctrl+C и Ctrl+V макроса: «страница», «буфер» и «сервер» —
// всё, чего обработчики касаются. В библиотеку макрос идёт настоящим
// `importMacroFromText`, подставлен только сам сервер.

export const graph = {
  nodes: [
    node('in', 'input'),
    node('img', 'image', { prompt: "cat", model: 'chatgpt-image-2', params: seeded(LOCAL_MODELS, 'chatgpt-image-2') }),
    node('out', 'output'),
  ],
  edges: [edge('in', 'images', 'img', 'ref1'), edge('img', 'out', 'out', 'in-image')],
}

export const macro = (name: string, slot: number | undefined, over: Partial<Macro> = {}): Macro => ({
  id: `m-${name}-${slot ?? 'x'}`, name, graph, createdAt: 1, updatedAt: 1, revision: 1, slot, scope: 'canvas', ...over,
})

/** «Поле ввода»: событие с такой целью обработчики считают набором текста. */
export const INPUT = { field: true } as unknown as EventTarget

export interface FakeKey {
  key: string
  code: string
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  altKey: boolean
  target: EventTarget | null
  prevented: boolean
  preventDefault(): void
}

export interface FakePaste {
  target: EventTarget | null
  clipboardData: { getData(format: string): string }
  prevented: boolean
  preventDefault(): void
}

export function bench(board: ProjectSource = 'local', library: Macro[] = [macro("Portrait", 0)]) {
  const page = { hovered: null as Macro | null, overRow: false, selected: '' }
  const clipboard = { text: '', refuses: false }
  const server = {
    macros: library.map((item) => ({ ...item })),
    refusal: '',
    listFails: false,
    gate: null as Promise<void> | null,
  }
  const toasts: string[] = []
  const notices: LibraryNotice[] = []
  const calls: string[] = []
  let changed = 0
  let seq = 0
  const api: MacroLibraryApi = {
    models: async () => ({ models: LOCAL_MODELS }),
    saveMacro: async (name, savedGraph, _id, slot, _revision, scope) => {
      calls.push('saveMacro')
      if (server.gate) await server.gate
      if (server.refusal) throw new Error(server.refusal)
      // Кнопка у макроса одна: свой сервер снимает её с прежнего владельца.
      for (const item of server.macros) if (slot != null && item.slot === slot) item.slot = undefined
      server.macros.push(macro(name, slot, { id: `s${++seq}`, graph: savedGraph, scope }))
      return {}
    },
  }
  const handlers = createMacroClipboardHandlers({
    // The local edition has one catalog and one persistence lane. Keep the
    // board argument in the fixture for source compatibility with shared tests,
    // but always route clipboard operations through the local lane.
    projectSource: () => 'local',
    models: () => LOCAL_MODELS,
    hoveredMacro: () => page.hovered,
    overRow: () => page.overRow,
    typingIn: (target) => target === INPUT,
    selectedText: () => page.selected,
    loadRow: async () => {
      calls.push('loadRow')
      if (server.listFails) throw new Error("CanAI is temporarily unavailable")
      return server.macros.map((item) => ({ ...item }))
    },
    copyText: async (text) => {
      if (clipboard.refuses) return false
      clipboard.text = text
      return true
    },
    importMacro: (text, source, scope, slot, rename) => importMacroFromText(text, source, scope, slot, rename, api),
    notify: (toast) => { toasts.push(`${toast.kind}: ${toast.message}`) },
    onNotes: (notice) => { notices.push(notice) },
    changed: () => { changed += 1 },
  })
  /** Ctrl+C; `init` меняет клавишу, модификаторы или цель. */
  const key = (init: Partial<FakeKey> = {}): FakeKey => ({
    key: 'c', code: 'KeyC', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false,
    target: null, prevented: false,
    preventDefault() { this.prevented = true },
    ...init,
  })
  const pasteEvent = (text: string, target: EventTarget | null = null): FakePaste => ({
    target, clipboardData: { getData: () => text }, prevented: false,
    preventDefault() { this.prevented = true },
  })
  const saved = (): Array<[string, number | null]> => server.macros.map((item) => [item.name, item.slot ?? null])
  /** Закрыть «ворота» записи: вставка дойдёт до saveMacro и встанет. Возвращает «открыть». */
  const closeGate = (): (() => void) => {
    let open = () => {}
    server.gate = new Promise<void>((resolve) => { open = resolve })
    return () => open()
  }
  return { page, clipboard, server, toasts, notices, calls, handlers, key, pasteEvent, saved, closeGate, changed: () => changed }
}

/**
 * Дать обработчику дойти до ближайшей остановки (до «ворот» записи): несколько
 * оборотов цикла событий. Обработчики ждут только обещаний, поэтому хватило бы
 * и одного оборота; запас — на случай ещё одного ожидания по дороге. Куда
 * обработчик дошёл, тест после этого сверяет сам — по `calls`.
 */
export async function settle(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) await new Promise<void>((resolve) => setImmediate(resolve))
}
