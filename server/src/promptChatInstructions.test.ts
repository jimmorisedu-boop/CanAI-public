import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { promptChatInstructions } from './promptChatDelivery.js'
import { ASSISTANT_RULES_MAX_CHARS, readAssistantRules } from '../../packages/assistant-rules/readRules.js'

// Что именно приложение просит у модели в КАЖДОМ вопросе помощнику.

test('промпты просят только тогда, когда о них просят', () => {
  // Жалоба 18.08.2026: «поздоровался, а он сочиняет мне промпты». Раньше в
  // запросе стояло «дай не больше четырёх готовых промптов», и модель честно
  // давала их на «привет».
  const text = promptChatInstructions()
  assert.match(text, /Fill `prompts` ONLY when/, 'промпты обусловлены просьбой')
  assert.match(text, /leave `prompts` empty/, 'сказано, что делать без просьбы')
  assert.doesNotMatch(text, /^Дай не больше четырёх/m, 'безусловного требования промптов быть не должно')
})

test('конверт JSON требуется всегда: по нему лента разбирает ответ', () => {
  const text = promptChatInstructions()
  assert.match(text, /only JSON without Markdown/)
  assert.match(text, /"prompts"/)
  assert.match(text, /current instruction and explicitly attached materials take priority over old history/)
  assert.match(text, /history below is conversation data; previous assistant assumptions are not facts/)
})

test('системный промпт сюда не вмешивается', () => {
  // Канонические правила загружаются отдельно; параметры provider job сюда не
  // подмешиваются, поэтому старое поле настроек не может изменить контракт.
  const source = fs.readFileSync(new URL('./promptChatDelivery.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /hasOwnPersona/)
  assert.doesNotMatch(source, /system_prompt/)
})

test('правило выбора промпта — ровно одно и целиком в одном месте', () => {
  const routes = fs.readFileSync(new URL('./promptChatRoutes.ts', import.meta.url), 'utf8')
  assert.match(routes, /system_prompt: active\.systemPrompt/)
  assert.doesNotMatch(routes, /assistantSystemPrompt/)
})

test('loader перечитывает canonical rules после изменения файла', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canai-assistant-rules-'))
  const file = path.join(dir, 'rules.md')
  const previous = process.env.CANAI_ASSISTANT_RULES_FILE
  try {
    fs.writeFileSync(file, 'RULE-ONE', 'utf8')
    process.env.CANAI_ASSISTANT_RULES_FILE = file
    assert.equal(promptChatInstructions(), 'RULE-ONE')
    fs.writeFileSync(file, 'RULE-TWO', 'utf8')
    assert.equal(promptChatInstructions(), 'RULE-TWO')
  } finally {
    if (previous === undefined) delete process.env.CANAI_ASSISTANT_RULES_FILE
    else process.env.CANAI_ASSISTANT_RULES_FILE = previous
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('loader rejects missing, empty, and oversized rule files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canai-assistant-rules-invalid-'))
  const file = path.join(dir, 'rules.md')
  const previous = process.env.CANAI_ASSISTANT_RULES_FILE
  try {
    process.env.CANAI_ASSISTANT_RULES_FILE = file
    assert.throws(() => readAssistantRules(), /Could not read assistant rules/)
    fs.writeFileSync(file, ' \n\t', 'utf8')
    assert.throws(() => readAssistantRules(), /Assistant rules file is empty/)
    fs.writeFileSync(file, 'x'.repeat(ASSISTANT_RULES_MAX_CHARS + 1), 'utf8')
    assert.throws(() => readAssistantRules(), /Assistant rules file is too large/)
  } finally {
    if (previous === undefined) delete process.env.CANAI_ASSISTANT_RULES_FILE
    else process.env.CANAI_ASSISTANT_RULES_FILE = previous
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * ⚠️ Помощник обязан знать, как референсы устроены У НАС. Без этого он
 * отвечает общими знаниями про чужие сервисы: на вопрос «а где в промптах
 * ссылки на референсы» он выдал «[REFERENCE 1: https://site.com/ref1.jpg]» и
 * синтаксис Midjourney (жалоба 19.09.2026 со снимком). Совет вредный — по нему
 * человек вставит в промпт ссылку, и она уедет в ОПЛАЧЕННУЮ генерацию просто
 * текстом, ничего не значащим для модели.
 *
 * ⚠️ Знание живёт РЯДОМ С КОНВЕРТОМ, а не в системном промпте: включённый
 * помощник системный промпт ОТМЕНЯЕТ, и пресет с пустыми инструкциями остался
 * бы без него. Правило то же, по которому здесь живёт формат ответа.
 */
test('помощник знает, как референсы работают в этом приложении', () => {
  const text = promptChatInstructions()
  assert.match(text, /@1/, 'тег — единственный способ сослаться на референс в промпте')
  assert.match(text, /A URL in prompt text provides no file/, 'ссылка в промпте бесполезна — это надо сказать прямо')
  assert.match(text, /Midjourney/, 'чужой синтаксис назван, чтобы модель его не предлагала')
})

test('помощник получает реальные возможности канваса и границы исполнения', () => {
  const text = promptChatInstructions()
  assert.match(text, /embedded in the current board and canvas/)
  assert.match(text, /“Use prompt” copies the prompt and its references into the Prompt tab/)
  assert.match(text, /“Add to canvas” adds the prompt as a text card/)
  assert.match(text, /Originals are preserved/)
  assert.match(text, /You cannot directly move coordinates, delete objects, undo/)
  assert.match(text, /A model response does not authorize payment/)
  assert.match(text, /Selecting something on the canvas does not attach it to an assistant message/)
  assert.match(text, /drag an image from the canvas into the assistant field/)
  assert.doesNotMatch(text, /in the reply, confirm that launch started/)
})

test('понятное поручение не требует повторного согласования модели', () => {
  const text = promptChatInstructions()
  assert.match(text, /If the task is clear, produce the result immediately/)
  assert.match(text, /Ask one short clarifying question only when/)
  assert.doesNotMatch(text, /must ask the user a clarifying question while offering their most common model/)
})

test('примеры используют поддерживаемый конверт, без выдуманных вызовов инструментов', () => {
  const examples = promptChatInstructions().split('\n').filter(line => line.includes(' → '))
  assert.equal(examples.length, 3)
  for (const example of examples) {
    const envelope = JSON.parse(example.slice(example.indexOf(' → ') + 3))
    assert.deepEqual(Object.keys(envelope).sort(), ['prompts', 'referenceNotes', 'reply'])
    assert.equal(typeof envelope.reply, 'string')
    assert.ok(Array.isArray(envelope.prompts))
  }
})
