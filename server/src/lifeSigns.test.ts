import assert from 'node:assert/strict'
import test from 'node:test'
import { keepsRunning, lifeSignLine, signalExitCode, signalReason, startLifeSigns } from './lifeSigns.js'

const memory = (rssMb: number, heapMb: number): NodeJS.MemoryUsage => ({
  rss: rssMb * 1024 * 1024,
  heapTotal: heapMb * 1024 * 1024,
  heapUsed: heapMb * 1024 * 1024,
  external: 0,
  arrayBuffers: 0,
})

/**
 * ⚠️ Отметка жизни нужна не «для полноты», а ради двух смертей, которые иначе
 * не оставляют следа: зависания (процесс жив, писать некому) и нехватки
 * памяти. По ней видно ТОЧНОЕ время последнего вздоха и как росла память
 * перед ним. Жалоба 19–20.09.2026: «постоянно вылетает», а в журнале об этом
 * ни одной строки.
 */
test('в отметке есть время жизни, память и занятость', () => {
  const line = lifeSignLine({
    startedAt: 0,
    now: 2 * 3600_000 + 13 * 60_000,
    memory: memory(412, 190),
    activeJobs: 3,
  })
  assert.equal(line, 'alive 2h 13m, memory 412 MB (heap 190 MB), active jobs 3')
  // До часа часы не пишем — строка и так узкая.
  assert.match(lifeSignLine({ startedAt: 0, now: 7 * 60_000, memory: memory(100, 50), activeJobs: 0 }), /^alive 7m,/u)
})

test('отметка идёт редко и не держит процесс', () => {
  const notes: string[] = []
  let tick: (() => void) | null = null
  let delay = 0
  let unreffed = false
  startLifeSigns({
    now: () => 0,
    memory: () => memory(10, 5),
    activeJobs: () => 1,
    note: (_scope, message) => notes.push(message),
    setTimer: (callback, delayMs) => {
      tick = callback
      delay = delayMs
      return { unref: () => { unreffed = true } }
    },
  })
  // ⚠️ Раз в пять минут: чаще нельзя — журнал живёт до мегабайта и ротацией
  // вытеснит то, ради чего заведён.
  assert.equal(delay, 5 * 60_000)
  assert.equal(unreffed, true, 'таймер не должен мешать серверу завершиться')
  assert.equal(notes.length, 0, 'до первого тика тишина')
  tick!()
  assert.equal(notes.length, 1)
  assert.match(notes[0], /^alive /u)
})

/**
 * ⚠️ **Ноль означает «остановили нарочно», и лаунчер после него НЕ
 * перезапускает.** Обработчики сигналов заводились ради журнала и выходили
 * нулём — а до них Node на SIGHUP завершался ненулевым кодом, и лаунчер честно
 * поднимал сервер заново. После правки приложение стало умирать НАСОВСЕМ: окно
 * открыто, а сервера нет (жалоба 20.09.2026: «вылетел», «ничего не
 * закрывалось»). Это была наша собственная ошибка, и стоила она дорого.
 */
test('Ctrl+C останавливает насовсем, а оборванная консоль — нет', () => {
  // Человек сам попросил остановиться — поднимать обратно нельзя.
  assert.equal(signalExitCode('SIGINT'), 0)
  assert.equal(signalExitCode('SIGBREAK'), 0)
  assert.equal(signalExitCode('SIGTERM'), 0)
  // Консоль ушла сама: если окно и правда закрыли, лаунчера уже нет и код
  // никому не важен; а если окно живо — приложение обязано вернуться.
  assert.notEqual(signalExitCode('SIGHUP'), 0)
})

/** ⚠️ Не утверждаем «закрыли окно»: у тестировщика окно осталось открытым. */
test('причина названа тем, что известно, а не догадкой', () => {
  assert.match(signalReason('SIGHUP'), /app console was interrupted/u)
  assert.doesNotMatch(signalReason('SIGHUP'), /^the window was closed/u)
  assert.match(signalReason('SIGINT'), /Ctrl\+C/u)
})

/**
 * ⚠️ **На Windows SIGHUP при живом окне — не повод умирать.** Дважды за день
 * сервер уходил именно так (20.09.2026): простоял час пятьдесят и четыре часа,
 * ноль задач, память ровная — и вдруг сигнал, а окно, по словам тестировщика,
 * никуда не девалось. Приложение умирало на ровном месте и тянуло за собой
 * вторую вкладку и конфликтную копию доски.
 *
 * Если окно и правда закрыли, Windows добьёт процесс сама через несколько
 * секунд — терять нечего. А если не закрывали, человек просто продолжает
 * работать. Сигнал остаётся в журнале: беду не прячем, просто перестаём от неё
 * умирать.
 */
test('на Windows оборванная консоль не убивает сервер, а на маке убивает', () => {
  assert.equal(keepsRunning('SIGHUP', 'win32'), true)
  // ⚠️ На маке и линуксе SIGHUP значит, что терминал ушёл по-настоящему:
  // остаться жить — бросить сервер сиротой навсегда.
  assert.equal(keepsRunning('SIGHUP', 'darwin'), false)
  assert.equal(keepsRunning('SIGHUP', 'linux'), false)
  // Просьбу человека остановиться уважаем на любой системе.
  assert.equal(keepsRunning('SIGINT', 'win32'), false)
  assert.equal(keepsRunning('SIGBREAK', 'win32'), false)
  assert.equal(keepsRunning('SIGTERM', 'win32'), false)
})
