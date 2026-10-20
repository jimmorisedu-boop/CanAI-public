// Вложение сообщения командного диалога: что хранит сервер команды → что из
// него нужно ленте помощника. Правило одно на мост компьютера
// (server/src/cloudPromptChatView.ts) и на планшет
// (client/src/tablet/cloudPromptChatView.ts).
//
// ⚠️ Вид у вложений бывает ДВУХ сортов. Свежий вопрос сервер команды пишет как
// `{assetId, mime}`. Диалог, приехавший вместе с личной доской, перенесённой в
// команду, хранит вложения в виде приложения — `{shapeId, kind, label,
// assetId, width, height}`, и поля `mime` у них нет. Чтение `mime` без проверки
// роняло ВЕСЬ диалог: «Диалог не загрузился — Cannot read properties of
// undefined (reading 'startsWith')», а выбор модели в его шапке гас, потому
// что без диалога выбирать модель не для чего (жалоба 09.10.2026 «не
// открывается выбор модели на сетевой доске», доска «Терешкова — копия»).
//
// Негодная запись пропускается, а не хоронит диалог: переписка важнее одного
// вложения, которое нечем показать.

export type StoredMediaKind = 'image' | 'video' | 'audio'

export type StoredAttachment =
  | { kind: StoredMediaKind; assetId: string }
  | { kind: 'text'; text: string }

const ASSET_ID = /^[A-Za-z0-9_-]{3,160}$/u
const MEDIA_KINDS: readonly string[] = ['image', 'video', 'audio']
const MAX_TEXT = 4_000

function mediaKind(mime: unknown, kind: unknown): StoredMediaKind {
  if (typeof mime === 'string' && mime) {
    return mime.startsWith('video/') ? 'video' : mime.startsWith('audio/') ? 'audio' : 'image'
  }
  return typeof kind === 'string' && MEDIA_KINDS.includes(kind) ? kind as StoredMediaKind : 'image'
}

export function storedAttachment(value: unknown): StoredAttachment | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const input = value as { assetId?: unknown; mime?: unknown; kind?: unknown; text?: unknown }
  if (input.kind === 'text') {
    const text = typeof input.text === 'string' ? input.text.trim().slice(0, MAX_TEXT) : ''
    // Встроенным данным в ленте не место — правило «без base64» действует и тут.
    return text && !/^data:/iu.test(text) ? { kind: 'text', text } : null
  }
  if (typeof input.assetId !== 'string' || !ASSET_ID.test(input.assetId)) return null
  return { kind: mediaKind(input.mime, input.kind), assetId: input.assetId }
}

/** Вложения сообщения в порядке хранения; не список и негодные записи — пропуск. */
export function storedAttachments(values: unknown): StoredAttachment[] {
  if (!Array.isArray(values)) return []
  return values.flatMap((value) => {
    const item = storedAttachment(value)
    return item ? [item] : []
  })
}

export function storedAttachmentLabel(kind: StoredMediaKind): string {
  return kind === 'video' ? 'video' : kind === 'audio' ? 'audio' : 'image'
}

// ⚠️ Номер текстового вложения должен быть НЕПОВТОРИМ среди вопросов диалога.
// Ему дали `text:<порядок в сообщении>`, и у двух вопросов с одним текстовым
// референсом номера совпали — а чипы референсов сравнивают именно shapeId,
// поэтому второй такой текст в референсы не добавлялся («он уже есть»). Теперь
// в номер входит id сообщения. Не годится id под правило shapeId
// (`^[A-Za-z0-9_:-]{1,80}$` в promptChatTypes) — прежний короткий вид: номер
// лучше повторяющийся, чем отвергнутый целиком вместе с диалогом.
const MESSAGE_ID_PART = /^[A-Za-z0-9_-]+$/u
const MAX_SHAPE_ID = 80

export function textAttachmentShapeId(messageId: string, index: number): string {
  const unique = `text:${messageId}:${index}`
  return MESSAGE_ID_PART.test(messageId) && unique.length <= MAX_SHAPE_ID ? unique : `text:${index}`
}

// Подпись текстового вложения — сам текст, как у текстового объекта холста
// (selection.ts: label = text). Там обрезки нет, а подписи в ленте тесно, поэтому
// 80 знаков; режем по символам, а не по единицам UTF-16, чтобы не разорвать пару.
const MAX_LABEL = 80

export function textAttachmentLabel(text: string): string {
  return Array.from(text).slice(0, MAX_LABEL).join('')
}

// Черновик диалога, приехавший с перенесённой личной доски: при переносе у
// его вложений ключ `src` заменён на `assetId` (адрес личного компьютера в
// команде бессмыслен), и чип в поле ввода рисовался без файла. Возвращаем
// файл по `assetId`, остальные поля записи не трогаем. ⚠️ Через
// `attachment()` черновик НЕ пропускаем: он заменил бы shapeId и подпись, а по
// ним черновик связан с выделением на доске.
export function draftAttachments<T extends object = Record<string, unknown>>(
  values: unknown,
  srcFor: (assetId: string) => string,
): T[] {
  if (!Array.isArray(values)) return []
  return values.flatMap((value): T[] => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return []
    const record = value as Record<string, unknown>
    if (typeof record.src === 'string') return [record as T]
    if (typeof record.assetId !== 'string' || !ASSET_ID.test(record.assetId)) return [record as T]
    return [{ ...record, src: srcFor(record.assetId) } as T]
  })
}
