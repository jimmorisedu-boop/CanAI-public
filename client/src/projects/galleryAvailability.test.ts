// @ts-expect-error Тест запускается через tsx с Node-типами.
import assert from 'node:assert/strict'
// @ts-expect-error Тест запускается через tsx с Node-типами.
import test from 'node:test'
import { ApiError, LOCAL_SERVICE_UNAVAILABLE } from '../api'
import { galleryFailureFrom, isGalleryServiceUnavailable } from './galleryAvailability'

test('недоступный локальный сервис становится отдельным состоянием галереи', () => {
  const failure = galleryFailureFrom(
    new ApiError('CanAI временно недоступен', LOCAL_SERVICE_UNAVAILABLE),
    'Не удалось загрузить доски',
  )

  assert.deepEqual(failure, { kind: 'service-unavailable' })
  assert.equal(isGalleryServiceUnavailable(failure), true)
})

test('обычная ошибка сохраняет конкретное сообщение', () => {
  assert.deepEqual(galleryFailureFrom(new Error('JSON повреждён'), 'Запасной текст'), {
    kind: 'load-error',
    message: 'JSON повреждён',
  })
  assert.deepEqual(galleryFailureFrom('не Error', 'Запасной текст'), {
    kind: 'load-error',
    message: 'Запасной текст',
  })
})
