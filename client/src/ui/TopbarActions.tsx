import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Tooltip } from './Tooltip'
import { api } from '../api'
import type { SaveStatus } from '../spaces/canvas/saveStatusBus'
import { getSaveStatus, onSaveStatus } from '../spaces/canvas/saveStatusBus'
import { getGenerationTasks, subscribeGenerationTasks } from '../spaces/canvas/generationRegistry'
import { getMacroRuns, subscribeMacroRuns } from '../spaces/canvas/macroRuns'
import { IconHelp, IconMoon, IconSettings, IconSun } from './icons'
import { OverflowMenu } from './OverflowMenu'
import { useT } from '../i18n/context.js'


interface TopbarAttentionInput {
  saveStatus: SaveStatus
  activeTasks: number
  failedTasks: number
}

export function topbarAttention({ saveStatus, activeTasks, failedTasks }: TopbarAttentionInput): boolean {
  return saveStatus === 'error' || activeTasks > 0 || failedTasks > 0
}

export function useTopbarAttention(): TopbarAttentionInput & { attention: boolean } {
  const saveStatus = useSyncExternalStore(onSaveStatus, getSaveStatus, getSaveStatus)
  const tasks = useSyncExternalStore(subscribeGenerationTasks, getGenerationTasks, getGenerationTasks)
  const runs = useSyncExternalStore(subscribeMacroRuns, getMacroRuns, getMacroRuns)
  const activeTasks = runs.length + tasks.filter((task) => ['queued', 'running', 'cancelling'].includes(task.state)).length
  const failedTasks = tasks.filter((task) => task.state === 'error').length
  return { saveStatus, activeTasks, failedTasks, attention: topbarAttention({ saveStatus, activeTasks, failedTasks }) }
}

function useMissingComponents(): string[] {
  const [missing, setMissing] = useState<string[]>([])
  useEffect(() => {
    let active = true
    api.components().then(({ components }) => {
      if (active) setMissing(components.filter((item) => item.state === 'missing').map((item) => item.name))
    }).catch(() => undefined)
    return () => { active = false }
  }, [])
  return missing
}

export function TopbarActions({
  compact,
  save,
  shareActions,
  exportControl,
  tasks,
  balance,
  theme,
  onSettings,
  onTheme,
  onHelp,
  attention,
  defaultMenuOpen = false,
}: {
  compact: boolean
  save: ReactNode
  shareActions?: ReactNode
  exportControl: ReactNode
  tasks: ReactNode
  balance: ReactNode
  theme: 'light' | 'dark'
  onSettings(): void
  onTheme(): void
  onHelp(): void
  attention: boolean
  defaultMenuOpen?: boolean
}) {
  const t = useT()
  const missingComponents = useMissingComponents()
  const settings = (
    <Tooltip title={t('Settings')} hint={missingComponents.length > 0
      ? t('fal.ai key, external editor, and more. Missing: {0}.', { 0: missingComponents.join(', ') })
      : t('fal.ai key, external editor, and other app settings.')}>
      <button type="button" className="tab settings-button icon-btn" aria-label={t('Settings')} onClick={onSettings}>
        <IconSettings />
        {missingComponents.length > 0 && <span className="settings-dot" aria-hidden="true" />}
      </button>
    </Tooltip>
  )
  const themeControl = (
    <Tooltip title={theme === 'dark' ? t('Light theme') : t('Dark theme')} hint={t('Switch the app theme.')}>
      <button type="button" className="tab theme-toggle-btn icon-btn" aria-label={theme === 'dark' ? t('Light theme') : t('Dark theme')} onClick={onTheme}>
        {theme === 'dark' ? <IconSun /> : <IconMoon />}
        {compact && <span>{theme === 'dark' ? t('Light theme') : t('Dark theme')}</span>}
      </button>
    </Tooltip>
  )
  const help = (
    <Tooltip title={t('Help')} hint={t('Guides and canvas and node keyboard shortcuts.')}>
      <button type="button" className="tab help-button icon-btn" aria-label={t('Help')} onClick={onHelp}>
        <IconHelp />
        {compact && <span>{t('Help')}</span>}
      </button>
    </Tooltip>
  )
  if (!compact) {
    return <>
      {save}
      <div className="top-bar-right">
        {tasks}
        {balance}
        {themeControl}
        {help}
        {shareActions}
        {exportControl}
        {settings}
      </div>
    </>
  }
  return <div className="top-bar-compact-actions">
    <OverflowMenu label={t('More')} panelLabel="App actions" attention={attention} compact={compact} defaultOpen={defaultMenuOpen}>
      <div className="compact-topbar-status" role="status">{save}</div>
      {settings}
      <div className="compact-topbar-export">{exportControl}</div>
      <div className="compact-topbar-tasks">{tasks}</div>
      <div className="compact-topbar-balance">{balance}</div>
      {themeControl}
      {help}
      {shareActions}
    </OverflowMenu>
  </div>
}
