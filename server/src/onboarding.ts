import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { config } from './config.js'

export const ONBOARDING_STEP_IDS = [
  'first-generation',
  'reference-generation',
  'recovery',
  'save-for-later',
  'export',
] as const

export type OnboardingStepId = typeof ONBOARDING_STEP_IDS[number]
export type OnboardingStepState = 'pending' | 'done' | 'skipped'
export type OnboardingView = 'expanded' | 'compact' | 'collapsed' | 'dismissed'

export interface OnboardingDocument {
  version: 1
  steps: Record<OnboardingStepId, OnboardingStepState>
  view: OnboardingView
  completedAt: number | null
}

export type OnboardingPatch =
  | { step: { id: OnboardingStepId; state: Exclude<OnboardingStepState, 'pending'> } }
  | { view: OnboardingView }
  | { reset: true }

const STEP_STATES = new Set<OnboardingStepState>(['pending', 'done', 'skipped'])
const VIEWS = new Set<OnboardingView>(['expanded', 'compact', 'collapsed', 'dismissed'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && actual.every((key) => keys.includes(key))
}

function createDocument(hasProjects: boolean): OnboardingDocument {
  return {
    version: 1,
    steps: {
      'first-generation': 'pending',
      'reference-generation': 'pending',
      recovery: 'pending',
      'save-for-later': 'pending',
      export: 'pending',
    },
    view: hasProjects ? 'collapsed' : 'expanded',
    completedAt: null,
  }
}

function parseDocument(value: unknown): OnboardingDocument {
  if (!isRecord(value) || !hasOnlyKeys(value, ['version', 'steps', 'view', 'completedAt'])) {
    throw new Error('onboarding.json: invalid structure')
  }
  if (value.version !== 1 || !isRecord(value.steps) || !hasOnlyKeys(value.steps, [...ONBOARDING_STEP_IDS])) {
    throw new Error('onboarding.json: invalid version or steps')
  }
  for (const id of ONBOARDING_STEP_IDS) {
    if (!STEP_STATES.has(value.steps[id] as OnboardingStepState)) {
      throw new Error('onboarding.json: invalid step state')
    }
  }
  if (!VIEWS.has(value.view as OnboardingView)) {
    throw new Error('onboarding.json: invalid type')
  }
  if (value.completedAt !== null && (typeof value.completedAt !== 'number' || !Number.isFinite(value.completedAt))) {
    throw new Error('onboarding.json: invalid time completion')
  }
  return value as unknown as OnboardingDocument
}

function parsePatch(value: unknown): OnboardingPatch {
  if (!isRecord(value)) throw new TypeError('Invalid onboarding progress change')
  if (hasOnlyKeys(value, ['reset']) && value.reset === true) return { reset: true }
  if (hasOnlyKeys(value, ['view']) && VIEWS.has(value.view as OnboardingView)) {
    return { view: value.view as OnboardingView }
  }
  if (hasOnlyKeys(value, ['step']) && isRecord(value.step) && hasOnlyKeys(value.step, ['id', 'state'])) {
    const id = value.step.id
    const state = value.step.state
    if (ONBOARDING_STEP_IDS.includes(id as OnboardingStepId) && (state === 'done' || state === 'skipped')) {
      return { step: { id: id as OnboardingStepId, state } }
    }
  }
  throw new TypeError('Invalid onboarding progress change')
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT'
}

export function createOnboardingRepository(deps: {
  file: string
  now?: () => number
}): {
  load(hasProjects: boolean): Promise<OnboardingDocument>
  patch(patch: unknown, hasProjects: boolean): Promise<OnboardingDocument>
} {
  const now = deps.now ?? Date.now
  let queue: Promise<void> = Promise.resolve()

  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = queue.then(operation, operation)
    queue = result.then(() => undefined, () => undefined)
    return result
  }

  const write = async (document: OnboardingDocument): Promise<void> => {
    await fs.mkdir(path.dirname(deps.file), { recursive: true })
    const temporary = `${deps.file}.${randomUUID()}.tmp`
    try {
      await fs.writeFile(temporary, JSON.stringify(document, null, 2), 'utf8')
      await fs.rename(temporary, deps.file)
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => {})
    }
  }

  const read = async (hasProjects: boolean): Promise<OnboardingDocument> => {
    try {
      return parseDocument(JSON.parse(await fs.readFile(deps.file, 'utf8')))
    } catch (error) {
      if (!isNotFound(error)) throw error
      const document = createDocument(hasProjects)
      await write(document)
      return document
    }
  }

  return {
    load: (hasProjects) => enqueue(() => read(hasProjects)),
    patch: (patch, hasProjects) => {
      let update: OnboardingPatch
      try {
        update = parsePatch(patch)
      } catch (error) {
        return Promise.reject(error)
      }
      return enqueue(async () => {
        const document = await read(hasProjects)
        let next: OnboardingDocument
        if ('reset' in update) {
          next = createDocument(false)
        } else if ('view' in update) {
          next = { ...document, view: update.view }
        } else {
          if (document.steps[update.step.id] !== 'pending') return document
          next = {
            ...document,
            steps: { ...document.steps, [update.step.id]: update.step.state },
          }
        }
        const complete = ONBOARDING_STEP_IDS.every((id) => next.steps[id] !== 'pending')
        next.completedAt = complete ? next.completedAt ?? now() : null
        await write(next)
        return next
      })
    },
  }
}

export const onboarding = createOnboardingRepository({ file: config.onboardingFile })
