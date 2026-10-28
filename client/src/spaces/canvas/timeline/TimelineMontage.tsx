import {
  IconCrop,
  IconDone,
  IconMagic,
  IconRestore,
  IconScissors,
  IconTrash,
  IconTrimLeft,
  IconTrimRight,
  IconWaveform,
} from '../../../ui/icons'
import { TimelineButton } from './TimelineButton'
import { segmentAt } from './timelineModel'
import type { TimelineSession } from './useTimelineSession'
import { useT } from '../../../i18n/context.js'

// Ряд монтажа по законам Хика, Миллера и фон Ресторфф:
// 1) группа реза и подрезки куска (C, X, Q, W);
// 2) группа инструментов клипа (F, автопоиск, A);
// 3) справа — сжимаемый итог и ЕДИНСТВЕННАЯ залитая акцентом кнопка Apply edits (Enter).

export function TimelineMontage({
  session,
  onToggleCrop,
  onExtractAudio,
}: {
  session: TimelineSession
  onToggleCrop(): void
  onExtractAudio(): void
}) {
  const t = useT()
  const { facts } = session
  const headSegment = segmentAt(session.segments, session.head)
  const headDropped = Boolean(headSegment && session.dropped.includes(headSegment.start))
  const visibleShots = session.shots.filter((shot) => shot.score >= session.threshold).length

  return (
    <section className="tl-montage" aria-label={t('Editing actions')}>
      <div className="tl-montage-row">
        <div className="tl-montage-tools">
          <div className="tl-tool-group" role="group" aria-label={t('Cut and trim')}>
            <TimelineButton
              label={t('Cut at cursor position')}
              text={t('Split')}
              kbd="C"
              keys="C"
              shortcut="C"
              placement="top-start"
              disabled={!facts}
              onClick={session.addCut}
            >
              <IconScissors size={17} />
            </TimelineButton>
            <TimelineButton
              label={headDropped ? t('Restore segment to result') : t('Remove segment under cursor')}
              text={headDropped ? t('Restore') : t('Remove')}
              kbd="X"
              keys="X"
              shortcut="X"
              placement="top-start"
              on={headDropped}
              disabled={!facts || !headSegment}
              onClick={session.toggleDropAtHead}
            >
              {headDropped ? <IconRestore size={17} /> : <IconTrash size={17} />}
            </TimelineButton>
            <TimelineButton
              label={t('Trim segment start to cursor')}
              text={t('Trim left')}
              kbd="Q"
              keys="Q"
              shortcut="Q"
              placement="top-start"
              disabled={!facts || !headSegment}
              onClick={session.trimLeftAtHead}
            >
              <IconTrimLeft size={17} />
            </TimelineButton>
            <TimelineButton
              label={t('Trim segment end from cursor')}
              text={t('Trim right')}
              kbd="W"
              keys="W"
              shortcut="W"
              placement="top-start"
              disabled={!facts || !headSegment}
              onClick={session.trimRightAtHead}
            >
              <IconTrimRight size={17} />
            </TimelineButton>
          </div>

          <span className="tl-divider" aria-hidden="true" />

          <div className="tl-tool-group" role="group" aria-label={t('Clip tools')}>
            <TimelineButton
              label={session.crop ? t('Disable cropping') : t('Enable cropping')}
              text={t('Crop')}
              kbd="F"
              keys="F"
              shortcut="F"
              placement="top-start"
              on={Boolean(session.crop)}
              disabled={!facts}
              onClick={onToggleCrop}
            >
              <IconCrop size={17} />
            </TimelineButton>
            <TimelineButton
              label={session.autoBusy ? t('Finding cuts…') : t('Find cuts')}
              text={t('Find cuts')}
              hint={t('Auto-detect scene changes')}
              placement="top-start"
              on={session.autoOn}
              toggle
              busy={session.autoBusy}
              disabled={!facts || session.autoBusy}
              onClick={session.toggleAuto}
            >
              <IconMagic size={17} />
            </TimelineButton>
            <TimelineButton
              label={t('Separate audio')}
              text={t('Audio')}
              kbd="A"
              keys="A"
              shortcut="A"
              hint={facts && !facts.hasAudio ? t('This clip has no audio track') : t('Extract audio as a separate object')}
              placement="top-start"
              disabled={!facts?.hasAudio}
              onClick={onExtractAudio}
            >
              <IconWaveform size={17} />
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
                <output>{t('{0} of {1}', { 0: visibleShots, 1: session.shots.length })}</output>
              </div>
            )}
          </div>
        </div>

        <div className="timeline-result" title={session.summary}>{session.summary}</div>

        <TimelineButton
          label={t('Apply edits')}
          text={t('Apply edits')}
          kbd="Enter"
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
