import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { AgentTaskRecord } from './types.js'
import { MEDIA_SHARED_FOLDER } from '../mediaLayout.js'
import { AgentToolBroker } from './tools.js'
import { materializedMediaPath, materializedPathFits, resolveVerifiedSource } from './tool-media-read.js'
import { digestFile } from './tool-paths.js'
import { MAX_ARTIFACT_BYTES } from './tool-shared.js'

function digest(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

function refOf(artifact: AgentTaskRecord['artifacts'][number]): { artifactId: string; revision: number; checksum: string } {
  return { artifactId: artifact.artifactId, revision: artifact.revision, checksum: artifact.checksum }
}

async function fixture(options: { linkFile?: (existingPath: string, newPath: string) => Promise<void> } = {}) {
  // realpath: mkdtemp на macOS отдаёт /var/…, а это ссылка на /private/var, и
  // на Windows %TEMP% бывает в коротком виде 8.3. Проверки путей обязаны
  // выдерживать такое написание, но фикстура не должна от него зависеть.
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'canai-media-read-')))
  const mediaDir = path.join(root, 'media')
  const workspace = path.join(root, 'workspace')
  await fs.mkdir(mediaDir, { recursive: true })
  await fs.mkdir(workspace, { recursive: true })
  const suffix = path.basename(root).slice(-12)
  const sourceBytes = Buffer.from(`native input ${suffix}\n`, 'utf8')
  const generatedBytes = Buffer.from(`generated output ${suffix}\n`, 'utf8')
  const sourceName = `source-${suffix}.png`
  const generatedName = `generated-${suffix}.mp4`
  await fs.writeFile(path.join(mediaDir, sourceName), sourceBytes)
  await fs.writeFile(path.join(mediaDir, generatedName), generatedBytes)
  const input = {
    itemId: 'selected-input', artifactId: `input-${suffix}`, revision: 1, checksum: digest(sourceBytes),
    kind: 'image' as const, caption: 'Native input',
  }
  const reference = {
    artifactId: input.artifactId, revision: input.revision, checksum: input.checksum, kind: 'image' as const,
    caption: input.caption, mimeType: 'image/png', sizeBytes: sourceBytes.length, mediaSrc: `/media/${sourceName}` as `/media/${string}`,
    provenance: 'reference' as const,
  }
  const generated = {
    artifactId: `generated-${suffix}`, revision: 1, checksum: digest(generatedBytes), kind: 'video' as const,
    caption: 'Generated output', mimeType: 'video/mp4', sizeBytes: generatedBytes.length, mediaSrc: `/media/${generatedName}` as `/media/${string}`,
    provenance: 'generated' as const,
  }
  const task: AgentTaskRecord = {
    taskId: `media-read-${suffix}`, requestId: `request-${suffix}`, requestHash: 'hash', packageId: 'canai.test', packageVersion: '1.0.0', packageSha: 'sha', protocolVersion: '1.0',
    projectRef: { source: 'local', id: 'media-read-board' }, ownerId: 'owner', controllerId: 'controller', taskType: 'media-read-test', instruction: 'Read media', input: {},
    inputs: [input], workspaceId: `workspace-${suffix}`, workspacePath: workspace, state: 'running', revision: 1, eventCursor: 0,
    currentMessageAcks: {}, operationIntents: {}, controlReceipts: {}, decisionReceipts: {}, receipts: [], reviews: [], decisions: [], artifacts: [reference, generated],
    canvasItems: [], pendingCanvasItems: [], createdAt: 1, updatedAt: 1,
  }
  const broker = new AgentToolBroker({ mediaDir, workspaceRoot: root, ...(options.linkFile ? { linkFile: options.linkFile } : {}) })
  return { root, mediaDir, workspace, sourceName, generatedName, sourceBytes, generatedBytes, input, reference, generated, task, broker }
}

async function removeFixture(root: string): Promise<void> {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }).catch(() => undefined)
}

function codeOf(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code) : undefined
}

test('media.read materializes exact input and generated refs with a relative path', async () => {
  const value = await fixture()
  try {
    const input = await value.broker.execute(value.task, 'media.read', refOf(value.reference), 'read-input')
    const inputFile = input.result.file as Record<string, unknown>
    assert.equal(inputFile.kind, 'image')
    assert.equal(inputFile.mimeType, 'image/png')
    assert.equal(path.isAbsolute(String(inputFile.path)), false)
    assert.deepEqual(await fs.readFile(path.join(value.workspace, String(inputFile.path))), value.sourceBytes)

    const generated = await value.broker.execute(value.task, 'media.read', refOf(value.generated), 'read-generated')
    const generatedFile = generated.result.file as Record<string, unknown>
    assert.equal(generatedFile.kind, 'video')
    assert.equal(generatedFile.checksum, value.generated.checksum)
    assert.deepEqual(await fs.readFile(path.join(value.workspace, String(generatedFile.path))), value.generatedBytes)
    // В ответе нет ни абсолютных путей, ни содержимого файла.
    assert.equal(JSON.stringify([input.result, generated.result]).includes(value.root), false)
    assert.deepEqual(Object.keys(generatedFile).sort(), ['checksum', 'kind', 'mimeType', 'path', 'sizeBytes'])
  } finally {
    await removeFixture(value.root)
  }
})

test('media.read rejects foreign refs, Cloud sources, and caller path injection', async () => {
  const value = await fixture()
  try {
    await assert.rejects(value.broker.execute(value.task, 'media.read', { ...refOf(value.reference), checksum: 'f'.repeat(64) }, 'foreign-checksum'), (error) => codeOf(error) === 'REF_NOT_AVAILABLE')
    await assert.rejects(value.broker.execute(value.task, 'media.read', { ...refOf(value.reference), artifactId: 'a'.repeat(161) }, 'long-artifact-id'), (error) => codeOf(error) === 'INPUT_INVALID')
    const cloudTask = { ...value.task, projectRef: { source: 'cloud' as const, id: value.task.projectRef.id } }
    await assert.rejects(value.broker.execute(cloudTask, 'media.read', refOf(value.reference), 'cloud-read'), (error) => codeOf(error) === 'UNSUPPORTED_TOOL')
    await assert.rejects(value.broker.execute(value.task, 'media.read', { ...refOf(value.reference), path: '../outside' }, 'path-injection'), (error) => codeOf(error) === 'INPUT_INVALID')
    const mismatchedMime = { ...value.task, artifacts: [{ ...value.reference, mimeType: 'video/mp4' as const }, value.generated] }
    await assert.rejects(value.broker.execute(mismatchedMime, 'media.read', refOf(value.reference), 'mismatched-mime'), (error) => codeOf(error) === 'REF_NOT_AVAILABLE')
    const mismatchedSize = { ...value.task, artifacts: [{ ...value.reference, sizeBytes: value.reference.sizeBytes + 1 }, value.generated] }
    await assert.rejects(value.broker.execute(mismatchedSize, 'media.read', refOf(value.reference), 'mismatched-size'), (error) => codeOf(error) === 'FILE_INVALID')
    // Вход задачи называет картинку, а квитанция Host на тот же ref — видео.
    const mismatchedKind = { ...value.task, artifacts: [{ ...value.reference, kind: 'video' as const, mimeType: 'video/mp4' }, value.generated] }
    await assert.rejects(value.broker.execute(mismatchedKind, 'media.read', refOf(value.reference), 'mismatched-kind'), (error) => codeOf(error) === 'REF_NOT_AVAILABLE')
    // Ref среди входов есть, а квитанции Host на него нет.
    const withoutReceipt = { ...value.task, artifacts: [value.generated] }
    await assert.rejects(value.broker.execute(withoutReceipt, 'media.read', refOf(value.reference), 'no-receipt'), (error) => codeOf(error) === 'REF_NOT_AVAILABLE')
    assert.deepEqual(await fs.readdir(path.join(value.workspace, 'media-read')).catch(() => []), [])
  } finally {
    await removeFixture(value.root)
  }
})

test('media.read replay is immutable and detects a corrupted materialized file', async () => {
  const value = await fixture()
  try {
    const first = await value.broker.execute(value.task, 'media.read', refOf(value.reference), 'replay-one')
    const file = first.result.file as { path: string; checksum: string; sizeBytes: number }
    await fs.writeFile(path.join(value.mediaDir, value.sourceName), 'changed native source', 'utf8')
    const replay = await value.broker.execute(value.task, 'media.read', refOf(value.reference), 'replay-two')
    assert.deepEqual(replay.result.file, file)
    await fs.writeFile(path.join(value.workspace, file.path), 'corrupted output', 'utf8')
    await assert.rejects(value.broker.execute(value.task, 'media.read', refOf(value.reference), 'corrupt-output'), (error) => codeOf(error) === 'FILE_INVALID')
    // Чинить нечем — испорченная копия остаётся на месте, а не исчезает молча.
    assert.equal(await fs.readFile(path.join(value.workspace, file.path), 'utf8'), 'corrupted output')
  } finally {
    await removeFixture(value.root)
  }
})

test('media.read чинит испорченную копию, пока исходник Host цел', async () => {
  const value = await fixture()
  try {
    const first = await value.broker.execute(value.task, 'media.read', refOf(value.reference), 'heal-one')
    const file = first.result.file as { path: string }
    const copy = path.join(value.workspace, file.path)
    // Та же длина, другие байты: сверка обязана идти по сумме, а не по размеру.
    await fs.writeFile(copy, Buffer.alloc(value.sourceBytes.length, 0x21))
    const healed = await value.broker.execute(value.task, 'media.read', refOf(value.reference), 'heal-two')
    assert.deepEqual(healed.result.file, first.result.file)
    assert.deepEqual(await fs.readFile(copy), value.sourceBytes)
    // И обрезанная копия тоже.
    await fs.writeFile(copy, 'x')
    await value.broker.execute(value.task, 'media.read', refOf(value.reference), 'heal-three')
    assert.deepEqual(await fs.readFile(copy), value.sourceBytes)
    assert.deepEqual(await fs.readdir(path.dirname(copy)), [path.basename(copy)])
  } finally {
    await removeFixture(value.root)
  }
})

test('media.read отказывает, если исходник изменился ещё до первого чтения', async () => {
  const value = await fixture()
  try {
    // Та же длина — подмену ловит только контрольная сумма.
    await fs.writeFile(path.join(value.mediaDir, value.sourceName), Buffer.alloc(value.sourceBytes.length, 0x41))
    await assert.rejects(value.broker.execute(value.task, 'media.read', refOf(value.reference), 'changed-before'), (error) => codeOf(error) === 'FILE_INVALID')
    await assert.rejects(resolveVerifiedSource(value.task, value.mediaDir, refOf(value.reference)), (error) => codeOf(error) === 'FILE_INVALID')
    // Ни готового файла, ни временного в рабочей папке не осталось.
    assert.deepEqual(await fs.readdir(path.join(value.workspace, 'media-read')), [])
    const intact = await resolveVerifiedSource(value.task, value.mediaDir, refOf(value.generated))
    assert.equal(intact.artifact.artifactId, value.generated.artifactId)
    assert.equal(path.basename(intact.file), value.generatedName)
  } finally {
    await removeFixture(value.root)
  }
})

test('media.read держит предел 512 МиБ и по квитанции, и по самому файлу', async (t) => {
  const value = await fixture()
  try {
    const oversizedReceipt = { ...value.task, artifacts: [{ ...value.reference, sizeBytes: MAX_ARTIFACT_BYTES + 1 }, value.generated] }
    await assert.rejects(value.broker.execute(oversizedReceipt, 'media.read', refOf(value.reference), 'oversized-receipt'), (error) => codeOf(error) === 'REF_NOT_AVAILABLE')

    // Квитанция называет ровно предел, а файл на байт больше. Растягиваем его
    // без записи данных: полгигабайта нулей тест писать не должен.
    const source = path.join(value.mediaDir, value.sourceName)
    try {
      await fs.truncate(source, MAX_ARTIFACT_BYTES + 1)
    } catch (error) {
      t.skip(`не удалось растянуть файл до предела: ${codeOf(error) ?? String(error)}`)
      return
    }
    const atLimit = { ...value.task, artifacts: [{ ...value.reference, sizeBytes: MAX_ARTIFACT_BYTES }, value.generated] }
    const started = Date.now()
    await assert.rejects(value.broker.execute(atLimit, 'media.read', refOf(value.reference), 'oversized-file'), (error) => codeOf(error) === 'FILE_INVALID')
    await assert.rejects(resolveVerifiedSource(atLimit, value.mediaDir, refOf(value.reference)), (error) => codeOf(error) === 'FILE_INVALID')
    await assert.rejects(digestFile(source), (error) => codeOf(error) === 'FILE_INVALID')
    // Отказ по размеру обязан прийти до чтения: копировать полгигабайта ради
    // отказа нельзя.
    assert.ok(Date.now() - started < 5_000, 'отказ по размеру не должен читать файл целиком')
    assert.deepEqual(await fs.readdir(path.join(value.workspace, 'media-read')), [])
  } finally {
    await removeFixture(value.root)
  }
})

test('media.read даёт короткое имя, которое открывают ffmpeg и Python', async () => {
  const value = await fixture()
  try {
    // Самый длинный допустимый id: имя файла от него зависеть не должно.
    const longId = `a${'b'.repeat(159)}`
    const longInput = { ...value.input, artifactId: longId }
    const longReference = { ...value.reference, artifactId: longId }
    const task = { ...value.task, inputs: [longInput], artifacts: [longReference, value.generated] }
    const read = await value.broker.execute(task, 'media.read', refOf(longReference), 'long-id')
    const file = read.result.file as { path: string }
    assert.match(file.path, /^media-read\/[a-f0-9]{40}\.png$/u)
    assert.equal(file.path, materializedMediaPath(refOf(longReference), 'image/png'))
    assert.ok(file.path.length <= 60)
    assert.deepEqual(await fs.readFile(path.join(value.workspace, file.path)), value.sourceBytes)

    const deep = `C:\\Users\\name\\${'d'.repeat(200)}\\media-read\\${'a'.repeat(40)}.mp4`
    assert.ok(deep.length > 259)
    assert.equal(materializedPathFits(deep, 'win32'), false)
    assert.equal(materializedPathFits(deep, 'linux'), true)
    assert.equal(materializedPathFits(deep.slice(0, 259), 'win32'), true)
  } finally {
    await removeFixture(value.root)
  }
})

test('media.read на Windows отказывает словами, когда путь не поместится в MAX_PATH', { skip: process.platform !== 'win32' }, async () => {
  const value = await fixture()
  try {
    let workspace = value.workspace
    while (workspace.length < 215) workspace = path.join(workspace, 'глубокая-папка-задачи')
    await fs.mkdir(workspace, { recursive: true })
    await assert.rejects(value.broker.execute({ ...value.task, workspacePath: workspace }, 'media.read', refOf(value.reference), 'too-deep'), (error) => codeOf(error) === 'PATH_TOO_LONG')
    assert.deepEqual(await fs.readdir(path.join(workspace, 'media-read')), [])
  } finally {
    await removeFixture(value.root)
  }
})

test('media.read concurrent calls publish one immutable destination', async () => {
  const value = await fixture()
  try {
    const calls = await Promise.all(Array.from({ length: 8 }, (_, index) =>
      value.broker.execute(value.task, 'media.read', refOf(value.reference), `concurrent-${index}`)))
    const files = calls.map((call) => call.result.file)
    assert.ok(files.every((file) => JSON.stringify(file) === JSON.stringify(files[0])))
    assert.deepEqual(await fs.readFile(path.join(value.workspace, String((files[0] as { path: string }).path))), value.sourceBytes)
    assert.equal((await fs.readdir(path.join(value.workspace, 'media-read'))).length, 1)
  } finally {
    await removeFixture(value.root)
  }
})

test('media.read работает на томе без жёстких ссылок', async () => {
  let attempts = 0
  // exFAT и FAT на флешке отвечают на link именно так.
  const value = await fixture({
    linkFile: async () => {
      attempts += 1
      throw Object.assign(new Error('EPERM: operation not permitted, link'), { code: 'EPERM' })
    },
  })
  try {
    const calls = await Promise.all(Array.from({ length: 4 }, (_, index) =>
      value.broker.execute(value.task, 'media.read', refOf(value.reference), `no-link-${index}`)))
    const file = calls[0].result.file as { path: string }
    assert.ok(attempts >= 1)
    assert.ok(calls.every((call) => JSON.stringify(call.result.file) === JSON.stringify(file)))
    assert.deepEqual(await fs.readFile(path.join(value.workspace, file.path)), value.sourceBytes)
    // Ни временных файлов, ни второй копии.
    assert.deepEqual(await fs.readdir(path.join(value.workspace, 'media-read')), [path.basename(file.path)])
    // Исходник Host на запасном пути не переезжает.
    assert.deepEqual(await fs.readFile(path.join(value.mediaDir, value.sourceName)), value.sourceBytes)
  } finally {
    await removeFixture(value.root)
  }
})

async function createDirectoryLink(target: string, link: string): Promise<boolean> {
  try {
    await fs.symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir')
    return true
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code) : ''
    if (code === 'EPERM' || code === 'EACCES' || code === 'UNKNOWN') return false
    throw error
  }
}

async function createFileLink(target: string, link: string): Promise<boolean> {
  try {
    await fs.symlink(target, link, 'file')
    return true
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code) : ''
    if (code === 'EPERM' || code === 'EACCES' || code === 'UNKNOWN') return false
    throw error
  }
}

test('media.read rejects traversal receipts and source/target/root symlink ancestry', async (t) => {
  const value = await fixture()
  try {
    const bad = { ...value.task, artifacts: [{ ...value.reference, mediaSrc: '/media/../outside.png' as `/media/${string}` }] }
    await assert.rejects(value.broker.execute(bad, 'media.read', refOf(value.reference), 'traversal-receipt'), (error) => codeOf(error) === 'PATH_INVALID')

    const outside = path.join(value.root, 'outside')
    await fs.mkdir(outside)
    await fs.rm(path.join(value.workspace, materializedMediaPath(refOf(value.reference), value.reference.mimeType)), { force: true }).catch(() => undefined)
    await fs.rm(path.join(value.workspace, 'media-read'), { recursive: true, force: true })
    const link = path.join(value.workspace, 'media-read')
    if (!await createDirectoryLink(outside, link)) {
      t.skip('OS does not permit creating a symlink/junction in the test workspace')
      return
    }
    await assert.rejects(value.broker.execute(value.task, 'media.read', refOf(value.reference), 'symlink-output'), (error) => codeOf(error) === 'PATH_INVALID')

    await fs.rm(link, { recursive: true, force: true })
    const workspaceLink = path.join(value.root, 'workspace-link')
    if (!await createDirectoryLink(value.workspace, workspaceLink)) {
      t.skip('OS does not permit creating a workspace symlink/junction in the test fixture')
      return
    }
    await assert.rejects(value.broker.execute({ ...value.task, workspacePath: workspaceLink }, 'media.read', refOf(value.reference), 'symlink-root'), (error) => codeOf(error) === 'PATH_INVALID')

    await fs.rm(workspaceLink, { recursive: true, force: true })
    const outsideSource = path.join(outside, value.sourceName)
    await fs.copyFile(path.join(value.mediaDir, value.sourceName), outsideSource)
    await fs.rm(path.join(value.mediaDir, value.sourceName), { force: true })
    const sourceLink = path.join(value.mediaDir, value.sourceName)
    if (!await createFileLink(outsideSource, sourceLink)) {
      t.skip('OS does not permit creating a source symlink in the test fixture')
      return
    }
    await assert.rejects(value.broker.execute(value.task, 'media.read', refOf(value.reference), 'symlink-source'), (error) => codeOf(error) === 'PATH_INVALID')
  } finally {
    await removeFixture(value.root)
  }
})

test('media.read отвергает junction на месте медиа и внутри него', async (t) => {
  const value = await fixture()
  try {
    // Сам корень медиа — ссылка на настоящую папку.
    const mediaLink = path.join(value.root, 'media-link')
    if (!await createDirectoryLink(value.mediaDir, mediaLink)) {
      t.skip('OS does not permit creating a symlink/junction in the test fixture')
      return
    }
    const linkedBroker = new AgentToolBroker({ mediaDir: mediaLink, workspaceRoot: value.root })
    await assert.rejects(linkedBroker.execute(value.task, 'media.read', refOf(value.reference), 'media-root-link'), (error) => codeOf(error) === 'PATH_INVALID')

    // Папка раскладки внутри медиа уводит наружу: файл по ссылке находится,
    // но лежит не в медиа.
    const outside = path.join(value.root, 'outside-shared')
    await fs.mkdir(path.join(outside, 'video'), { recursive: true })
    await fs.rename(path.join(value.mediaDir, value.generatedName), path.join(outside, 'video', value.generatedName))
    await createDirectoryLink(outside, path.join(value.mediaDir, MEDIA_SHARED_FOLDER))
    await assert.rejects(value.broker.execute(value.task, 'media.read', refOf(value.generated), 'media-ancestor-link'), (error) => codeOf(error) === 'PATH_INVALID')
    assert.deepEqual(await fs.readdir(path.join(value.workspace, 'media-read')).catch(() => []), [])
  } finally {
    await removeFixture(value.root)
  }
})

test('media.read не спотыкается о ссылку ВЫШЕ своих корней и о другое написание пути', async (t) => {
  const value = await fixture()
  try {
    // Другой регистр буквы диска и хвоста пути — та же папка.
    if (process.platform === 'win32') {
      const respelled = (file: string) => file[0].toLowerCase() + file.slice(1, -3) + file.slice(-3).toUpperCase()
      const broker = new AgentToolBroker({ mediaDir: respelled(value.mediaDir), workspaceRoot: value.root })
      const read = await broker.execute({ ...value.task, workspacePath: respelled(value.workspace) }, 'media.read', refOf(value.generated), 'respelled')
      assert.deepEqual(await fs.readFile(path.join(value.workspace, String((read.result.file as { path: string }).path))), value.generatedBytes)
    }

    // Вся папка приложения открыта через ссылку (macOS: /var → /private/var;
    // у человека — папка на другом диске). Это не выход из медиа.
    const alias = path.join(path.dirname(value.root), `${path.basename(value.root)}-alias`)
    if (!await createDirectoryLink(value.root, alias)) {
      t.skip('OS does not permit creating a symlink/junction in the test fixture')
      return
    }
    try {
      const broker = new AgentToolBroker({ mediaDir: path.join(alias, 'media'), workspaceRoot: alias })
      const read = await broker.execute({ ...value.task, workspacePath: path.join(alias, 'workspace') }, 'media.read', refOf(value.reference), 'through-alias')
      const file = read.result.file as { path: string }
      assert.deepEqual(await fs.readFile(path.join(value.workspace, file.path)), value.sourceBytes)
      assert.equal(JSON.stringify(read.result).includes(alias), false)
    } finally {
      await fs.rm(alias, { recursive: true, force: true }).catch(() => undefined)
    }
  } finally {
    await removeFixture(value.root)
  }
})
