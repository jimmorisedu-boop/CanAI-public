import assert from 'node:assert/strict'
import test from 'node:test'
import { linkCardPresentation } from './linkItemPresentation'
import type { CanvasLinkData } from './types'

function link(patch: Partial<CanvasLinkData> = {}): CanvasLinkData {
  return {
    url: 'https://vimeo.com/315204505',
    normalizedUrl: 'https://vimeo.com/315204505',
    provider: 'vimeo',
    sourceLabel: 'Vimeo',
    title: 'Ролик',
    state: 'ready',
    entries: [],
    ...patch,
  }
}

test('обычная карточка предлагает скачать', () => {
  const view = linkCardPresentation(link())
  assert.equal(view.primaryKind, 'download')
  assert.equal(view.primaryAction, 'Download')
})

test('идущее скачивание не даёт нажать снова', () => {
  const view = linkCardPresentation(link({ activeImportId: 'task-1' }))
  assert.equal(view.primaryKind, 'downloading')
})

test('отказ из-за входа превращает главную кнопку во «Войти»', () => {
  // Человек не должен уходить в настройки: вход — рабочее действие, и место
  // ему там же, где отказ.
  const view = linkCardPresentation(link({ state: 'error', error: 'Vimeo отдаёт видео только после входа', needsLogin: true }))
  assert.equal(view.primaryKind, 'login')
  assert.equal(view.primaryAction, 'Sign in on Vimeo')
  // Повторять превью бессмысленно, пока не вошёл: ответ будет тот же.
  assert.equal(view.canRetryPreview, false)
})

test('после открытия окна кнопка зовёт повторить, и подсказка объясняет порядок', () => {
  const view = linkCardPresentation(
    link({ state: 'error', needsLogin: true }),
    { loginOpened: true },
  )
  assert.equal(view.primaryKind, 'retry-login')
  assert.equal(view.primaryAction, 'I’m signed in — retry')
  assert.match(view.loginHint ?? '', /window/i)
})

test('обычная ошибка по-прежнему предлагает повтор превью, а не вход', () => {
  const view = linkCardPresentation(link({ state: 'error', error: 'Не удалось прочитать Vimeo' }))
  assert.equal(view.primaryKind, 'download')
  assert.equal(view.canRetryPreview, true)
  assert.equal(view.previewStatus, 'Could not read Vimeo.')
  assert.equal(view.loginHint, undefined)
})

test('флаг входа без ошибки карточку не трогает', () => {
  // Превью прошло — значит вход больше не нужен, даже если флаг задержался.
  const view = linkCardPresentation(link({ state: 'ready', needsLogin: true }))
  assert.equal(view.primaryKind, 'download')
})
