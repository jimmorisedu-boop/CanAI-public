import assert from 'node:assert/strict'
import test from 'node:test'
import type { RefObject } from 'react'
import * as TaskCenterModule from './GenerationTaskCenter'
import {
  registerGenerationResultNavigationSink,
  type GenerationResultNavigationRequest,
} from './generationResultNavigation'

type ShowGenerationTaskResults = (
  request: GenerationResultNavigationRequest,
  close: () => void,
  triggerRef: RefObject<HTMLButtonElement>,
  requestFrame?: (callback: FrameRequestCallback) => number,
) => void

const showGenerationTaskResults = (
  TaskCenterModule as unknown as {
    showGenerationTaskResults?: ShowGenerationTaskResults
  }
).showGenerationTaskResults

test('показ результата делает одну навигацию, закрывает панель и возвращает фокус триггеру', () => {
  assert.equal(typeof showGenerationTaskResults, 'function')

  const navigations: GenerationResultNavigationRequest[] = []
  const unsubscribe = registerGenerationResultNavigationSink((request) => {
    navigations.push(request)
  })
  let open = true
  let closeCount = 0
  const frames: FrameRequestCallback[] = []
  const focusOptions: Array<FocusOptions | undefined> = []
  const triggerRef = {
    current: {
      focus(options?: FocusOptions) {
        focusOptions.push(options)
      },
    } as HTMLButtonElement,
  }

  try {
    showGenerationTaskResults!(
      { projectRef: { source: 'local' as const, id: 'project-1' }, jobIds: ['job-1', 'job-2'] },
      () => {
        closeCount++
        open = false
      },
      triggerRef,
      (callback) => {
        frames.push(callback)
        return 1
      },
    )

    assert.deepEqual(navigations, [
      { projectRef: { source: 'local' as const, id: 'project-1' }, jobIds: ['job-1', 'job-2'] },
    ])
    assert.equal(closeCount, 1)
    assert.equal(open, false)
    assert.equal(frames.length, 1)
    assert.deepEqual(focusOptions, [])

    frames[0]!(0)
    assert.deepEqual(focusOptions, [{ preventScroll: true }])
  } finally {
    unsubscribe()
  }
})
