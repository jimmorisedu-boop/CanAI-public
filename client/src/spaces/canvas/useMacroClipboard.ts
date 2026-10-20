import { useEffect, useRef, type RefObject } from 'react'
import { api, type Macro } from '../../api'
import type { CatalogModel, ProjectSource } from '../../types'
import { hits, type HotkeyEvent } from '../../ui/hotkeys'
import { copyText } from '../../ui/ids'
import { browserSelectedText } from './konva/canvasCopyOwnership'
import { importMacroFromText, isMacroText, macroCatalogOf, macroClipboardText } from './macroFileActions'
import { MACRO_SLOT_COUNT, freeMacroSlots } from './macroLibraryModel'
import { registerMacroRow } from './macroPasteRoute'
import { notifyMacrosChanged } from './macrosBus'
import { notify } from './notifications'
import type { LibraryNotice } from './useMacroLibraryActions'

const errorText = (cause: unknown, fallback: string): string => (
  cause instanceof Error ? cause.message : fallback
)

/**
 * Печатают ли в поле: тогда Ctrl+C и Ctrl+V — дело самого поля.
 *
 * ⚠️ Правило то же, что у холста, когда он решает, чей Ctrl+V (`focusInInput` в
 * KonvaCanvas.onPaste): поле ввода и редактируемый текст. Выпадающий список
 * полем НЕ считается: вставить в него нечего, а фокус остаётся в нём после
 * выбора модели. Пока ряд считал его полем, а холст — нет, Ctrl+V над рядом
 * молчал: холст уступал ход ряду, а ряд от вставки отказывался.
 */
export function typingInField(target: EventTarget | null): boolean {
  const element = target instanceof HTMLElement ? target : null
  return Boolean(element && (['INPUT', 'TEXTAREA'].includes(element.tagName) || element.isContentEditable))
}

/**
 * Макрос, на кнопке которого сейчас стоит курсор.
 *
 * Кнопка называет себя атрибутом `data-macro-id`, а сам макрос берётся из
 * свежего списка ряда. ⚠️ Спрашиваем у страницы в миг нажатия (`:hover`), а не
 * помним: память «курсор заходил на кнопку» залипала, стоило ряду перечитать
 * список под курсором, — и Ctrl+C копировал макрос, на котором курсора давно нет.
 */
export function macroUnderCursor(row: Pick<Element, 'querySelector'> | null, macros: readonly Macro[]): Macro | null {
  const id = row?.querySelector<HTMLElement>('[data-macro-id]:hover')?.dataset.macroId
  return macros.find((macro) => macro.id === id) ?? null
}

const NAME_LIMIT = 100

function copyName(name: string): string {
  const suffix = ' (copy)'
  const base = Array.from(name).slice(0, NAME_LIMIT - Array.from(suffix).length).join('').trimEnd()
  return `${base}${suffix}`
}

/** «Имя (копия 2)» — в пределах длины имени макроса. */
function numberedCopyName(name: string, number: number): string {
  const suffix = ` (copy ${number})`
  const base = Array.from(name).slice(0, NAME_LIMIT - Array.from(suffix).length).join('').trimEnd()
  return `${base}${suffix}`
}

/**
 * Имя вставленного макроса. «(копия)» — только когда такое имя здесь уже есть:
 * макрос, принесённый с другой доски, копией ничего не является. Вторая и
 * следующие копии получают номер — иначе в ряду вставали бы неразличимые
 * «Портрет (копия)», «Портрет (копия)».
 */
export function pastedMacroName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) return name
  const first = copyName(name)
  if (!taken.has(first)) return first
  for (let number = 2; number <= taken.size + 2; number += 1) {
    const candidate = numberedCopyName(name, number)
    if (!taken.has(candidate)) return candidate
  }
  return first
}

/** Макросы ряда — свежим запросом. Отбор тот же, что у самого ряда (reload в PromptMacros.tsx). */
export async function loadMacroRow(
  source: ProjectSource,
  library: Pick<typeof api, 'listMacros'> = api,
): Promise<Macro[]> {
  const list = (await library.listMacros()).macros
  return list.filter((macro) => macro.scope !== 'assistant')
}

/** Ровно то, что обработчикам нужно от события: тест подставляет своё. */
export interface MacroKeyEvent extends HotkeyEvent {
  target: EventTarget | null
  preventDefault(): void
}

export interface MacroPasteEvent {
  target: EventTarget | null
  clipboardData: { getData(format: string): string } | null
  preventDefault(): void
}

/** Всё, чем обработчики касаются мира: страница, буфер, библиотека. */
export interface MacroClipboardDeps {
  projectSource(): ProjectSource
  /** Каталог моделей этой доски: по нему в буфер пишутся имена моделей и подписи параметров. */
  models(): readonly CatalogModel[]
  /** Макрос, на кнопке которого СЕЙЧАС стоит курсор. */
  hoveredMacro(): Macro | null
  /** Стоит ли курсор над рядом кнопок. */
  overRow(): boolean
  typingIn(target: EventTarget | null): boolean
  /** Текст, выделенный на странице: Ctrl+C по нему — дело браузера. */
  selectedText(): string
  /** Макросы ряда свежим запросом — по ним считаются свободная кнопка и занятые имена. */
  loadRow(): Promise<readonly Macro[]>
  copyText(text: string): Promise<boolean>
  importMacro: typeof importMacroFromText
  notify(toast: { kind: 'info' | 'success' | 'error'; message: string }): void
  /** При вставке что-то пришлось заменить — показать так, чтобы успели прочесть. */
  onNotes(notice: LibraryNotice): void
  /** Библиотека изменилась — ряду пора перечитать список. */
  changed(): void
}

/**
 * Ctrl+C и Ctrl+V макроса над рядом кнопок — без React, чтобы поведение можно
 * было проверить подставными событиями. Пока обработчики жили внутри хука,
 * прогон оставался зелёным при снятом замке двойной вставки, при вставке мимо
 * ряда и при молчащем отказе буфера (проверка 02.10.2026).
 *
 * Обработчики возвращают обещание, которое исполняется, когда дело сделано:
 * окну оно не нужно, тесту — нужно.
 */
export function createMacroClipboardHandlers(deps: MacroClipboardDeps): {
  onKeyDown(event: MacroKeyEvent): Promise<void>
  onPaste(event: MacroPasteEvent): Promise<void>
} {
  // Синхронный замок: два Ctrl+V подряд, пока первый ещё едет, — один макрос, а не два.
  let pasting = false

  async function onKeyDown(event: MacroKeyEvent): Promise<void> {
    if (!hits('canvas.copy', event)) return
    const macro = deps.hoveredMacro()
    // ⚠️ Ctrl+C — наш, только когда курсор СЕЙЧАС на кнопке макроса, человек не
    // печатает и не выделил текст на странице. Раньше хватало памяти о том, что
    // курсор когда-то заходил на кнопку: после вставки над кнопкой эта память
    // залипала, и Ctrl+C по объектам доски клал в буфер макрос — объекты не
    // копировались, а следующее Ctrl+V на холсте молча ничего не делало.
    if (!macro || deps.typingIn(event.target) || deps.selectedText().trim() !== '') return
    event.preventDefault()
    let text: string
    try {
      text = macroClipboardText(macro, macroCatalogOf(deps.projectSource()), deps.models())
    } catch (cause) {
      deps.notify({ kind: 'error', message: errorText(cause, "Failed to copy macro") })
      return
    }
    const copied = await deps.copyText(text)
    deps.notify(copied
      ? { kind: 'success', message: `Macro “${macro.name}” copied` }
      // Без этих слов человек шёл вставлять макрос, которого в буфере нет.
      : { kind: 'error', message: "Failed to put macro on clipboard" })
  }

  async function pasteMacro(text: string): Promise<void> {
    if (pasting) return
    pasting = true
    try {
      const source: ProjectSource = 'local'
      // ⚠️ Свободную кнопку и занятые имена считаем по СВЕЖЕМУ списку, под
      // замком. Список самого ряда отстаёт на один запрос: второе Ctrl+V сразу
      // после первого (удержанная клавиша повторяет нажатие тридцать раз в
      // секунду) бралось за ту же кнопку, и первый вставленный макрос её терял.
      const row = await deps.loadRow()
      const slot = freeMacroSlots([...row])[0]
      if (slot == null) {
        deps.notify({ kind: 'info', message: `All ${MACRO_SLOT_COUNT} slots are occupied — free one in Macro Library` })
        return
      }
      const taken = new Set(row.map((macro) => macro.name))
      const pasted = await deps.importMacro(text, source, 'canvas', slot, (name) => pastedMacroName(name, taken))
      deps.changed()
      if (pasted.notes.length > 0) {
        deps.onNotes({ tone: 'info', title: `Macro “${pasted.name}” inserted. Changes:`, lines: pasted.notes })
      } else {
        deps.notify({ kind: 'success', message: `Macro "${pasted.name}" inserted` })
      }
    } catch (cause) {
      deps.notify({ kind: 'error', message: errorText(cause, "Failed to insert macro") })
    } finally {
      pasting = false
    }
  }

  async function onPaste(event: MacroPasteEvent): Promise<void> {
    if (deps.typingIn(event.target) || !deps.overRow()) return
    const text = event.clipboardData?.getData('text') ?? ''
    if (!isMacroText(text)) return
    event.preventDefault()
    await pasteMacro(text)
  }

  return { onKeyDown, onPaste }
}

/**
 * Ctrl+C и Ctrl+V макроса над рядом кнопок: курсор на кнопке — скопировать,
 * курсор на ряду — вставить.
 *
 * ⚠️ В буфер кладётся ТОТ ЖЕ файл обмена, что «Сохранить в файл», и вставка
 * идёт тем же путём, что «Из файла» (`importMacroFromText`). Раньше в буфере
 * лежал сырой граф, и вставлялся он как есть: макрос, скопированный на своей
 * доске и вставленный на сетевой, нёс модели и параметры чужого каталога —
 * кнопка выглядела готовой, а запуск падал на котировке. И правило «пришедшему
 * извне не верим» на буфер не распространялось.
 *
 * ⚠️ Вставку ловим событием `paste`, а не чтением буфера по клавише: событие
 * отдаёт текст сразу и без вопроса браузера «разрешить доступ к буферу?».
 * Текстом на холст макрос при этом не ложится — что холсту делать с таким
 * Ctrl+V, решает macroPasteRoute.ts.
 */
export function useMacroClipboard({
  rowRef, macros, models, projectSource, onNotes,
}: {
  /** Ряд кнопок: копируем и вставляем, только когда курсор над ним. */
  rowRef: RefObject<HTMLElement>
  macros: Macro[]
  /** Каталог моделей этой доски: по нему в буфер пишутся имена моделей и подписи параметров. */
  models: readonly CatalogModel[]
  projectSource: ProjectSource
  /** При вставке что-то пришлось заменить — показать так, чтобы успели прочесть. */
  onNotes(notice: LibraryNotice): void
}): void {
  // Обработчики живут всю жизнь ряда (замок двойной вставки у них один) и
  // читают свежие значения отсюда.
  const latest = useRef({ macros, models, projectSource, onNotes })
  useEffect(() => {
    latest.current = { macros, models, projectSource, onNotes }
  })

  useEffect(() => {
    const overRow = () => Boolean(rowRef.current?.matches(':hover'))
    const handlers = createMacroClipboardHandlers({
      projectSource: () => latest.current.projectSource,
      models: () => latest.current.models,
      hoveredMacro: () => macroUnderCursor(rowRef.current, latest.current.macros),
      overRow,
      typingIn: typingInField,
      selectedText: browserSelectedText,
      loadRow: () => loadMacroRow(latest.current.projectSource),
      copyText,
      importMacro: importMacroFromText,
      notify,
      onNotes: (notice) => latest.current.onNotes(notice),
      changed: notifyMacrosChanged,
    })
    const onKeyDown = (event: KeyboardEvent) => { void handlers.onKeyDown(event) }
    const onPaste = (event: ClipboardEvent) => { void handlers.onPaste(event) }
    const unregisterRow = registerMacroRow(overRow)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('paste', onPaste)
    return () => {
      unregisterRow()
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('paste', onPaste)
    }
  }, [rowRef])
}
