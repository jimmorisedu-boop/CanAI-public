import http from 'node:http'
import { config } from './config.js'
import { logError } from './log.js'
import { loadRemoteAccess } from './remoteAccess.js'
import { createRemoteApp } from './remoteApp.js'
import { localNetworkInterfaces } from './shareLan.js'

// Жизнь планшетного слушателя.
//
// Пока доступ по сети выключен, он всё равно поднимается — но только на
// 127.0.0.1: так его видно из браузера на самом компьютере (это удобно и для
// проверки), и при этом снаружи его нет вовсе.

let server: http.Server | null = null
let listening = false
let failure: string | null = null

export interface RemoteServerState {
  running: boolean
  /** Слушает ли на всех интерфейсах (то есть доступен ли с планшета). */
  lan: boolean
  port: number
  addresses: string[]
  /** То же самое, но с именем подключения: по нему человек узнаёт своё
   *  Wi-Fi среди виртуальных адаптеров. Поле новое — старый клиент
   *  по-прежнему читает addresses. */
  links?: Array<{ url: string; name: string; virtual: boolean }>
  /** Система компьютера. Нужна ровно за одним: на Windows входящие
   *  подключения по умолчанию режет брандмауэр, и об этом надо сказать
   *  ЗАРАНЕЕ — иначе человек ищет причину в планшете, которой там нет. */
  platform?: NodeJS.Platform
  error: string | null
}

export function remoteServerState(lan: boolean): RemoteServerState {
  return {
    running: listening,
    lan,
    port: config.remotePort,
    addresses: lan ? localNetworkInterfaces().map((entry) => `http://${entry.address}:${config.remotePort}`) : [],
    links: lan
      ? localNetworkInterfaces().map((entry) => ({
        url: `http://${entry.address}:${config.remotePort}`,
        name: entry.name,
        virtual: entry.virtual,
      }))
      : [],
    error: failure,
    platform: process.platform,
  }
}

async function close(): Promise<void> {
  const current = server
  server = null
  listening = false
  if (!current) return
  await new Promise<void>((resolve) => current.close(() => resolve()))
}

export async function startRemoteServer(): Promise<RemoteServerState> {
  await close()
  const state = await loadRemoteAccess()
  const host = state.enabled ? '0.0.0.0' : '127.0.0.1'
  failure = null
  const next = http.createServer(createRemoteApp())
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error)
      next.once('error', onError)
      next.listen(config.remotePort, host, () => {
        next.off('error', onError)
        resolve()
      })
    })
    server = next
    listening = true
    next.on('error', (error) => logError('remote-http-server', error))
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code
    failure = code === 'EADDRINUSE'
      ? `Port ${config.remotePort} busy with another program`
      : error instanceof Error ? error.message : 'Unknown error'
    logError('remote-http-server-startup', error)
  }
  return remoteServerState(state.enabled)
}

export async function stopRemoteServer(): Promise<void> {
  await close()
}
