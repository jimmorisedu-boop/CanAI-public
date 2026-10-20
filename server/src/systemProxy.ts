import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

/**
 * Прокси, который система считает текущим.
 *
 * ⚠️ Это главный признак того, КАК сейчас устроена сеть у человека. Клиенты
 * VPN, которыми пользуются в России (v2rayN, Clash, Nekoray), поднимают у себя
 * локальный HTTP-прокси и прописывают его системе — по нему ходит браузер.
 * Приложение раньше читало эту настройку только в лаунчере, при запуске: стоило
 * человеку переключить VPN на ходу, и оно продолжало ломиться по старому пути.
 * Поэтому читаем ЖИВЬЁМ, каждый раз, когда выбираем дорогу до сервера команды.
 */

/** Windows: `reg query` по ключу настроек интернета. */
export function parseWindowsProxy(output: string): string | null {
  const enabled = /ProxyEnable\s+REG_DWORD\s+0x([0-9a-f]+)/iu.exec(output)
  if (!enabled || Number.parseInt(enabled[1], 16) === 0) return null
  const server = /ProxyServer\s+REG_SZ\s+(.+)/iu.exec(output)?.[1]?.trim()
  if (!server) return null
  // В строке бывает список по протоколам: «ftp=…;http=…;https=…». Берём то,
  // чем ходят к серверу команды, — https, иначе http.
  if (server.includes('=')) {
    const map = new Map(server.split(';').map((part) => {
      const [name, value] = part.split('=')
      return [name?.trim().toLowerCase() ?? '', value?.trim() ?? '']
    }))
    return map.get('https') || map.get('http') || null
  }
  return server
}

/** Первый HTTP CONNECT proxy из PAC. Сам PAC не исполняем: выбираемый адрес
 * всё равно проходит живой health probe, поэтому ложный кандидат не победит. */
export function parsePacProxy(script: string): string | null {
  const match = /\b(?:PROXY|HTTPS)\s+([A-Za-z0-9._-]+:\d{1,5})\b/iu.exec(script)
  return match?.[1] ? `http://${match[1]}` : null
}

function windowsAutoConfigUrl(output: string): string | null {
  const value = /AutoConfigURL\s+REG_SZ\s+(.+)/iu.exec(output)?.[1]?.trim()
  if (!value) return null
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null
  } catch { return null }
}

/** macOS: `scutil --proxy`. */
export function parseMacProxy(output: string): string | null {
  const value = (name: string): string | null => (
    new RegExp(`^\\s*${name}\\s*:\\s*(\\S+)`, 'mu').exec(output)?.[1] ?? null
  )
  for (const [flag, host, port] of [
    ['HTTPSEnable', 'HTTPSProxy', 'HTTPSPort'],
    ['HTTPEnable', 'HTTPProxy', 'HTTPPort'],
  ] as const) {
    if (value(flag) !== '1') continue
    const address = value(host)
    const number = value(port)
    if (address && number) return `http://${address}:${number}`
  }
  return null
}

type Runner = (file: string, args: string[]) => Promise<string>

const defaultRunner: Runner = async (file, args) => (
  (await run(file, args, { timeout: 4000, windowsHide: true })).stdout
)

export async function readSystemProxy(
  platform: NodeJS.Platform = process.platform,
  runner: Runner = defaultRunner,
): Promise<string | null> {
  try {
    if (platform === 'win32') {
      const key = String.raw`HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings`
      const output = await runner('reg', ['query', key])
      const fixed = parseWindowsProxy(output)
      if (fixed) return fixed
      const pacUrl = windowsAutoConfigUrl(output)
      if (!pacUrl) return null
      try {
        const response = await fetch(pacUrl, { signal: AbortSignal.timeout(4_000) })
        if (!response.ok) return null
        const script = await response.text()
        return script.length <= 1024 * 1024 ? parsePacProxy(script) : null
      } catch { return null }
    }
    if (platform === 'darwin') return parseMacProxy(await runner('scutil', ['--proxy']))
    return null
  } catch {
    // Настройка недоступна — это не беда: путь выберут остальные кандидаты.
    return null
  }
}
