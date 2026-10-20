import JSZip from 'jszip'
import { api, type ProjectMeta } from '../api'

const MAX_IMPORT_BYTES = 512 * 1024 * 1024

export async function importCanaiProject(file: File): Promise<ProjectMeta> {
  if (!file.name.toLowerCase().endsWith('.canai')) throw new Error('Choose a .canai file')
  const zip = await JSZip.loadAsync(file)
  const manifestEntry = zip.file('manifest.json')
  const projectEntry = zip.file('project.json')
  if (!manifestEntry || !projectEntry) throw new Error('The archive has no manifest.json or project.json')
  const manifest = JSON.parse(await manifestEntry.async('text')) as { format?: string; version?: number; title?: string }
  if (manifest.format !== 'canai' || manifest.version !== 1) throw new Error('This .canai file version is not supported')
  const raw = JSON.parse(await projectEntry.async('text')) as { version?: number; items?: Array<Record<string, unknown>>; camera?: unknown }
  if (raw.version !== 1 || !Array.isArray(raw.items)) throw new Error('project.json is corrupted')
  const mediaEntries = Object.values(zip.files).filter((entry) => !entry.dir && entry.name.startsWith('media/'))
  if (mediaEntries.some((entry) => entry.name.includes('..') || entry.name.startsWith('/'))) throw new Error('Unsafe path inside .canai')
  const blobs = await Promise.all(mediaEntries.map(async (entry) => ({ name: entry.name, blob: await entry.async('blob') })))
  if (blobs.reduce((sum, entry) => sum + entry.blob.size, 0) > MAX_IMPORT_BYTES) throw new Error('Project is larger than 512 MB')
  const urls = new Map<string, { url: string; mime: string }>()
  for (const entry of blobs) {
    const name = entry.name.split('/').pop() || 'media'
    urls.set(entry.name, await api.uploadFile(new File([entry.blob], name, { type: entry.blob.type || 'application/octet-stream' })))
  }
  const items = raw.items.map((item) => {
    const src = typeof item.src === 'string' ? item.src : undefined
    if (!src) return item
    const uploaded = urls.get(src)
    if (!uploaded) throw new Error(`Archive is missing ${src}`)
    return { ...item, src: uploaded.url, mime: typeof item.mime === 'string' ? item.mime : uploaded.mime }
  })
  // Сервер публикует доску только вместе со снимком: отдельные create/save
  // оставляли пустую доску при сбое, а откат с клиента мог удалить уже
  // сохранённую доску, если потерялся только ответ на запись.
  const { project } = await api.createProject(
    (manifest.title || file.name.replace(/\.canai$/i, '')).slice(0, 200),
    { version: 1, items, camera: raw.camera ?? { x: 0, y: 0, scale: 1 } },
  )
  return project
}
