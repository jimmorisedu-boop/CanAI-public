import React from 'react'
import type { ProjectSource, ServerStatus } from '../../types'
import { InlineNotice } from '../../ui/InlineNotice'
import { AUTO_DISMISS_MS } from '../../ui/noticeTiming'
import { openSettings } from '../../settings/settingsBus'

// Стопка сообщений под промпт-баром. Вынесена из PromptBar: это чистая
// разметка без единого решения, а занимала она восемьдесят строк посреди
// логики запуска генерации.
export function PromptNotices({
  projectSource,
  serverStatus,
  serverStatusReady = false,
  catalogEmpty,
  catalogError,
  onRetryCatalog,
  replacementNumber,
  onCancelReplacement,
  localError,
  onDismissLocalError,
  editorNotice,
  onDismissEditorNotice,
}: {
  projectSource: ProjectSource
  serverStatus: ServerStatus | null
  /** Status null is an initial unknown until the monitor settles. */
  serverStatusReady?: boolean
  catalogEmpty: boolean
  catalogError: boolean
  onRetryCatalog(): void
  // номер заменяемого медиа-референса; null — текстовый; undefined — замены нет
  replacementNumber: number | null | undefined
  onCancelReplacement(): void
  localError: string | null
  onDismissLocalError(): void
  editorNotice: string | null
  onDismissEditorNotice(): void
}) {
  return (
    <>
      {projectSource !== 'cloud' && serverStatus && !serverStatus.falConfigured && (
        <InlineNotice
          className="prompt-inline-notice"
          tone={serverStatus.mockMode ? 'warning' : 'error'}
          title={serverStatus.mockMode ? "Demo mode" : "Generation unavailable"}
          detail={serverStatus.mockMode ? "These are test results; no AI generation was used." : "The fal.ai key is not configured."}
          action={{
            label: "Open Settings",
            onClick: () => openSettings("Add a fal.ai key to enable real generations (no restart required).", 'generation'),
          }}
        />
      )}
      {serverStatusReady && serverStatus === null && (
        <InlineNotice
          className="prompt-inline-notice"
          tone="error"
          title="Server unavailable"
          detail="We check the connection automatically. If the server is closed, launch CanAI with “Run CanAI.bat”."
        />
      )}
      {serverStatusReady && catalogError && catalogEmpty && (
        <InlineNotice
          className="prompt-inline-notice"
          tone="error"
          title="The model catalog did not load"
          detail="The model selection is currently empty."
          action={{ label: "Retry", onClick: onRetryCatalog }}
        />
      )}

      {replacementNumber !== undefined && (
        <InlineNotice
          className="prompt-inline-notice"
          tone="info"
          title={
            replacementNumber
              ? `Replacing reference ${replacementNumber}`
              : "Replacing a text reference"
          }
          detail="Select one object on the canvas or click an asset. Press Esc to cancel."
          onDismiss={onCancelReplacement}
        />
      )}

      {localError && (
        <InlineNotice
          className="prompt-inline-notice"
          tone="error"
          detail={localError}
          onDismiss={onDismissLocalError}
        />
      )}

      {/* обратная связь внешнего редактора: подсказки хука и живые сессии
          (раньше этот стейт существовал, но нигде не отрисовывался — F2
          выглядел как «ничего не произошло») */}
      {editorNotice && (
        <InlineNotice
          className="prompt-inline-notice"
          tone="info"
          detail={editorNotice}
          autoDismissMs={AUTO_DISMISS_MS}
          onDismiss={onDismissEditorNotice}
        />
      )}
    </>
  )
}
