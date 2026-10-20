// Единый реестр горячих клавиш: и обработчики, и справка читают ОДНИ И ТЕ ЖЕ
// записи. Раньше справка была отдельной таблицей и молча отставала от кода —
// Ctrl+X, Ctrl+S в нодах, копирование макроса и F2 по слоту работали, но нигде
// не были описаны, то есть их просто не существовало для человека (F-20).
//
// `match` — часть записи, а не отдельная ветка в обработчике: пока клавиша
// проверяется тем же объектом, который печатается в справке, разойтись им негде.

export type HotkeyGroup = 'canvas' | 'compare' | 'editor' | 'prompt' | 'nodes'

export interface HotkeyEvent {
  key: string
  code: string
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  altKey: boolean
}

export interface Hotkey {
  id: string
  group: HotkeyGroup
  // как показать в справке
  keys: string
  what: string
  // распознать событие; отсутствует у жестов мышью (их описываем, но не ловим)
  match?(e: HotkeyEvent): boolean
}

export const HOTKEY_GROUPS: Array<{ id: HotkeyGroup; title: string }> = [
  { id: 'canvas', title: 'Canvas' },
  { id: 'compare', title: 'Compare' },
  { id: 'editor', title: 'Image editor' },
  { id: 'prompt', title: 'Prompt bar' },
  { id: 'nodes', title: 'Macro editor' },
]

const mod = (e: HotkeyEvent) => e.ctrlKey || e.metaKey

// Раскладка: на русской «C» приходит как «с», а code остаётся KeyC. Ловим оба,
// плюс управляющий символ, который шлют некоторые сборки Windows.
function letter(e: HotkeyEvent, code: string, latin: string, cyrillic: string, ctrl: string): boolean {
  const k = e.key.toLowerCase()
  return e.code === code || k === latin || k === cyrillic || e.key === ctrl
}

export const HOTKEYS: Hotkey[] = [
  // ── холст ────────────────────────────────────────────────
  { id: 'canvas.marquee', group: 'canvas', keys: 'Drag on empty space', what: 'Selection marquee' },
  { id: 'canvas.addToSelection', group: 'canvas', keys: 'Shift+click / Shift+marquee', what: 'Add to selection' },
  { id: 'canvas.pan', group: 'canvas', keys: 'Space+drag / middle button', what: 'Pan canvas' },
  { id: 'canvas.zoom', group: 'canvas', keys: 'Scroll', what: 'Zoom to pointer' },
  {
    id: 'canvas.copy', group: 'canvas', keys: 'Ctrl+C', what: 'Copy objects',
    match: (e) => mod(e) && letter(e, 'KeyC', 'c', 'с', ''),
  },
  {
    id: 'canvas.cut', group: 'canvas', keys: 'Ctrl+X', what: 'Cut objects',
    match: (e) => mod(e) && letter(e, 'KeyX', 'x', 'ч', ''),
  },
  {
    id: 'canvas.paste', group: 'canvas', keys: 'Ctrl+V', what: 'Paste (from canvas or system)',
    match: (e) => mod(e) && letter(e, 'KeyV', 'v', 'м', ''),
  },
  {
    id: 'canvas.duplicate', group: 'canvas', keys: 'Ctrl+D', what: 'Duplicate objects',
    match: (e) => mod(e) && letter(e, 'KeyD', 'd', 'в', ''),
  },
  // Жест мышью: ловит его сам перенос (altDragCopy), здесь он только описан.
  { id: 'canvas.dragCopy', group: 'canvas', keys: 'Alt+drag', what: 'Copy object: keep the original in place' },
  {
    id: 'canvas.undo', group: 'canvas', keys: 'Ctrl+Z', what: 'Undo action',
    match: (e) => mod(e) && !e.shiftKey && letter(e, 'KeyZ', 'z', 'я', ''),
  },
  {
    id: 'canvas.redo', group: 'canvas', keys: 'Ctrl+Shift+Z / Ctrl+Y', what: 'Redo action',
    match: (e) =>
      (mod(e) && e.shiftKey && letter(e, 'KeyZ', 'z', 'я', '')) ||
      (mod(e) && letter(e, 'KeyY', 'y', 'н', '')),
  },
  {
    id: 'canvas.selectAll', group: 'canvas', keys: 'Ctrl+A', what: 'Select all objects',
    match: (e) => mod(e) && letter(e, 'KeyA', 'a', 'ф', ''),
  },
  {
    id: 'canvas.archive', group: 'canvas', keys: 'Shift+Delete', what: 'Move selection to board archive',
    match: (e) => e.shiftKey && !mod(e) && (e.key === 'Delete' || e.key === 'Backspace'),
  },
  {
    id: 'canvas.delete', group: 'canvas', keys: 'Delete', what: 'Delete selection',
    match: (e) => !e.shiftKey && !mod(e) && (e.key === 'Delete' || e.key === 'Backspace'),
  },
  {
    id: 'canvas.zoomToFit', group: 'canvas', keys: 'Shift+1', what: 'Show all',
    match: (e) => e.shiftKey && !mod(e) && (e.key === '!' || e.code === 'Digit1'),
  },
  {
    id: 'canvas.timeline', group: 'canvas', keys: 'T', what: 'Edit clip: trim, cuts, frame, sound',
    match: (e) => !mod(e) && !e.altKey && !e.shiftKey && letter(e, 'KeyT', 't', 'е', ''),
  },
  { id: 'canvas.mark', group: 'canvas', keys: 'Numbers 1–999 (with selection)', what: 'Export marker; 0 removes the marker' },
  { id: 'canvas.contextMenu', group: 'canvas', keys: 'Right-click', what: 'Object or canvas menu' },
  { id: 'canvas.archiveDrag', group: 'canvas', keys: 'Drag to the Archive tile', what: 'Same as Shift+Delete' },
  { id: 'canvas.video', group: 'canvas', keys: 'Second click on video', what: 'Play or pause (first click selects)' },
  { id: 'canvas.audio', group: 'canvas', keys: 'Click the audio waveform', what: 'Seek to this point' },
  { id: 'canvas.audioSeek', group: 'canvas', keys: '← → (selected audio)', what: 'Seek one second; Shift seeks ten' },

  // ── сравнение ────────────────────────────────────────────
  {
    id: 'compare.start', group: 'compare', keys: 'Q / right-click → “Compare with…”', what: 'Start a candidate set',
    match: (e) => !mod(e) && !e.altKey && !e.shiftKey && letter(e, 'KeyQ', 'q', 'й', ''),
  },
  { id: 'compare.pick', group: 'compare', keys: 'Click an object (in the set)', what: 'Add or remove from comparison' },
  { id: 'compare.open', group: 'compare', keys: 'Enter', what: 'Open the candidate comparison' },
  { id: 'compare.hold', group: 'compare', keys: 'Space — hold', what: 'Show the original while held' },
  { id: 'compare.play', group: 'compare', keys: 'Space (on video)', what: 'Play or pause all panels' },
  {
    id: 'compare.frameBack', group: 'compare', keys: 'A / Shift+A', what: 'Back one frame / 10 with Shift, paused',
    match: (e) => !mod(e) && !e.altKey && e.code === 'KeyA',
  },
  {
    id: 'compare.frameForward', group: 'compare', keys: 'D / Shift+D', what: 'Forward one frame / 10 with Shift, paused',
    match: (e) => !mod(e) && !e.altKey && e.code === 'KeyD',
  },
  { id: 'compare.cycle', group: 'compare', keys: '← →', what: 'Cycle candidates' },
  { id: 'compare.zoom', group: 'compare', keys: 'Double-click a frame', what: 'Zoom to 100%; click again to fit' },
  { id: 'compare.mark', group: 'compare', keys: 'Numbers 1–9', what: 'Mark the winner' },
  { id: 'compare.archive', group: 'compare', keys: 'Delete', what: 'Archive candidate (Ctrl+Z restores)' },
  { id: 'compare.exit', group: 'compare', keys: 'Esc', what: 'Exit the set or comparison' },

  // ── внешний редактор картинок ────────────────────────────
  { id: 'editor.open', group: 'editor', keys: 'F2', what: 'Open image in external editor' },
  { id: 'editor.fillPrompt', group: 'editor', keys: 'Double-click an image', what: 'Use its prompt and references' },
  { id: 'editor.sketch', group: 'editor', keys: '✏ in object menu', what: 'Draw over image' },
  { id: 'editor.crop', group: 'editor', keys: '⛶ in object menu', what: 'Crop' },
  { id: 'editor.sketchDone', group: 'editor', keys: 'Esc (in sketch)', what: 'Discard drawing and exit; use Apply to save' },
  { id: 'editor.cropApply', group: 'editor', keys: 'Enter (in crop)', what: 'Apply crop' },

  // ── панель промпта ───────────────────────────────────────
  {
    id: 'prompt.collapse', group: 'prompt', keys: 'S', what: 'Collapse or expand the prompt bar (outside text fields)',
    match: (e) => !mod(e) && !e.altKey && !e.shiftKey && letter(e, 'KeyS', 's', 'ы', ''),
  },
  { id: 'prompt.submit', group: 'prompt', keys: 'Shift+Enter / Ctrl+Enter', what: 'Generate in Prompt; send in Assistant' },
  { id: 'prompt.ask', group: 'prompt', keys: 'Alt+Enter', what: 'Ask the assistant from any tab' },
  { id: 'prompt.tabs', group: 'prompt', keys: '“Prompt” / “Assistant” tabs', what: 'Switch panel; dot starts a new reply' },
  { id: 'prompt.macroRun', group: 'prompt', keys: 'Click a macro button', what: 'Run on selection; click repeatedly for batches' },
  { id: 'prompt.macroEdit', group: 'prompt', keys: 'Right-click a macro / F2', what: 'Open macro editor' },
  { id: 'prompt.macroCopy', group: 'prompt', keys: 'Ctrl+C / Ctrl+V (macro focused)', what: 'Copy and paste macro' },
  { id: 'prompt.macroLibrary', group: 'prompt', keys: '⋯ at row end', what: 'All macros: names, order, delete' },
  { id: 'prompt.ref', group: 'prompt', keys: 'Click a canvas object', what: 'Make it a reference' },
  { id: 'prompt.refTag', group: 'prompt', keys: 'Left-click a thumbnail', what: 'Insert an @n reference tag' },
  { id: 'prompt.refRemove', group: 'prompt', keys: 'Right-click a thumbnail', what: 'Remove from references' },
  { id: 'prompt.textUndo', group: 'prompt', keys: 'Ctrl+Z / Ctrl+Y (in field)', what: 'Undo or redo text' },

  // ── редактор макросов ────────────────────────────────────
  { id: 'nodes.addMenu', group: 'nodes', keys: 'Ctrl+Space / right-click canvas', what: 'Add node menu' },
  {
    id: 'nodes.save', group: 'nodes', keys: 'Ctrl+S', what: 'Save macro',
    match: (e) => mod(e) && letter(e, 'KeyS', 's', 'ы', ''),
  },
  { id: 'nodes.copy', group: 'nodes', keys: 'Ctrl+C / Ctrl+V / Ctrl+D', what: 'Copy, paste, duplicate nodes' },
  { id: 'nodes.undo', group: 'nodes', keys: 'Ctrl+Z / Ctrl+Y', what: 'Undo or redo step' },
  { id: 'nodes.selectAll', group: 'nodes', keys: 'Ctrl+A', what: 'Select all nodes' },
  { id: 'nodes.delete', group: 'nodes', keys: 'Delete', what: 'Delete selected nodes' },
  { id: 'nodes.cutEdge', group: 'nodes', keys: 'Double-click a wire', what: 'Break connection' },
]

const byId = new Map(HOTKEYS.map((hotkey) => [hotkey.id, hotkey]))

export function hotkey(id: string): Hotkey {
  const found = byId.get(id)
  if (!found) throw new Error(`Hotkey “${id}” is not defined in the registry`)
  return found
}

// Совпало ли событие с записью реестра. Обработчики зовут ТОЛЬКО это.
export function hits(id: string, e: HotkeyEvent): boolean {
  const found = hotkey(id)
  return Boolean(found.match?.(e))
}

export function hotkeysOfGroup(group: HotkeyGroup): Hotkey[] {
  return HOTKEYS.filter((item) => item.group === group)
}

export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false
  const nav = navigator as { userAgentData?: { platform?: string }; platform?: string }
  const platform = nav.userAgentData?.platform || nav.platform || ''
  return /Mac|iPhone|iPad|iPod/i.test(platform)
}

export function formatHotkeyKeys(keys: string, mac: boolean = isMacPlatform()): string {
  if (!mac) return keys
  return keys
    .replace(/\bCtrl\+/g, '⌘')
    .replace(/\bAlt\+/g, '⌥')
}
