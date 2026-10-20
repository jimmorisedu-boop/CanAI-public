import { execFile } from 'node:child_process'
import os from 'node:os'

/**
 * Родной диалог выбора файла. Ровно одна машинерия на все места, где человек
 * что-то выбирает с диска: программу для F2 и файл cookies для импорта по
 * ссылке. Две копии этого кода разъехались бы при первой правке одной, а
 * различаются они только фильтром и подсказкой.
 */
export type PickTarget = 'application' | 'cookies'

export class FilePickError extends Error {
  readonly status: number

  constructor(message: string, status = 400) {
    super(message)
    this.name = 'FilePickError'
    this.status = status
  }
}

interface PickerCommand {
  command: string
  args: string[]
}

const WINDOWS_FILTER: Record<PickTarget, string> = {
  application: 'Programs (*.exe)|*.exe',
  // Файл cookies выгружают расширением, и расширение у него бывает разное —
  // поэтому «Все файлы» стоят рядом, а не вместо.
  cookies: 'Files cookies (*.txt)|*.txt|All files (*.*)|*.*',
}

const MAC_PROMPT: Record<PickTarget, string> = {
  application: 'POSIX path (choose the application as an alias)',
  cookies: 'POSIX path (choose the cookie file when prompted)',
}

/** Что именно запускаем. Отдельной чистой функцией — чтобы её проверял тест,
 *  а не глаза: фильтр и кавычки в скрипте PowerShell ломаются молча. */
export function pickerCommand(target: PickTarget, platform: NodeJS.Platform): PickerCommand {
  if (platform === 'darwin') return { command: 'osascript', args: ['-e', MAC_PROMPT[target]] }
  if (platform === 'win32') {
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '$dialog = New-Object System.Windows.Forms.OpenFileDialog',
      `$dialog.Filter = '${WINDOWS_FILTER[target]}'`,
      'if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dialog.FileName }',
    ].join('; ')
    return { command: 'powershell.exe', args: ['-NoProfile', '-STA', '-Command', script] }
  }
  throw new FilePickError('The file picker is unavailable; provide the path manually')
}

/** Человек ничего не выбрал — это отмена, а не поломка. */
export function nothingPickedMessage(target: PickTarget): string {
  return target === 'application' ? 'Program not selected' : 'File not selected'
}

export function pickFilePath(target: PickTarget, platform: NodeJS.Platform = os.platform()): Promise<string> {
  const { command, args } = pickerCommand(target, platform)
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      // Диалог ждёт человека, поэтому таймаут щедрый.
      { timeout: 300_000, maxBuffer: 1_000_000, windowsHide: true },
      (error, stdout) => {
        const selected = stdout.trim()
        if (selected) return resolve(selected)
        // На маке отмена приходит ошибкой osascript — это тоже «не выбрал».
        if (error && platform === 'win32') {
          return reject(new FilePickError('Could not open the file picker', 500))
        }
        reject(new FilePickError(nothingPickedMessage(target)))
      },
    )
  })
}
