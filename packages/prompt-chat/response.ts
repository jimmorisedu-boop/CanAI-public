import { SALVAGE_MAX, salvagePrompts, type PromptChatSuggestion } from './salvage.js'
import { findEnvelope, salvageReply } from './envelope.js'

/**
 * Разбор ответа помощника: текст, готовые промпты, заметки к референсам.
 *
 * ⚠️ Разбор ОДИН на всё приложение, и живёт он здесь, а не у сервера. Читают
 * его трое: помощник своей доски (server/src/promptChatDelivery.ts), мост к
 * серверу команды (server/src/cloudPromptChats.ts) и планшет — тот ходит к
 * серверу команды сам, мимо компьютера, и разбирает ответ у себя
 * (client/src/tablet/cloudPromptChatView.ts). Пока у планшета была своя копия,
 * три починки до неё не доехали: ответ без списка промптов показывался сырым
 * JSON (09.09.2026), пятый промпт пропадал (18.09.2026), слова вокруг конверта
 * роняли разбор (20.09.2026) — человек видел на двух своих устройствах разное
 * (проверка 02.10.2026).
 */

export type { PromptChatSuggestion }

export interface ParsedPromptChatResponse {
  reply: string
  prompts: PromptChatSuggestion[]
  referenceNotes: string[]
}

function safeText(value: string, max: number): string {
  return value
    .replace(/data:[^\s"'<>]+/gi, '[inline data removed]')
    .trim()
    .slice(0, max)
}

// ⚠️ Ответ НЕ превращается в «готовый промпт» сам по себе. Правило одно:
// промпты предлагаются, только когда о них попросили. Инструкция моделям это
// говорит прямо, и модели её слушаются — а вот разбор ответа раньше сводил всё
// на нет: и здесь, и в основной ветке пустой список подменялся текстом ответа.
// Итог: на «сколько будет два плюс два» приходила карточка «Готовый промпт:
// два плюс два будет четыре» (найдено прогоном 20.08.2026).
function fallback(raw: string): ParsedPromptChatResponse {
  // ⚠️ Конверт мог оборваться на полуслове (упёрлись в потолок токенов).
  // Ответ оплачен и написан — показываем его текст, а не машинный обрезок.
  const salvaged = salvageReply(raw)
  const text = safeText(salvaged ?? raw, 12_000)
  if (!text) return { reply: '', prompts: [], referenceNotes: [] }
  // ⚠️ Конверта нет — но промпты в тексте МОГУТ лежать списком, и тогда они
  // обязаны стать карточками с кнопками: правило продукта «есть промпты —
  // есть кнопки». Признак узкий (см. salvage.ts), обычный ответ карточками не
  // становится, а сам текст остаётся нетронутым.
  return { reply: text, prompts: salvagePrompts(text), referenceNotes: [] }
}

function parseSuggestion(value: unknown): PromptChatSuggestion | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as { title?: unknown; prompt?: unknown }
  if (typeof raw.title !== 'string' || typeof raw.prompt !== 'string') return null
  const title = safeText(raw.title, 200)
  const prompt = safeText(raw.prompt, 12_000)
  return title && prompt ? { title, prompt } : null
}

function parseReferenceNotes(value: unknown, hasAttachments: boolean): string[] {
  if (!hasAttachments || !Array.isArray(value)) return []
  if (JSON.stringify(value).toLocaleLowerCase('ru-RU').includes('data:')) return []
  return value
    .filter((note): note is string => typeof note === 'string')
    .map((note) => safeText(note, 200))
    .filter(Boolean)
    .slice(0, 8)
}

export function parsePromptChatResponse(
  rawResponse: string,
  hasAttachments = false,
): ParsedPromptChatResponse {
  const raw = rawResponse.trim()
  if (!raw) return { reply: '', prompts: [], referenceNotes: [] }
  const parsed = findEnvelope(raw)
  // ⚠️ Опознаём ответ по ОДНОМУ признаку — строке `reply`. Раньше требовался
  // ещё и массив `prompts`, и это противоречило собственной инструкции: мы
  // просим модель не предлагать промпты, пока о них не попросили, — она
  // слушается и ключ не пишет вовсе. Разбор объявлял такой ответ чужим и
  // показывал человеку СЫРОЙ JSON: «{"reply":"Понял: нужно убрать…»
  // (жалоба 09.09.2026 «в помощнике интерфейс изменился вдруг»). Нет
  // промптов — значит их нет, а не «это не наш формат».
  if (!parsed) return fallback(raw)

  const reply = safeText(parsed.reply, 12_000)
  // ⚠️ Потолок был 4, и он спорил с человеком: на просьбу «напиши 5
  // промптов» пятый молча пропадал по дороге. Сколько попросили — столько и
  // показываем; разумный предел остаётся, чтобы лента не превращалась в
  // простыню карточек.
  const prompts = (Array.isArray(parsed.prompts) ? parsed.prompts : [])
    .map(parseSuggestion)
    .filter((suggestion): suggestion is PromptChatSuggestion => Boolean(suggestion))
    .slice(0, SALVAGE_MAX)
  // Пустой список промптов — это ОТВЕТ модели, а не пробел, который надо
  // заполнить: именно так она отвечает на обычный вопрос. ⚠️ Но если модель
  // сложила промпты СПИСКОМ в сам текст — это не «промптов нет», а нарушенный
  // конверт, и кнопки человеку всё равно положены.
  return {
    reply,
    prompts: prompts.length > 0 ? prompts : salvagePrompts(reply),
    referenceNotes: parseReferenceNotes(parsed.referenceNotes, hasAttachments),
  }
}
