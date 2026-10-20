import type { SelectionRef } from './selection'
import type { PinnedAsset } from './types'

// Закреплённый ассет как референс промпта.
//
// Правило одно, а мест теперь два — полка на компьютере и полка на планшете.
// Оставить его внутри одного экрана значило бы однажды починить нумерацию или
// подпись только там.
//
// Идентификатор с двоеточием (`asset:3`) — намеренно: по нему промпт-бар
// отличает ручной чип от зеркала выделения. Проверка id в истории диалога
// обязана двоеточие пускать (см. SHAPE_ID_RE в server/src/promptChatTypes.ts).
export function assetToRef(asset: PinnedAsset): SelectionRef {
  const shapeId = `asset:${asset.slot}`
  if (asset.kind === 'text') {
    return { shapeId, kind: 'text', label: asset.text || 'text', text: asset.text }
  }
  if (asset.kind === 'audio') {
    return { shapeId, kind: 'audio', label: asset.name || 'audio', src: asset.src }
  }
  return {
    shapeId,
    kind: asset.kind,
    label: asset.name || (asset.kind === 'video' ? 'video' : 'image'),
    src: asset.src,
    ...(asset.mime ? { mime: asset.mime } : {}),
    w: asset.width,
    h: asset.height,
  }
}
