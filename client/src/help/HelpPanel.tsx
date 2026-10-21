import { useEffect, useMemo, useRef, useState } from 'react'
import { HELP_CATEGORIES, HELP_TOPICS, type HelpTopic } from './content/index'
import { requestOnboardingTarget } from '../spaces/canvas/onboardingEvents'
import { useT } from '../i18n/context.js'

type TranslateHelp = (message: string) => string
const identity = (message: string): string => message

function searchable(value: string): string {
  return value.toLocaleLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
}

/** Resolve Vite public assets for both the desktop root and /tablet/ builds. */
export function helpImageSrc(src: string, baseUrl = import.meta.env?.BASE_URL ?? '/'): string {
  if (!src.startsWith('/help/') || baseUrl === '/') return src
  return `${baseUrl.replace(/\/+$/u, '')}${src}`
}

function topicText(topic: HelpTopic, translate: TranslateHelp = identity): string {
  return searchable([
    translate(topic.title),
    translate(topic.summary),
    topic.category,
    ...topic.keywords.map(translate),
    ...(topic.notes ?? []).map(translate),
    ...topic.steps.flatMap((step) => [step.title, step.body, step.alt].map(translate)),
    ...(topic.shortcuts ?? []).flatMap((shortcut) => [shortcut.keys, translate(shortcut.action)]),
  ].join(' '))
}

export function filterHelpTopics(query: string, category = 'all', translate: TranslateHelp = identity): HelpTopic[] {
  const tokens = searchable(query.trim()).split(/\s+/).filter(Boolean)
  return HELP_TOPICS.filter((topic) => (
    (category === 'all' || topic.category === category)
    && tokens.every((token) => topicText(topic, translate).includes(token))
  ))
}

function actionLabel(topic: HelpTopic, translate: TranslateHelp): string {
  switch (topic.target) {
    case 'first-generation': return translate('Show the prompt')
    case 'reference-generation': return translate('Show references')
    case 'recovery': return translate('Open recovery steps')
    case 'save-for-later': return translate('Show save actions')
    case 'export': return translate('Show export actions')
    default: return translate('Open on the board')
  }
}

function imageFor(topic: HelpTopic): { src: string; alt: string } | null {
  const step = topic.steps[0]
  if (!step?.image) return null
  return { src: step.image, alt: step.alt || topic.title }
}

export interface HelpPanelProps {
  initialTopicId?: string
  onClose?: () => void
  onShowTutorial?: () => void
  onShowTarget?: (topic: HelpTopic) => boolean | void
  showBoardActions?: boolean
}

/** The browse-and-read part of Help. The modal shell lives in ShortcutsModal. */
export function HelpPanel({ initialTopicId, onClose, onShowTutorial, onShowTarget, showBoardActions = true }: HelpPanelProps) {
  const t = useT()
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('all')
  const [selectedId, setSelectedId] = useState(initialTopicId ?? HELP_TOPICS[0]?.id ?? '')
  const detailRef = useRef<HTMLElement>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const focusSelectionRef = useRef(false)

  const filteredTopics = useMemo(() => {
    return filterHelpTopics(query, category, t)
  }, [category, query, t])

  useEffect(() => {
    if (!filteredTopics.some((topic) => topic.id === selectedId)) {
      setSelectedId(filteredTopics[0]?.id ?? '')
    }
  }, [filteredTopics, selectedId])

  useEffect(() => {
    if (initialTopicId && HELP_TOPICS.some((topic) => topic.id === initialTopicId)) {
      focusSelectionRef.current = true
      setSelectedId(initialTopicId)
    }
  }, [initialTopicId])

  useEffect(() => {
    detailRef.current?.scrollTo({ top: 0, behavior: 'auto' })
    if (focusSelectionRef.current) {
      focusSelectionRef.current = false
      headingRef.current?.focus({ preventScroll: true })
    }
  }, [selectedId])

  const selected = HELP_TOPICS.find((topic) => topic.id === selectedId) ?? filteredTopics[0] ?? null

  function showOnBoard(topic: HelpTopic): void {
    if (!topic.target) return
    if (onShowTarget?.(topic)) return
    requestOnboardingTarget(topic.target)
    onClose?.()
  }

  function selectTopic(id: string): void {
    // A related guide should always be reachable even when the current search
    // or category would otherwise filter it out.
    setQuery('')
    setCategory('all')
    focusSelectionRef.current = true
    setSelectedId(id)
  }

  return (
    <div className="help-panel">
      <div className="help-toolbar">
        <label className="help-search">
          <span className="help-search-label">{t('Search guides')}</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('Search assistant, photos, assets, references…')}
            aria-label={t('Search guides')}
          />
        </label>
        <div className="help-categories" role="group" aria-label={t('Guide categories')}>
          <button
            type="button"
            aria-pressed={category === 'all'}
            className={category === 'all' ? 'active' : ''}
            onClick={() => setCategory('all')}
          >
            {t('All guides')}
          </button>
          {HELP_CATEGORIES.map((entry) => (
            <button
              key={entry.id}
              type="button"
              aria-pressed={category === entry.id}
              className={category === entry.id ? 'active' : ''}
              onClick={() => setCategory(entry.id)}
            >
              {t(entry.title)}
            </button>
          ))}
        </div>
      </div>

      <div className="help-layout">
        <nav className="help-topic-list" aria-label={t('Guides')}>
          {filteredTopics.length === 0 ? (
            <p className="help-empty">{t('No guides match that search.')}</p>
          ) : filteredTopics.map((topic) => {
            const image = imageFor(topic)
            return (
              <button
                key={topic.id}
                type="button"
                className={`help-topic-card${topic.id === selected?.id ? ' active' : ''}`}
                data-control-layout="stack"
                aria-current={topic.id === selected?.id ? 'page' : undefined}
                onClick={() => { focusSelectionRef.current = true; setSelectedId(topic.id) }}
              >
                {image && <img src={helpImageSrc(image.src)} alt="" aria-hidden="true" loading="lazy" />}
                <span>
                  <strong>{t(topic.title)}</strong>
                  <small>{t(topic.summary)}</small>
                </span>
              </button>
            )
          })}
        </nav>

        <article ref={detailRef} className="help-topic-detail" aria-live="polite">
          {selected ? (
            <>
              <div className="help-topic-heading">
                <div>
                  <p className="help-kicker">{t(HELP_CATEGORIES.find((entry) => entry.id === selected.category)?.title ?? t('Guide'))}</p>
                  <h3 ref={headingRef} tabIndex={-1}>{t(selected.title)}</h3>
                  <p className="help-summary">{t(selected.summary)}</p>
                </div>
                {selected.target && showBoardActions ? (
                  <button type="button" className="help-primary-action" onClick={() => showOnBoard(selected)}>
                    {actionLabel(selected, t)}
                  </button>
                ) : null}
              </div>
              <div className="help-step-list">
                {selected.steps.map((step, index) => (
                  <section key={`${selected.id}-${index}`} className="help-step">
                    <div className="help-step-number" aria-hidden="true">{index + 1}</div>
                    <div>
                      <h4>{t(step.title)}</h4>
                      {step.image && <img className="help-step-image" src={helpImageSrc(step.image)} alt={t(step.alt || step.title)} loading="lazy" />}
                      <p>{t(step.body)}</p>
                    </div>
                  </section>
                ))}
              </div>
              {selected.notes?.length ? (
                <details className="help-notes">
                  <summary>{t('Good to know')}</summary>
                  <ul>{selected.notes.map((note) => <li key={note}>{t(note)}</li>)}</ul>
                </details>
              ) : null}
              {selected.shortcuts?.length ? (
                <section className="help-shortcuts" aria-labelledby="help-shortcuts-heading">
                  <h4 id="help-shortcuts-heading">{t('Shortcuts')}</h4>
                  {selected.shortcuts.map((shortcut) => (
                    <div key={`${shortcut.keys}-${shortcut.action}`} className="help-shortcut-row">
                      <kbd>{shortcut.keys}</kbd><span>{t(shortcut.action)}</span>
                    </div>
                  ))}
                </section>
              ) : null}
              {selected.related?.length ? (
                <section className="help-related" aria-labelledby="help-related-heading">
                  <h4 id="help-related-heading">{t('Related guides')}</h4>
                  <div className="help-related-links">
                    {selected.related.map((id) => {
                      const related = HELP_TOPICS.find((topic) => topic.id === id)
                      return related ? (
                        <button key={id} type="button" onClick={() => selectTopic(related.id)}>{t(related.title)}</button>
                      ) : null
                    })}
                  </div>
                </section>
              ) : null}
            </>
          ) : (
            <div className="help-empty-detail">
              <h3>{t('Help')}</h3>
              <p>{t('Choose a guide or try a different search.')}</p>
            </div>
          )}
        </article>
      </div>

      {onShowTutorial && (
        <div className="help-footer">
          <button type="button" className="ui-btn quiet" onClick={onShowTutorial}>{t('Show first steps again')}</button>
        </div>
      )}
    </div>
  )
}
