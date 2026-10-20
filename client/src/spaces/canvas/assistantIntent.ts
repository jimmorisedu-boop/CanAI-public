import type { PromptChatMessage } from './promptChatTypes'

export interface GenerationIntentResult {
  isGenerationOrder: boolean
  mediaKind?: 'image' | 'video'
  requestedCount?: number
}

const GENERATION_VERB_RE = /(?:^|[^\p{L}\p{N}])(?:сделай|создай|сгенерируй|нарисуй|запусти|отрендери|выдай|построй|make|generate|create|draw|render)(?:[^\p{L}\p{N}]|$)/iu
const JUST_PROMPTS_RE = /(?:только|просто)?\s*(?:напиши|придумай|сочини|предложи|дай|сделай|создай|подготовь)\s+(?:мне\s+)?(?:готов(?:ый|ые)?\s+)?(?:\d+\s+)?(?:промпт|текст|идеи|вариант)|\b(?:just\s+|only\s+|simply\s+)?(?:write|make|create|draft|prepare|suggest|give|generate)\s+(?:me\s+)?(?:\d+\s+)?(?:an?\s+)?(?:(?:image|video|audio)\s+)?(?:prompt|prompts|text|ideas|variants)\b/iu
const EDIT_VERB_RE = /(?:^|[^\p{L}\p{N}])(?:измени|отредактируй|перерисуй|перекрась|edit|change|redraw|recolor)(?:[^\p{L}\p{N}]|$)/iu
const NON_MEDIA_EDIT_RE = /(?:измени|отредактируй)\s+(?:(?:мои|мой|мне|эти|этот|свои|свой)\s+)?(?:настройк|инструкци|промпт|ответ|сообщени)|\b(?:edit|change|rewrite|update)\s+(?:(?:my|the|these|this)\s+)?(?:settings?|instructions?|prompt|response|message)\b/iu
const VIDEO_WORDS_RE = /(?:видео|ролик|motion|video|клип|анимац)/iu
const IMAGE_WORDS_RE = /(?:фото|картинк|арт|рисун|изображен|кадр|image|photo|picture)/iu
const COUNT_RE = /(\d+)\s*(?:фото|видео|картинок|изображений|роликов|вариант|кадр|image|images|photo|photos|video|videos|clip|clips|variant|variants|frame|frames|prompt|prompts)/iu

/**
 * Распознаёт намерение пользователя: просил ли он сгенерировать контент
 * на холсте («сделай 10 фото или видео») или просто попросил сочинить промпты.
 */
export function detectGenerationIntent(
  messages: readonly PromptChatMessage[],
  currentMessageIndex: number,
): GenerationIntentResult {
  const currentMsg = messages[currentMessageIndex]
  if (!currentMsg || currentMsg.role !== 'assistant') {
    return { isGenerationOrder: false }
  }
  if (!currentMsg.prompts || currentMsg.prompts.length === 0) {
    return { isGenerationOrder: false }
  }

  // Intent определяется по ТЕКУЩЕМУ запросу, а не по всем старым репликам
  // (§10.1 плана: «старые реплики не дают разрешения на запуск»). Граница
  // окна — последний ответ помощника, который УЖЕ отдал готовые промпты:
  // он закрывает предыдущий заказ, и всё, что после него, — новый запрос.
  // Уточнения помощника без промптов (prompts: []) окно не закрывают —
  // иначе «сделай 4 видео» + «16:9» перестал бы распознаваться.
  let requestStart = 0
  for (let i = currentMessageIndex - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role === 'assistant' && m.prompts && m.prompts.length > 0) {
      requestStart = i + 1
      break
    }
  }

  const userMessages = messages
    .slice(requestStart, currentMessageIndex)
    .filter((m) => m.role === 'user')

  if (userMessages.length === 0) {
    return { isGenerationOrder: false }
  }

  const allUserText = userMessages.map((m) => m.text).join('\n')
  const lastUserText = userMessages[userMessages.length - 1].text.trim()

  // Если в последнем вопросе человек прямо просил «напиши промпты» — это текстовая помощь, не запуск
  if (JUST_PROMPTS_RE.test(lastUserText)) {
    return { isGenerationOrder: false }
  }

  const hasImageRef = userMessages.some(message => message.attachments?.some(ref => ref.kind === 'image'))
  const hasVideoRef = userMessages.some(message => message.attachments?.some(ref => ref.kind === 'video'))
  const isEdit = EDIT_VERB_RE.test(allUserText) && !NON_MEDIA_EDIT_RE.test(lastUserText) && (hasImageRef || hasVideoRef)
  const isExplicitGeneration = GENERATION_VERB_RE.test(allUserText) || isEdit

  let mediaKind: 'image' | 'video' | undefined
  if (VIDEO_WORDS_RE.test(allUserText) || isEdit && hasVideoRef && !hasImageRef && !IMAGE_WORDS_RE.test(allUserText)) {
    mediaKind = 'video'
  } else if (IMAGE_WORDS_RE.test(allUserText) || isEdit && hasImageRef) {
    mediaKind = 'image'
  }

  const countMatch = allUserText.match(COUNT_RE)
  const requestedCount = countMatch ? parseInt(countMatch[1], 10) : undefined

  return {
    isGenerationOrder: isExplicitGeneration,
    mediaKind,
    requestedCount,
  }
}
