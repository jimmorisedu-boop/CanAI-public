import type { PromptChatSuggestion } from '../spaces/canvas/promptChatTypes'

/** Старые ответы без JSON: извлекаем только явно помеченные промпты. */
export function assistantPromptVariants(text: string): PromptChatSuggestion[] {
  const labels = [...text.matchAll(/(?:\*\*)?(?:Prompt|Промпт)\s*[:：](?:\*\*)?\s*/giu)]
  return labels.flatMap((label, index) => {
    const start = label.index! + label[0].length
    const section = text.slice(start, labels[index + 1]?.index ?? text.length)
    const prompt = section.split(/\s*(?:\(?\s*\*?\*?(?:Перевод|Translation)\s*[:：]|\n\s*#{1,6}\s|\n\s*---)/iu)[0]!
      .replace(/^\s*[>"“]+\s*/u, '').replace(/["”*\s]+$/u, '').trim()
    return prompt ? [{ title: `Variant ${index + 1}`, prompt }] : []
  }).slice(0, 4)
}
