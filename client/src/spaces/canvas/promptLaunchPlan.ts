import type { CatalogModel } from '../../types'
import { estimatedAspectRatio } from './genOptions'
import type { SelectionRef } from './konva/selection'
import type { CanvasItem } from './konva/types'
import { materializeModelParams } from './modelParamContract'
import { AUDIO_ITEM_HEIGHT, AUDIO_ITEM_WIDTH } from './konva/audioMeta'

export interface LaunchPlanInput {
  kind: 'image' | 'video' | 'audio'
  params: Record<string, unknown>
  count: number
  refs: SelectionRef[]
  // id картинки, поверх которой рисуют: она уходит референсом ВМЕСТО выделения
  sketchTarget: string | null
  // что напечатано в поле промпта
  typedPrompt: string
  // объект с холста по id — нужен ради натуральных размеров референса
  itemById(id: string): CanvasItem | undefined
  // Кто выбирает модель, решает вызывающий, и это НЕ придирка: обычный запуск
  // берёт уже посчитанную effModel (она смотрит на набор чипов), а запуск из
  // помощника приходит со своим набором референсов и модель пересчитывает.
  // Слить их в одно правило — значит незаметно поменять то, за что платят.
  resolveModel(hasImageRefs: boolean, hasVideoRefs: boolean): CatalogModel | null
  /** Десктопный промпт разрешает «Авто» и без референса. */
  allowAutoWithoutRefs?: boolean
}

export interface LaunchPlan {
  // пустая строка означает «запускать нечего»
  text: string
  // что уйдёт референсами на сервер
  refsToSend: SelectionRef[]
  hasImageRefs: boolean
  hasVideoRefs: boolean
  model: CatalogModel | null
  params: Record<string, unknown>
  // сколько параллельных задач: «количество» есть только у картинок
  jobs: number
  // возле чего встанут заглушки
  anchorIds: string[]
  // пропорции заглушки — как у будущего результата
  aspect: number
}

// Что именно уйдёт в генерацию. Вынесено из submit() чистой функцией не ради
// длины файла: здесь живут три правила, каждое из которых уже приводило к
// осязаемым потерям.
//
// 1. Пустое поле + выделенный текст = текст становится промптом. Тогда его
//    НЕЛЬЗЯ слать ещё и референсом: сервер дописывает текст-референсы в конец
//    промпта (withTextSuffix), и фраза задваивалась бы.
// 2. hasMediaRefs и десктопное разрешение «Авто» обязаны дойти до
//    materializeModelParams: иначе «Авто» подменяется первой не-авто опцией (у
//    GPT это 1:1), и UI расходится с реально отправленным запросом.
// 3. Пропорции заглушки берутся у первого медиа-референса по НАТУРАЛЬНЫМ
//    размерам: на холсте объект может быть растянут, и по нему заглушка вышла
//    бы непохожей на результат.
export function planGeneration(input: LaunchPlanInput): LaunchPlan {
  const {
    kind, params, count, refs, sketchTarget, typedPrompt, itemById, resolveModel,
    allowAutoWithoutRefs = false,
  } = input

  const typed = typedPrompt.trim()
  const textRefs = refs.filter((ref) => ref.kind === 'text')
  const text = typed || textRefs.map((ref) => ref.text ?? '').filter(Boolean).join(' ')

  // правило 1
  const refsToSend = typed ? refs : refs.filter((ref) => ref.kind !== 'text')

  const hasImageRefs = refs.some((ref) => ref.kind !== 'text') || Boolean(sketchTarget)
  const hasVideoRefs = kind === 'video' && refs.some((ref) => ref.kind === 'video')

  const model = resolveModel(hasImageRefs, hasVideoRefs)
  const referenceRatio = referenceAspectRatio(refs, sketchTarget, itemById)
  // правило 2
  const picked = materializeModelParams(model, params, {
    hasMediaRefs: hasImageRefs,
    allowAutoWithoutRefs,
    referenceAspectRatio: referenceRatio,
  })

  const anchorIds = sketchTarget
    ? [sketchTarget]
    : refs
        .filter((ref) => ref.kind !== 'text' && !ref.shapeId.startsWith('asset:'))
        .map((ref) => ref.shapeId)

  return {
    text: text.trim(),
    refsToSend,
    hasImageRefs,
    hasVideoRefs,
    model,
    params: picked,
    jobs: kind === 'image' ? count : 1,
    anchorIds,
    // У звука пропорций нет: заглушка должна быть плашкой, а не квадратом,
    // иначе результат встанет совсем не туда, куда указывало ожидание.
    aspect: kind === 'audio'
      ? AUDIO_ITEM_WIDTH / AUDIO_ITEM_HEIGHT
      : estimatedAspectRatio(model, picked, referenceRatio),
  }
}

// правило 3
export function referenceAspectRatio(
  refs: SelectionRef[],
  sketchTarget: string | null,
  itemById: (id: string) => CanvasItem | undefined,
): number | null {
  if (sketchTarget) {
    const item = itemById(sketchTarget)
    return item && item.h > 0 ? item.w / item.h : null
  }
  const first = refs.find((ref) => ref.kind !== 'text')
  if (!first) return null
  const item = itemById(first.shapeId)
  if (item) {
    const w = item.naturalWidth ?? item.w
    const h = item.naturalHeight ?? item.h
    return w > 0 && h > 0 ? w / h : null
  }
  // ассет с полки на холсте не лежит — у него свои размеры
  return first.w && first.h ? first.w / first.h : null
}
