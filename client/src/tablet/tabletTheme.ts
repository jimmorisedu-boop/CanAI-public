// Тема оформления планшета.
//
// Своя, а не общая с компьютером: планшет часто в руках при другом свете, и
// навязывать ему выбор, сделанный за столом, незачем. Ключ хранения тот же
// (`canai-theme`), но живёт он в хранилище САМОГО устройства — а оно у каждого
// своё, так что настройки не пересекаются.

export type TabletTheme = 'light' | 'dark' | 'system'

const KEY = 'canai-theme'

export function nextTheme(theme: TabletTheme): TabletTheme {
  return theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system'
}

export function readTheme(): TabletTheme {
  try {
    const saved = window.localStorage.getItem(KEY)
    if (saved === 'light' || saved === 'dark' || saved === 'system') return saved
  } catch {
    // Приватный режим: тема просто не запомнится, экран из-за этого падать не должен.
  }
  return 'dark'
}

export function applyTheme(theme: TabletTheme): void {
  const root = document.documentElement
  if (theme === 'system') {
    // «Как в системе» — это ОТСУТСТВИЕ отметки: тогда палитру выбирает
    // prefers-color-scheme, а не мы (то же правило, что у общих токенов).
    root.removeAttribute('data-theme')
  } else {
    root.setAttribute('data-theme', theme)
  }
  try {
    window.localStorage.setItem(KEY, theme)
  } catch {
    // см. выше
  }
}
