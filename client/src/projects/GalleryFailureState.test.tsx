import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { GalleryFailureState } from './GalleryFailureState'

test('состояние недоступности объясняет, как снова запустить CanAI', () => {
  const html = renderToStaticMarkup(
    <GalleryFailureState failure={{ kind: 'service-unavailable' }} retrying={false} onRetry={() => {}} />,
  )

  assert.match(html, /CanAI is temporarily unavailable/)
  assert.match(html, /Start CanAI\.bat/)
  assert.match(html, />Retry</)
})

test('во время повтора кнопка сообщает о проверке и недоступна', () => {
  const html = renderToStaticMarkup(
    <GalleryFailureState failure={{ kind: 'service-unavailable' }} retrying onRetry={() => {}} />,
  )

  assert.match(html, /disabled=""/)
  assert.match(html, />Checking…</)
})

test('обычная ошибка сохраняет прежний заголовок и подробность', () => {
  const html = renderToStaticMarkup(
    <GalleryFailureState
      failure={{ kind: 'load-error', message: 'Файл проекта повреждён' }}
      retrying={false}
      onRetry={() => {}}
    />,
  )

  assert.match(html, /Could not load boards/)
  assert.match(html, /The project file is corrupted\./)
})
