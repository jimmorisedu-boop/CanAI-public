import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { config } from './config.js'
import { resolveEditorTarget } from './editorTarget.js'
import { mediaWritePathIn, resolveMediaIn } from './mediaLayout.js'
import {
  EditSessionStore,
  type StoredEditSessionV2,
} from './editSessionStore.js'
import { listProjects } from './projects.js'
import { listTrashedProjects } from './projectTrash.js'
import { loadSettings } from './settings.js'

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.svg'])

export class EditSessionError extends Error {
  code: string

  constructor(message: string, code: string) {
    super(message)
    this.code = code
  }
}

export type EditProjectStatus = 'active' | 'trashed' | 'missing'

export interface PublicEditSession extends StoredEditSessionV2 {
  url: string
  projectName: string | null
  projectStatus: EditProjectStatus
}

export interface StartEditSessionInput {
  src: string
  projectId: string
  sourceItemId: string
  sourceName: string
  /** Командная доска: её id живёт на сервере команды, а не в нашем индексе. */
  boardSource?: 'cloud'
  boardName?: string
}

interface ProjectIdentity {
  id: string
  name: string
}

interface EditSessionStorePort {
  create(session: StoredEditSessionV2): Promise<StoredEditSessionV2>
  list(): Promise<StoredEditSessionV2[]>
  acknowledge(
    id: string,
    input: { appliedMtime: number; placedItemId: string },
  ): Promise<StoredEditSessionV2 | null>
  markBroken(id: string, error: string): Promise<StoredEditSessionV2 | null>
  remove(id: string): Promise<boolean>
  activeFileNames?: () => Promise<string[]>
}

export interface EditSessionServiceDependencies {
  store: EditSessionStorePort
  mediaDir: string
  now: () => number
  uuid: () => string
  loadEditorPath: () => Promise<string | null>
  listProjects: () => Promise<ProjectIdentity[]>
  listTrashedProjects: () => Promise<ProjectIdentity[]>
  access: (file: string) => Promise<void>
  copyFile: (source: string, destination: string) => Promise<void>
  unlink: (file: string) => Promise<void>
  stat: (file: string) => Promise<{ mtimeMs: number }>
  launch: (editorPath: string, file: string) => Promise<void>
}

export interface EditSessionService {
  start(input: StartEditSessionInput): Promise<PublicEditSession>
  list(): Promise<PublicEditSession[]>
  acknowledge(
    id: string,
    input: { appliedMtime: number; placedItemId: string },
  ): Promise<PublicEditSession | null>
  stop(id: string): Promise<boolean>
  mtime(id: string): Promise<number | null>
}

function mediaName(src: string): string | null {
  if (!src.startsWith('/media/') || src.includes('..')) return null
  const name = path.basename(src.split('?')[0])
  return name && name === src.split('?')[0].slice('/media/'.length) ? name : null
}

async function projectMaps(deps: EditSessionServiceDependencies): Promise<{
  active: Map<string, ProjectIdentity>
  trashed: Map<string, ProjectIdentity>
}> {
  const [activeProjects, trashedProjects] = await Promise.all([
    deps.listProjects(),
    deps.listTrashedProjects(),
  ])
  return {
    active: new Map(activeProjects.map((project) => [project.id, project])),
    trashed: new Map(trashedProjects.map((project) => [project.id, project])),
  }
}

/**
 * Доски правки больше нет ни среди живых, ни в корзине.
 *
 * ⚠️ Командная доска в локальном индексе не значится НИКОГДА — она живёт на
 * сервере команды. Проверку «доски нет» делают два места, и однажды исключение
 * для командной доски стояло только в одном: список (`list`) помечал правку
 * сломанной первым же опросом, и человек видел «Доска внешней правки не
 * найдена», хотя Фотошоп уже открылся (жалоба 22.09.2026). Одна функция на
 * оба места — чтобы они не разъехались снова.
 */
function boardMissing(
  session: StoredEditSessionV2,
  projects: Awaited<ReturnType<typeof projectMaps>>,
): boolean {
  return session.boardSource !== 'cloud'
    && !projects.active.has(session.projectId)
    && !projects.trashed.has(session.projectId)
}

function publicSession(
  session: StoredEditSessionV2,
  projects: Awaited<ReturnType<typeof projectMaps>>,
): PublicEditSession {
  // Командная доска в локальном индексе не значится и значиться не будет:
  // за её судьбу отвечает сервер команды, а имя мы запомнили при запуске.
  if (session.boardSource === 'cloud') {
    return {
      ...session,
      url: `/media/${session.fileName}`,
      projectName: session.boardName ?? null,
      projectStatus: 'active',
    }
  }
  const active = projects.active.get(session.projectId)
  if (active) {
    return {
      ...session,
      url: `/media/${session.fileName}`,
      projectName: active.name,
      projectStatus: 'active',
    }
  }
  const trashed = projects.trashed.get(session.projectId)
  if (trashed) {
    return {
      ...session,
      url: `/media/${session.fileName}`,
      projectName: trashed.name,
      projectStatus: 'trashed',
    }
  }
  return {
    ...session,
    url: `/media/${session.fileName}`,
    projectName: null,
    projectStatus: 'missing',
  }
}

export function createEditSessionService(deps: EditSessionServiceDependencies): EditSessionService {
  async function decorate(session: StoredEditSessionV2): Promise<PublicEditSession> {
    const projects = await projectMaps(deps)
    if (boardMissing(session, projects)) {
      const broken = await deps.store.markBroken(session.id, 'External board edits not found')
      if (broken) session = broken
    }
    return publicSession(session, projects)
  }

  return {
    async start(input) {
      const srcName = mediaName(input.src)
      if (!srcName) throw new EditSessionError('Invalid source file path', 'invalid_source')
      if (!IMAGE_EXTENSIONS.has(path.extname(srcName).toLowerCase())) {
        throw new EditSessionError('The external editor can open images only', 'not_image')
      }

      const projects = await projectMaps(deps)
      const cloudBoard = input.boardSource === 'cloud'
      if (!cloudBoard) {
        if (projects.trashed.has(input.projectId)) {
          throw new EditSessionError('Board is in Trash', 'project_trashed')
        }
        if (!projects.active.has(input.projectId)) {
          throw new EditSessionError('Board not found', 'project_missing')
        }
      }

      // Папку внутри media знает раскладка (mediaLayout): исходник мог уже
      // переехать в «картинки», а в ссылке по-прежнему только имя.
      const srcPath = resolveMediaIn(deps.mediaDir, srcName)
      try {
        await deps.access(srcPath)
      } catch {
        throw new EditSessionError('Source file not found', 'no_file')
      }

      const editorPath = await deps.loadEditorPath()
      if (!editorPath) throw new EditSessionError('External editor is not configured', 'no_editor')
      try {
        await deps.access(editorPath)
      } catch {
        throw new EditSessionError(
          'Editor program not found at the specified path; check Settings',
          'no_editor',
        )
      }

      const fileName = `edit-${deps.uuid()}${path.extname(srcName).toLowerCase()}`
      const destination = await mediaWritePathIn(deps.mediaDir, fileName)
      await deps.copyFile(srcPath, destination)
      const stat = await deps.stat(destination)
      const createdAt = deps.now()
      let session
      try {
        session = await deps.store.create({
          id: deps.uuid(),
          projectId: input.projectId,
          ...(cloudBoard ? { boardSource: 'cloud' as const } : {}),
          ...(cloudBoard && input.boardName ? { boardName: input.boardName } : {}),
          sourceItemId: input.sourceItemId,
          sourceName: input.sourceName,
          fileName,
          createdAt,
          expiresAt: createdAt + SESSION_TTL_MS,
          // Храним ту же точность, что возвращает последующий fs.stat. Округление
          // вверх делало первый poll ложным «сохранением», если mtime имел доли мс.
          lastMtime: stat.mtimeMs,
          appliedMtime: stat.mtimeMs,
          placedItemId: null,
          state: 'waiting',
        })
      } catch (err) {
        // не оставляем скопированный файл сиротой в media: без записи в
        // edit-sessions.json его никто не знает и не защищает от GC
        await deps.unlink(destination).catch(() => undefined)
        throw err
      }

      try {
        await deps.launch(editorPath, destination)
      } catch {
        await deps.store.remove(session.id).catch(() => false)
        await deps.unlink(destination).catch(() => undefined)
        throw new EditSessionError('Could not run the external editor', 'editor_launch_failed')
      }
      return publicSession(session, projects)
    },

    async list() {
      const sessions = await deps.store.list()
      const projects = await projectMaps(deps)
      const result: PublicEditSession[] = []
      for (let session of sessions) {
        if (boardMissing(session, projects)) {
          session = await deps.store.markBroken(session.id, 'External board edits not found') ?? session
        }
        result.push(publicSession(session, projects))
      }
      return result
    },

    async acknowledge(id, input) {
      const session = await deps.store.acknowledge(id, input)
      return session ? decorate(session) : null
    },

    stop(id) {
      return deps.store.remove(id)
    },

    async mtime(id) {
      const session = (await deps.store.list()).find((item) => item.id === id)
      return session && session.state !== 'broken' ? session.lastMtime : null
    },
  }
}

const dataDir = path.dirname(config.projectFile)
const store = new EditSessionStore({
  file: path.join(dataDir, 'edit-sessions.json'),
  mediaDir: config.mediaDir,
})

async function launchEditor(editorPath: string, file: string): Promise<void> {
  // Тем же разрешением, что и кнопка «Проверить» (editorTarget.ts): на macOS
  // программа — это бандл «.app», а запускать надо файл внутри него. Две
  // отдельные проверки однажды уже разъехались, и «Проверить» бодро отвечало
  // «найдена» там, где spawn падал с EACCES.
  const { executable } = await resolveEditorTarget(editorPath)
  const child = spawn(executable, [file], { detached: true, stdio: 'ignore' })
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve)
    child.once('error', reject)
  })
  child.unref()
}

const service = createEditSessionService({
  store,
  mediaDir: config.mediaDir,
  now: Date.now,
  uuid: randomUUID,
  loadEditorPath: async () => (await loadSettings()).externalEditorPath,
  listProjects,
  listTrashedProjects,
  access: (file) => fs.access(file),
  copyFile: (source, destination) => fs.copyFile(source, destination),
  unlink: (file) => fs.unlink(file),
  stat: (file) => fs.stat(file),
  launch: launchEditor,
})

export function startEditSession(input: StartEditSessionInput): Promise<PublicEditSession> {
  return service.start(input)
}

export function listEditSessions(): Promise<PublicEditSession[]> {
  return service.list()
}

export function acknowledgeEditSession(
  id: string,
  input: { appliedMtime: number; placedItemId: string },
): Promise<PublicEditSession | null> {
  return service.acknowledge(id, input)
}

export function stopEditSession(id: string): Promise<boolean> {
  return service.stop(id)
}

export function getSessionMtime(id: string): Promise<number | null> {
  return service.mtime(id)
}

/** Media file names protected from garbage collection by active editor sessions. */
export function activeEditFileNames(): Promise<string[]> {
  return store.activeFileNames()
}
