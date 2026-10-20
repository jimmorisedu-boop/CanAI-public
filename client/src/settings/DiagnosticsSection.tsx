import React, { useEffect, useState } from 'react'
import {
  clearLog,
  formatLogEntry,
  getLogEntries,
  onLogEntry,
  setConsoleAreas,
  type LogEntry,
} from '../diag/log'
import { copyLogText, downloadLogFile } from '../diag/logFile'
import { pluralWithCount } from '../ui/plural'
import { notify } from '../spaces/canvas/notifications'
import { api } from '../api'
import { clientBuild, formatBuild, type BuildInfo } from '../diag/buildInfo'
import { ProblemReport } from './ProblemReport'

const VISIBLE = 14

/**
 * Журнал работы приложения.
 *
 * Смысл раздела в одном: когда что-то пошло не так, человек не должен
 * пересказывать симптом словами — он присылает файл, где видно, что именно
 * ушло на сервер и что тот ответил. Поэтому запись идёт всегда, а здесь только
 * показ и выгрузка.
 */
export function DiagnosticsSection() {
  const [entries, setEntries] = useState<LogEntry[]>(() => getLogEntries())
  const [console_, setConsole] = useState(false)
  // Сборка сервера: undefined — ещё спрашиваем, null — старый сервер не говорит.
  const [serverBuild, setServerBuild] = useState<BuildInfo | null | undefined>(undefined)

  useEffect(() => onLogEntry(() => setEntries(getLogEntries())), [])
  useEffect(() => {
    let alive = true
    api.status()
      .then((status) => { if (alive) setServerBuild(status.build ?? null) })
      .catch(() => { if (alive) setServerBuild(null) })
    return () => { alive = false }
  }, [])

  // Номер сервера — в шапку выгружаемого журнала: номер страницы журнал знает сам.
  const header = { 'Server build': serverBuild === undefined ? '' : formatBuild(serverBuild) }

  const tail = entries.slice(-VISIBLE).reverse()

  return (
    <>
    {/* Первым — жалоба (пункт 5.9): ради неё в раздел чаще всего и заходят. */}
    <ProblemReport serverBuildLine={serverBuild === undefined ? '' : formatBuild(serverBuild)} />
    <section className="settings-section" aria-labelledby="diagnostics-title">
      <div className="settings-section-heading">
        <div>
          <h3 id="diagnostics-title">Activity log</h3>
          <p>
            What the app did and how the server responded. It is always recorded, so
            a log is ready when something goes wrong.
          </p>
        </div>
        <span className="settings-connection" data-tone="neutral" role="status">
          {pluralWithCount(entries.length, ['entry', 'entries', 'entries'])}
        </span>
      </div>

      {/* Какая сборка работает (пункт 5.1): разбор жалобы начинается с этого. */}
      <dl className="diag-build" aria-label="Build">
        <div><dt>Interface</dt><dd>{formatBuild(clientBuild())}</dd></div>
        <div><dt>Server</dt><dd>{serverBuild === undefined ? 'checking…' : formatBuild(serverBuild)}</dd></div>
      </dl>

      <div className="diag-tail" role="log" aria-label="Latest events">
        {tail.length === 0
          ? <p className="settings-note">Nothing yet — events appear as you work with a board.</p>
          : tail.map((entry) => (
            <div key={entry.seq} className="diag-line" data-level={entry.level}>
              {formatLogEntry(entry)}
            </div>
          ))}
      </div>

      <div className="diag-actions">
        <button
          type="button"
          className="ui-btn"
          onClick={() => {
            const name = downloadLogFile(header)
            notify({ kind: 'success', message: `Log saved: ${name}` })
          }}
        >
          Download log
        </button>
        <button
          type="button"
          className="ui-btn"
          onClick={() => {
            void copyLogText(header).then((ok) => notify(ok
              ? { kind: 'success', message: 'Log copied' }
              : { kind: 'error', message: 'Could not copy log — save it as a file' }))
          }}
        >
          Copy
        </button>
        <button
          type="button"
          className="ui-btn quiet"
          onClick={() => { clearLog(); setEntries([]) }}
        >
          Clear
        </button>
      </div>

      <label className="settings-checkbox">
        <input
          type="checkbox"
          checked={console_}
          onChange={(event) => {
            setConsole(event.target.checked)
            setConsoleAreas(event.target.checked ? '*' : '')
          }}
        />
        <span>Mirror to the browser console (for live debugging)</span>
      </label>
    </section>
    </>
  )
}
