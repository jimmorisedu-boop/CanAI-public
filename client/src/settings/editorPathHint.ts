// Как объяснить, что вписывать в поле пути к программе. Отдельно от компонента,
// чтобы формулировки проверялись тестом, а не глазами в модалке.
//
// ⚠️ Подсказка обязана зависеть от системы. Пока она была одна и виндовая
// («C:\Program Files\…\Photoshop.exe»), маковский пользователь не догадывался
// ни где искать программу, ни что указывать надо бандл «.app».

export interface EditorPathHint {
  placeholder: string
  /** Пояснение под полем; null — объяснять нечего. */
  note: string | null
  /** Есть ли кнопка выбора программы и как она подписана. */
  browse: string | null
}

export function editorPathHint(platform: string | undefined): EditorPathHint {
  if (platform === 'darwin') {
    return {
      placeholder: '/Applications/Adobe Photoshop 2025/Adobe Photoshop 2025.app',
      note: 'Select the app itself — the “.app” folder. You do not need to choose its internals; the app finds them.',
      browse: 'Choose app',
    }
  }
  if (platform && platform !== 'win32') {
    // Диалога выбора здесь нет, поэтому и обещать кнопку нельзя.
    return {
      placeholder: '/usr/bin/gimp',
      note: 'Select the full path to the program executable.',
      browse: null,
    }
  }
  // Windows и неизвестная (старый сервер не присылал поле) — как было.
  return {
    placeholder: 'C:\\Program Files\\Adobe\\Adobe Photoshop 2025\\Photoshop.exe',
    note: null,
    browse: 'Choose app',
  }
}
