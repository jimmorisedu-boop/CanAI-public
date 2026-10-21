import { IconCrop, IconDone, IconMagic, IconRestore, IconScissors, IconTrash, IconWaveform } from '../../../ui/icons'
import { TimelineButton } from './TimelineButton'
import { segmentAt } from './timelineModel'
import type { TimelineSession } from './useTimelineSession'
import { useT } from '../../../i18n/context.js'


// Ряд монтажа: разрезать, убрать кусок, кадрировать, найти склейки, отделить
// звук — слева; итог и главное действие «Применить» — справа. Подписей на
// кнопках нет: имя и клавиша живут в подсказке и aria-label.

export function TimelineMontage({
  session,
  onToggleCrop,
  onExtractAudio,
}: {
  session: TimelineSession
  /** Рамку включает и клавиша R: сообщение о ней говорит оверлей, один раз. */
  onToggleCrop(): void
  onExtractAudio(): void
}) {
  const t = useT()
  const { facts } = session
  // Кусок под курсором: от него зависит, что делает клавиша C и как называется
  // кнопка. Удалённый кусок с дорожки НЕ пропадает — он перечёркнут.
  const headSegment = segmentAt(session.segments, session.head)
  const headDropped = Boolean(headSegment && session.dropped.includes(headSegment.start))
  const visibleShots = session.shots.filter((shot) => shot.score >= session.threshold).length

  return (
    <section className="tl-montage" aria-label={t('Editing actions')}>
      <div className="tl-montage-row">
        <div className="tl-montage-tools">
          <TimelineButton
            label={t('Cut at cursor position')}
            keys="S"
            shortcut="S"
            placement="top-start"
            disabled={!facts}
            onClick={session.addCut}
          >
            <IconScissors size={18} />
          </TimelineButton>
          <TimelineButton
            label={headDropped ? t('Restore segment to result') : t('Remove segment under cursor')}
            keys="C"
            shortcut="C"
            placement="top-start"
            on={headDropped}
            disabled={!facts || !headSegment}
            onClick={session.toggleDropAtHead}
          >
            {headDropped ? <IconRestore size={18} /> : <IconTrash size={18} />}
          </TimelineButton>
          <TimelineButton
            label={session.crop ? t('Disable cropping') : t('Enable cropping')}
            keys="R"
            shortcut="R"
            placement="top-start"
            on={Boolean(session.crop)}
            disabled={!facts}
            onClick={onToggleCrop}
          >
            <IconCrop size={18} />
          </TimelineButton>
          <TimelineButton
            label={session.autoBusy ? t('Finding cuts…') : t('Find cuts')}
            hint={t('Auto-detect scene changes')}
            placement="top-start"
            on={session.autoOn}
            toggle
            busy={session.autoBusy}
            disabled={!facts || session.autoBusy}
            onClick={session.toggleAuto}
          >
            <IconMagic size={18} />
          </TimelineButton>
          <TimelineButton
            label={t('Separate audio')}
            keys="A"
            shortcut="A"
            hint={facts && !facts.hasAudio ? t('This clip has no audio track') : t('Extract audio as a separate object')}
            placement="top-start"
            disabled={!facts?.hasAudio}
            onClick={onExtractAudio}
          >
            {/* не динамик: тот в транспорте глушит предпросмотр, и два одинаковых
                значка с разным действием путали бы */}
            <IconWaveform size={18} />
          </TimelineButton>

          {session.autoOn && session.shots.length > 0 && (
            <div className="tl-sens">
              <input
                type="range"
                min={3}
                max={60}
                step={1}
                value={session.threshold}
                aria-label={t('Cut detection sensitivity')}
                onChange={(event) => session.setThreshold(Number(event.target.value))}
              />
              <output>{visibleShots} of {session.shots.length}</output>
            </div>
          )}
        </div>

        {/* Полный текст — в подсказку: в тесноте строка ужимается многоточием,
            уступая место кнопкам (см. timeline.css). */}
        <div className="timeline-result" title={session.summary}>{session.summary}</div>

        <TimelineButton
          label={t('Apply edits')}
          keys="Enter"
          shortcut="Enter"
          placement="top-end"
          primary
          busy={session.busy}
          disabled={session.busy || session.pieces === 0}
          onClick={() => void session.apply()}
        >
          <IconDone size={18} />
        </TimelineButton>
      </div>
    </section>
  )
}
