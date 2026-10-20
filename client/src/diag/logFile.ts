import { dumpLogText } from './log.js'

function stamp(): string {
  const now = new Date()
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
    + `-${pad(now.getHours())}${pad(now.getMinutes())}`
}

/**
 * Журнал файлом. Человеку нужен не «посмотрите в консоль» (в неё никто не
 * смотрит и на планшете её нет вовсе), а файл, который можно приложить к
 * жалобе.
 */
export function downloadLogFile(header: Record<string, unknown> = {}): string {
  const name = `canai-log-${stamp()}.txt`
  downloadTextFile(name, dumpLogText(header), 'text/plain;charset=utf-8')
  return name
}

/** Отдать текст файлом — журнал, отчёт о проблеме (5.9). */
export function downloadTextFile(name: string, text: string, type: string): void {
  const blob = new Blob([text], { type })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

export async function copyLogText(header: Record<string, unknown> = {}): Promise<boolean> {
  const { copyText } = await import('../ui/ids.js')
  return copyText(dumpLogText(header))
}
