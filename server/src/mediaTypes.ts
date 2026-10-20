// Одна таблица типов медиа на весь сервер, в обе стороны.
//
// Раньше их было две, зеркальные друг другу: EXT_BY_MIME в storage (как
// назвать сохраняемый файл) и MIME_BY_EXT в refs (как назвать тип при отправке
// на fal). И они УЖЕ разъехались: storage умел сохранять image/gif как .gif, а
// refs про расширение gif не знал и отдавал такой файл как image/png. Пока
// таблицы две, это не «может случиться», а «случится опять».
//
// Порядок в списке важен только для обратного направления: первым идёт
// канонический mime расширения, дальше — синонимы, которые встречаются в
// заголовках, но именем файла быть не должны.
interface MediaType {
  mime: string
  ext: string
  // другие mime, означающие то же самое (Content-Type у разных источников)
  aliases?: string[]
  // другие расширения, которые надо понимать при чтении файла
  extAliases?: string[]
}

const TYPES: MediaType[] = [
  { mime: 'image/jpeg', ext: 'jpg', extAliases: ['jpeg'] },
  { mime: 'image/png', ext: 'png' },
  { mime: 'image/webp', ext: 'webp' },
  { mime: 'image/gif', ext: 'gif' },
  { mime: 'image/svg+xml', ext: 'svg' },
  { mime: 'video/mp4', ext: 'mp4' },
  { mime: 'video/webm', ext: 'webm' },
  { mime: 'video/quicktime', ext: 'mov' },
  { mime: 'video/x-m4v', ext: 'm4v' },
  { mime: 'audio/mpeg', ext: 'mp3', aliases: ['audio/mp3'] },
  { mime: 'audio/wav', ext: 'wav', aliases: ['audio/x-wav'] },
  { mime: 'audio/mp4', ext: 'm4a' },
  { mime: 'audio/aac', ext: 'aac' },
  { mime: 'audio/ogg', ext: 'ogg', extAliases: ['opus'] },
  { mime: 'audio/webm', ext: 'weba' },
  { mime: 'audio/flac', ext: 'flac' },
]

const EXT_BY_MIME = new Map<string, string>()
const MIME_BY_EXT = new Map<string, string>()
for (const type of TYPES) {
  EXT_BY_MIME.set(type.mime, type.ext)
  for (const alias of type.aliases ?? []) EXT_BY_MIME.set(alias, type.ext)
  MIME_BY_EXT.set(type.ext, type.mime)
  for (const alias of type.extAliases ?? []) MIME_BY_EXT.set(alias, type.mime)
}

// Как назвать файл, который сохраняем. «bin» — честное «не знаю»: лучше
// нераспознанное расширение, чем чужое.
export function extForMime(mime: string): string {
  return EXT_BY_MIME.get(mime.toLowerCase()) ?? 'bin'
}

// Какой тип у файла, который читаем с диска.
export function mimeForExt(ext: string): string {
  return MIME_BY_EXT.get(ext.toLowerCase()) ?? 'image/png'
}

export const MEDIA_TYPES: readonly MediaType[] = TYPES
