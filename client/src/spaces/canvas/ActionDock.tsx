import type { ReactNode } from 'react'
import { IconCombine, IconComments, IconCopy, IconGenerate, IconLLM } from '../../ui/icons'
import type { ActionBatchMode } from './actionDockBatch'
import { useT } from '../../i18n/context.js'


export type ActionDockMode = 'make' | 'discuss' | 'agents'

function plural(count: number, one: string, few: string, many: string): string {
  return Math.abs(count) === 1 ? one : (few || many)
}

/** Names the source operation, not the number of optional generated variants. */
export function actionDockCreateLabel(kind: 'image' | 'video' | 'audio', mode: ActionBatchMode, imageCount: number): string {
  return kind === 'image' && mode === 'each' && imageCount > 1
    ? `Edit ${imageCount} ${plural(imageCount, "image", "images", "images")}`
    : "Generate"
}

export function ActionDockModeTabs({
  mode,
  onChange,
  available,
  signal = 'none',
  signalLabel,
}: {
  mode: ActionDockMode
  onChange(mode: ActionDockMode): void
  disabledAgents?: boolean
  /** Hide a mode when the host has no matching composer (tablet agents). */
  available?: Partial<Record<ActionDockMode, boolean>>
  signal?: 'none' | 'working' | 'ready' | 'failed'
  signalLabel?: string
}) {
  const t = useT()
  return (
    <div className="action-dock-mode-tabs pane-tabs" role="group" aria-label={t('Mode')}>
      {available?.make !== false && (
        <button
          type="button"
          aria-pressed={mode === 'make'}
          className={mode === 'make' ? 'on' : ''}
          onClick={() => onChange('make')}
        >
          <IconGenerate size={14} /><span>{t('Prompt')}</span>
        </button>
      )}
      {available?.discuss !== false && (
        <button
          type="button"
          aria-pressed={mode === 'discuss'}
          className={`${mode === 'discuss' ? 'on' : ''} ${signal !== 'none' ? `signal-${signal}` : ''}`}
          onClick={() => onChange('discuss')}
        >
          <IconComments size={14} /><span>{t('Assistant')}</span>
          {signal !== 'none' && <span className="pane-signal" title={signalLabel || undefined}><i aria-hidden="true" /></span>}
        </button>
      )}
    </div>
  )
}

export function ActionDockBatchSwitch({
  mode,
  onChange,
  imageCount,
  jobs,
  resultCount = jobs,
  disabled = false,
}: {
  mode: ActionBatchMode
  onChange(mode: ActionBatchMode): void
  imageCount: number
  jobs: number
  resultCount?: number
  disabled?: boolean
}) {
  const t = useT()
  if (imageCount < 2) return null
  return (
    <div className="action-dock-batch-row" aria-label={t('How to use images')}>
      <div className="action-dock-batch-switch" role="group" aria-label={t('How to use selected images')}>
        <button
          type="button"
          aria-pressed={mode === 'together'}
          className={mode === 'together' ? 'on' : ''}
          disabled={disabled}
          onClick={() => onChange('together')}
        >
          <IconCombine size={14} />  {t('As references')}
        </button>
        <button
          type="button"
          aria-pressed={mode === 'each'}
          className={mode === 'each' ? 'on' : ''}
          disabled={disabled}
          onClick={() => onChange('each')}
        >
          <IconCopy size={14} />  {t('Change each')}
        </button>
      </div>
      <span className="action-dock-batch-count" aria-live="polite" data-input-count={imageCount} data-result-count={resultCount}>
        <span>{imageCount} {mode === 'each'
          ? plural(imageCount, "source", "sources", "sources")
          : plural(imageCount, "reference", "references", "references")}</span>
        <span aria-hidden="true">→</span>
        <span>{resultCount} {plural(resultCount, "new image", "new images", "new images")}</span>
      </span>
    </div>
  )
}

export function ActionDockLibrary({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) {
  return (
    <div className="action-dock-library" aria-label={label}>
      <span className="action-dock-library-label">{label}</span>
      {children}
    </div>
  )
}
