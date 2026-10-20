import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import { proxyForUrl } from './proxyConfig.js'

/**
 * Туннель к серверу команды через обычный HTTP-прокси.
 *
 * ⚠️ Нужен ради WebSocket доски: библиотека сокетов о переменных окружения не
 * знает вовсе, её соединение уходило напрямую и умирало там же, где обычные
 * запросы. Снаружи это выглядело как «Только просмотр — нет связи с сервером
 * команды».
 *
 * ⚠️ Прежнее пояснение здесь утверждало, будто `fetch` разбирается с прокси
 * сам, — это НЕВЕРНО: Node его переменные не читает. Обычные запросы уводит
 * через прокси `applyProxyDispatcher` при старте (`proxyDispatcher.ts`), и без
 * него получалось наполовину рабочее состояние: сокет через прокси, а вход в
 * команду и генерация — напрямую.
 *
 * ⚠️ Своими руками, без зависимости: нужен ровно один метод CONNECT, а тянуть
 * ради него пакет в продаваемое приложение незачем — тот же довод, что у
 * своего читателя ZIP для ffmpeg.
 */

const CONNECT_TIMEOUT_MS = 10_000

function tunnel(proxy: URL, host: string, port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const request = (proxy.protocol === 'https:' ? https : http).request({
      host: proxy.hostname,
      port: Number(proxy.port) || (proxy.protocol === 'https:' ? 443 : 80),
      method: 'CONNECT',
      path: `${host}:${port}`,
      timeout: CONNECT_TIMEOUT_MS,
      headers: {
        host: `${host}:${port}`,
        ...(proxy.username
          ? {
            'proxy-authorization': `Basic ${Buffer.from(
              `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`,
            ).toString('base64')}`,
          }
          : {}),
      },
    })
    const fail = (error: Error): void => {
      request.destroy()
      reject(error)
    }
    request.once('connect', (response, socket: net.Socket) => {
      if (response.statusCode !== 200) {
        socket.destroy()
        // Код прокси несём в тексте: «не удалось подключиться» без него
        // одинаково выглядит и при запрете, и при опечатке в адресе.
        fail(new Error(`Proxy refused the connection: ${response.statusCode}`))
        return
      }
      socket.setTimeout(0)
      resolve(socket)
    })
    request.once('timeout', () => fail(new Error('The proxy did not respond in time')))
    request.once('error', fail)
    request.end()
  })
}

type ConnectCallback = (error: Error | null, socket?: net.Socket) => void
interface ConnectOptions { host?: string; port?: number | string; servername?: string }

/**
 * Агент для `ws`. Возвращает undefined, когда прокси не нужен, — тогда вызов
 * остаётся ровно таким, каким был.
 */
export function proxyAgentFor(target: string, env = process.env): http.Agent | undefined {
  const proxyUrl = proxyForUrl(target, env)
  if (!proxyUrl) return undefined
  const proxy = new URL(proxyUrl)
  const destination = new URL(target)
  const secure = destination.protocol === 'wss:' || destination.protocol === 'https:'
  const agent = new (secure ? https.Agent : http.Agent)({ keepAlive: false })
  const connect = (options: ConnectOptions, callback: ConnectCallback): void => {
    const host = options.host ?? destination.hostname
    const port = Number(options.port) || (secure ? 443 : 80)
    tunnel(proxy, host, port).then((socket) => {
      if (!secure) {
        callback(null, socket)
        return
      }
      // Шифрование поверх туннеля поднимаем сами: прокси видит только адрес,
      // а не содержимое — иначе смысл https терялся бы.
      const secured = tls.connect({ socket, servername: options.servername ?? host })
      secured.once('error', (error: Error) => callback(error))
      secured.once('secureConnect', () => callback(null, secured as unknown as net.Socket))
    }, (error: Error) => callback(error))
  }
  ;(agent as unknown as { createConnection: typeof connect }).createConnection = connect
  return agent
}
