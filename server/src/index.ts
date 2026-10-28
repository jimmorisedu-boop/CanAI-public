import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import express from 'express'
import { initGenerationTransport } from './generationAvailability.js'
import { config, serverRootDir } from './config.js'
import { componentInventory, missingComponentsLine } from './components.js'
import { gcMedia } from './gc.js'
import { generationGate } from './generationGate.js'
import { installCrashHandlers, logError, logNote } from './log.js'
import { buildInfo, formatBuildLine } from './buildInfo.js'
import { installExitNotes, startLifeSigns } from './lifeSigns.js'
import { startPresenceWarmup } from './boardPresence.js'
import { markUiOpened, uiOpened } from './uiOpened.js'
import { applyProxyDispatcher } from './proxyDispatcher.js'
import { jobs } from './jobs.js'
import { LifecycleManager } from './lifecycle.js'
import { attachMediaRoutes } from './mediaRoute.js'
import { restoreMacroRuns } from './macroRuns.js'
import { startRemoteServer, stopRemoteServer } from './remoteRuntime.js'
import { boardMediaFiles, ensureProjects, listProjects } from './projects.js'
import { onboarding } from './onboarding.js'
import { apiRouter, attachDesktopUpdates, attachLifecycle, mediaImportManager } from './routes.js'
import { restoreJobs } from './runner.js'
import { ensureMediaDir } from './storage.js'
import { sortMediaByBoards } from './mediaLayout.js'
import { catalogLibrary, applyCatalogLibrary } from './catalogLibrary.js'
import { loadSettings } from './settings.js'
import { agentHost, startAgentRuntime } from './agents/runtime.js'
import { createDesktopUpdateService } from './desktopUpdate.js'

// GC повторяется раз в 6 часов, но трогает только файлы старше суток:
// свежий результат, ещё не легший на холст (заглушка крутится, доска закрыта),
// удалять нельзя — это оплаченная генерация
const GC_EVERY_MS = 6 * 60 * 60 * 1000
const GC_MIN_AGE_MS = 24 * 60 * 60 * 1000
// Столько ждём браузер, прежде чем назвать адрес словами: холодный запуск
// Chrome с выбором профиля укладывается в этот срок, а лаунчер успевает
// сделать вторую попытку.
const UI_NOTICE_MS = 30_000

async function main(): Promise<void> {
  installCrashHandlers()
  const desktopUpdates = createDesktopUpdateService()
  // ⚠️ Журнал молчал ровно там, где был нужен: приложение «вылетало», а
  // записи о падении не было ни одной. Отметка жизни показывает ТОЧНОЕ время
  // последнего вздоха и как росла память перед ним, строка «остановлен» —
  // что ушло по-людски (см. lifeSigns.ts).
  installExitNotes()
  // Какая сборка запущена — ПЕРВОЙ строкой каждого запуска (пункт 5.1): разбор
  // жалобы иначе начинается с угадывания, обновился ли человек вообще.
  // logNote печатает и в консоль, и в журнал — второй печати не нужно.
  logNote('build', formatBuildLine(buildInfo()))
  // До восстановления задач: они сразу начнут доставлять готовое на доски.
  startPresenceWarmup()
  startLifeSigns({ activeJobs: () => jobs.liveCount() })
  const legacySettings = await loadSettings().catch(() => null)
  await catalogLibrary.load(legacySettings?.assistantModelId)
  applyCatalogLibrary()
  // Прокси — ДО первых запросов: иначе вход в команду успеет уйти напрямую.
  const proxy = applyProxyDispatcher()
  if (proxy) console.log(`[CanAI] outbound requests through proxy ${proxy}`)
  await ensureMediaDir()
  // миграция: перенести старый одиночный project.json в первую доску
  const hasInitialProjects = (await listProjects()).length > 0 || fs.existsSync(config.projectFile)
  await onboarding.load(hasInitialProjects).catch((error) => {
    logError('Could not initialize onboarding', error)
  })
  await ensureProjects()
  await startAgentRuntime()
  // Раскладка media по доскам: чтобы материал доски можно было найти руками.
  // Ссылки при этом не меняются — где лежит файл, помнит индекс (mediaLayout).
  // ПОСЛЕ ensureProjects: та переносит легаси-холст в первую доску, и до неё
  // список досок был бы пуст, а весь материал уехал бы в «общее».
  const sorted = await sortMediaByBoards({ root: config.mediaDir, boards: await boardMediaFiles() })
  if (sorted.moved > 0) console.log(`[CanAI] media: distributed across boards ${sorted.moved} files`)
  if (sorted.skipped > 0) console.warn(`[CanAI] media: ${sorted.skipped} files not moved (occupied name or file holds another program)`)
  await mediaImportManager.recoverInterrupted()

  // Recover jobs before media GC. A valid jobs backup can contain the only
  // durable reference to a paid result or an ambiguous in-flight request;
  // GC must see that recovered snapshot before deciding which media is unused.
  const recoveredJobs = await restoreJobs()
  if (recoveredJobs.restored > 0 || recoveredJobs.failed > 0) {
    console.log(`[CanAI] jobs after restart: resumed ${recoveredJobs.restored}, retries required ${recoveredJobs.failed}`)
  }

  // Сначала безопасно завершаем GC, затем открываем API. Даже на старте щадим
  // свежие файлы: они могли появиться перед аварийным завершением до autosave.
  const startupGc = await gcMedia(GC_MIN_AGE_MS)
  if (startupGc.removed > 0) console.log(`[CanAI] GC: removed ${startupGc.removed} unused media files`)
  // Опись портативных компонентов: одна строка в логе, если чего-то нет.
  // Ничего не качает — это ответ на вопрос «почему у него не работает» без
  // переписки, а кнопки живут в настройках.
  const missing = missingComponentsLine(await componentInventory())
  if (missing) console.log(`[CanAI] ${missing}`)
  setInterval(() => {
    gcMedia(GC_MIN_AGE_MS)
      .then(({ removed }) => removed > 0 && console.log(`[CanAI] GC: removed ${removed} media files (scheduled)`))
      .catch((err) => logError('gc', err))
  }, GC_EVERY_MS).unref()

  await restoreMacroRuns()

  const app = express()
  app.use((req, res, next) => {
    const rawHost = String(req.headers.host ?? '').toLowerCase()
    // [::1]:8787 — валидный loopback; наивный split(':')[0] превращал его в '['
    const hostname = rawHost.startsWith('[')
      ? rawHost.slice(1, rawHost.indexOf(']'))
      : rawHost.split(':')[0]
    if (hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '::1') {
      return res.status(403).json({ error: 'Invalid Host' })
    }
    const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(req.method)
    const origin = req.headers.origin
    if (unsafe && origin) {
      try {
        const parsed = new URL(origin)
        if (parsed.protocol !== 'http:' || (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost' && parsed.hostname !== '::1')) {
          return res.status(403).json({ error: 'Invalid Origin' })
        }
      } catch {
        return res.status(403).json({ error: 'Invalid Origin' })
      }
    }
    next()
  })
  // лимит большой: в снапшот холста могут попасть перетащенные картинки в base64
  app.use(express.json({ limit: '50mb' }))
  // Медиа раздаёт общий модуль: тот же обработчик нужен планшетному
  // серверу, и расходиться этим двум копиям нельзя.
  attachMediaRoutes(app)
  app.use('/api', apiRouter)

  // прод-режим: собранный клиент (client/dist) раздаёт сам Express — один
  // процесс, один порт, без vite. В dev папки dist может не быть — тогда
  // клиент живёт на :5173 (vite) и проксирует /api сюда, как раньше.
  const clientDist = path.resolve(serverRootDir, '..', 'client', 'dist')
  const hasDist = fs.existsSync(path.join(clientDist, 'index.html'))
  if (hasDist) {
    // ⚠️ Отмечаем, что за страницей интерфейса кто-то пришёл: лаунчер иначе
    // просто ВЕРИТ, что открытый им адрес браузер открыл. Chrome с несколькими
    // профилями показывает выбор профиля и адрес при этом теряет — приложение
    // работает, а человек смотрит на чужой экран (см. uiOpened.ts).
    app.get(['/', '/index.html'], (_req, _res, next) => {
      markUiOpened()
      next()
    })
    app.use(express.static(clientDist))
  }

  // строго loopback: API умеет запускать программы (edit-sessions) и тратить ключ fal —
  // из локальной сети (Wi-Fi кафе, офис) он никому виден быть не должен
  const lifecycle = new LifecycleManager(config.runtimeControlFile, config.port)
  const server = http.createServer(app)
  const shutdown = async (): Promise<void> => {
    generationGate.close()
    await generationGate.waitForDrained()
    try {
      await mediaImportManager.dispose()
    } catch (error) {
      logError('shutdown-media-imports', error)
    }
    try {
      await jobs.persistNow()
    } catch (error) {
      logError('shutdown-jobs', error)
    }
    try {
    } catch (error) {
      logError('shutdown-share-funnel', error)
    }
    try {
      await stopRemoteServer()
    } catch (error) {
      logError('shutdown-remote-server', error)
    }
    try {
    } catch (error) {
    }
    try {
    } catch (error) {
    }
    try {
    } catch (error) {
    }
    try {
      await agentHost.close()
    } catch (error) {
      logError('shutdown-agent-host', error)
    }

    // Force only a stuck HTTP drain. Never interrupt the critical section
    // that persists a paid fal requestId: launcher will time out safely
    // instead of risking a duplicated or lost paid request.
    const forceTimer = setTimeout(() => {
      void lifecycle.removeControlIfOwned().finally(() => process.exit(0))
    }, 5_000)
    forceTimer.unref()

    const closed = new Promise<void>((resolve) => {
      server.close(() => resolve())
    })
    server.closeIdleConnections()
    await closed
    await lifecycle.removeControlIfOwned()
    clearTimeout(forceTimer)
    process.exit(0)
  }
  attachLifecycle(lifecycle, shutdown)
  desktopUpdates.attachRuntime({
    port: config.port,
    requestShutdown: () => {
      generationGate.close()
      lifecycle.beginShutdown(shutdown)
    },
  })
  attachDesktopUpdates(desktopUpdates)

  await new Promise<void>((resolve, reject) => {
    const onStartupError = (error: Error) => reject(error)
    server.once('error', onStartupError)
    server.listen(config.port, '127.0.0.1', () => {
      server.off('error', onStartupError)
      resolve()
    })
  })
  server.on('error', (error) => logError('http-server', error))
  // Планшетный слушатель. Пока доступ по сети выключен, он живёт на
  // 127.0.0.1: снаружи его нет, но с самого компьютера страница открывается.
  void startRemoteServer().then((state) => {
    if (state.error) console.log(`[CanAI] tablet access did not start: ${state.error}`)
    else if (state.lan) console.log(`[CanAI] tablet: ${state.addresses.join(', ') || `port ${state.port}`}`)
  })

  try {
    await lifecycle.publish()
  } catch (error) {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    throw error
  }

  // Копия сетевых досок на этом компьютере (6.2): первый проход — через
  // минуту после запуска, дальше раз в полчаса, и никогда поверх работы
  // человека с сетевыми досками (см. cloudMirror.ts).

  const mode = config.mockMode
    ? 'demo mode (CANAI_MOCK=1)'
    : config.falKey
      ? 'fal.ai key OK'
        : 'generation unavailable (fal.ai key is not set)'
  const ui = hasDist ? ` — UI: http://127.0.0.1:${config.port}` : ''
  console.log(`[CanAI] server: http://127.0.0.1:${config.port} — ${mode}${ui}`)

  // ⚠️ Приложение, которое работает, но которого не видно, читается как
  // сломанное. Лаунчер открывает адрес и ВЕРИТ, что браузер по нему пришёл, а
  // Chrome с несколькими профилями встречает холодный запуск экраном «Who's
  // using Chrome?» и адрес при этом теряет: порт слушает, доски на месте, а
  // человек смотрит на выбор профиля («канвас не открылся после обновления
  // сам», 09.09.2026). Сказать про это может только тот, кто видит, приходил
  // ли кто-нибудь за страницей, — то есть сервер.
  //
  // Пишем в ТО ЖЕ окно, где человек уже читает наши строки. В режиме
  // разработки молчим: страницу там раздаёт vite, и за нашей никто не придёт
  // никогда.
  if (hasDist) {
    setTimeout(() => {
      if (uiOpened()) return
      console.log('')
      console.log(`[CanAI] Browser did not open the app. Open: http://127.0.0.1:${config.port}`)
      console.log('[CanAI] This can happen when the browser asks which profile to use at launch.')
    }, UI_NOTICE_MS).unref()
  }
}

main().catch((err) => {
  logError('startup', err)
  process.exit(1)
})
