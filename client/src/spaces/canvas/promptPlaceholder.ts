// Подсказка в пустом поле — единственное место, где приложение объясняет, что
// сейчас произойдёт с нажатием Enter. Правило вынесено из разметки: там оно
// было лесенкой из шести вложенных тернарников, и порядок веток (кто кого
// перебивает) читался с трудом, хотя именно он и есть смысл.
//
// Порядок ветвей — от самого частного к общему: скетч и референсы говорят о
// поле больше, чем общее «опиши, что сгенерировать».
export function promptPlaceholder(state: {
  chatOpen: boolean
  sketchTarget: string | null
  textRefCount: number
  mediaRefCount: number
}): string {
  if (state.chatOpen) {
    return "Message assistant…"
  }
  if (state.sketchTarget) {
    return "Describe the edit — the sketched image will be sent to generation… (Shift+Enter)"
  }
  if (state.textRefCount > 0) {
    return "You can leave this empty to use selected text, or start a sentence for the assistant to continue…"
  }
  if (state.mediaRefCount > 0) {
    return "Describe what to do with references… use @ to reference one (Shift+Enter)"
  }
  return "Describe what to generate… (Shift+Enter — run)"
}
