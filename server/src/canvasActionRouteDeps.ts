import { resolveLocalCanvasActionProfile } from './canvasActionPreparation.js'
import { config } from './config.js'
import { generationGate, selectGenerationRoute } from './generationGate.js'
import {
  cancelJobById,
  persistAndEnqueueJob,
} from './runner.js'
import {
  jobs,
  type Job,
  type JobStore,
} from './jobs.js'
import { loadSettings } from './settings.js'

export interface JobStoreLike {
  all(): Job[]
  get(id: string): Job | undefined
  create: JobStore['create']
  remove?(id: string): void
  liveCount?(): number
}

export interface CanvasActionRouteDeps {
  jobStore?: JobStoreLike
  enqueue?: (job: Job) => Promise<void>
  cancel?: (id: string) => Promise<'not-found' | 'already-final' | 'cancelled'>
  resolveLocalProfile?: typeof resolveLocalCanvasActionProfile
  loadAppSettings?: typeof loadSettings
  isLocalConfigured?: () => boolean
  mockMode?: () => boolean
  isShuttingDown?: () => boolean
  chooseRoute?: typeof selectGenerationRoute
}

export type ResolvedCanvasActionRouteDeps = Omit<Required<CanvasActionRouteDeps>, 'quoteCloud'> & {
}

function defaultDeps(): ResolvedCanvasActionRouteDeps {
  return {
    jobStore: jobs,
    enqueue: persistAndEnqueueJob,
    cancel: cancelJobById,
    resolveLocalProfile: resolveLocalCanvasActionProfile,
    loadAppSettings: loadSettings,
    isLocalConfigured: () => Boolean(config.falKey),
    mockMode: () => config.mockMode,
    isShuttingDown: () => generationGate.shuttingDown,
    chooseRoute: selectGenerationRoute,
  }
}

export function mergeCanvasActionRouteDeps(overrides: CanvasActionRouteDeps): ResolvedCanvasActionRouteDeps {
  return { ...defaultDeps(), ...overrides } as ResolvedCanvasActionRouteDeps
}
