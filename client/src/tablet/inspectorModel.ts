import type { CanvasItem } from '../spaces/canvas/konva/types'

// Что показывать в инспекторе.
//
// Отдельным модулем, потому что это правила, а не разметка: какие действия
// доступны для картинки, видео, звука и текста — вопрос, на который должен
// быть один ответ, проверяемый без экрана.

export type InspectorAction =
  | 'view'
  | 'resize'
  | 'sketch'
  | 'crop'
  | 'clip'
  | 'extract-audio'
  | 'compare'
  | 'edit-text'
  | 'duplicate'
  | 'pin'
  | 'front'
  | 'back'
  | 'download'
  | 'archive'
  | 'delete'

export type InspectorSection = 'edit' | 'arrange' | 'file' | 'danger'

/** Действия, которые меняют выбранный объект и требуют его lease. */
export function actionNeedsMutationLease(action: InspectorAction | 'grid'): boolean {
  return action === 'grid'
    || action === 'resize'
    || action === 'sketch'
    || action === 'crop'
    || action === 'clip'
    || action === 'extract-audio'
    || action === 'edit-text'
    || action === 'front'
    || action === 'back'
    || action === 'archive'
    || action === 'delete'
}

export function actionSection(action: InspectorAction): InspectorSection {
  if (action === 'delete') return 'danger'
  if (action === 'download' || action === 'archive' || action === 'pin') return 'file'
  if (action === 'resize' || action === 'duplicate' || action === 'front' || action === 'back') return 'arrange'
  return 'edit'
}

export interface InspectorSubject {
  /** Один объект — или несколько, если выделено больше одного. */
  items: CanvasItem[]
}

/** Действия для одного объекта — в том порядке, в каком они стоят на экране. */
export function actionsForItem(item: CanvasItem): InspectorAction[] {
  const actions: InspectorAction[] = []
  if (item.kind === 'image' || item.kind === 'video') actions.push('view')
  actions.push('resize')
  // Сравнение без второго объекта открывало пустое окно. На планшете оно
  // появляется только после явного мультивыбора двух или более кадров.
  if (item.kind === 'image') actions.push('sketch', 'crop')
  if (item.kind === 'video') actions.push('clip', 'extract-audio')
  if (item.kind === 'text') actions.push('edit-text')
  actions.push('duplicate', 'pin', 'front', 'back')
  // Скачать можно то, у чего есть файл; текст при одиночном экспорте становится
  // .txt, а в пачке кладётся тем же .txt внутрь ZIP — действие доступно всем.
  actions.push('download', 'archive', 'delete')
  return actions
}

/** Действия для нескольких объектов: только то, что осмысленно для группы. */
export function actionsForMany(items: CanvasItem[]): InspectorAction[] {
  const actions: InspectorAction[] = ['duplicate']
  // Первый выбранный кадр становится исходником, остальные — кандидатами,
  // которые можно листать в полноэкранном сравнении.
  if (items.length >= 2 && items.every((item) => item.kind === 'image' || item.kind === 'video')) {
    actions.push('compare')
  }
  actions.push('front', 'back', 'download', 'archive', 'delete')
  return actions
}

export const ACTION_LABEL: Record<InspectorAction, string> = {
  view: 'Open large',
  resize: 'Resize',
  sketch: 'Sketch',
  crop: 'Crop',
  clip: 'Clip editing',
  'extract-audio': 'Extract audio',
  compare: 'Compare selected',
  'edit-text': 'Edit text',
  duplicate: 'Duplicate',
  pin: 'To assets',
  front: 'Bring to front',
  back: 'Send to back',
  download: 'Download',
  archive: 'Archive',
  delete: 'Delete',
}

/**
 * Подпись под именем: размеры, длительность, модель — то, что отличает один
 * объект от соседнего. Имя модели передаёт вызывающий: в объекте лежит только
 * её id, а показывать человеку `seedream-5-pro` вместо «Seedream 5 Pro» —
 * значит показывать наше устройство вместо его материала.
 */
export function subjectDetails(item: CanvasItem, modelName?: string): string {
  const parts: string[] = []
  if (item.kind === 'image' || item.kind === 'video') {
    if (item.naturalWidth && item.naturalHeight) parts.push(`${item.naturalWidth} × ${item.naturalHeight}`)
    else parts.push(`${Math.round(item.w)} × ${Math.round(item.h)}`)
  }
  if (item.duration) parts.push(`${item.duration.toFixed(1)} s`)
  if (modelName) parts.push(modelName)
  return parts.join(' · ')
}

export function subjectTitle(item: CanvasItem): string {
  if (item.kind === 'text') return item.text?.slice(0, 40) || 'Text'
  return item.name || (
    item.kind === 'image' ? 'Image'
      : item.kind === 'video' ? 'Video'
        : item.kind === 'audio' ? 'Track'
          : 'Object'
  )
}
