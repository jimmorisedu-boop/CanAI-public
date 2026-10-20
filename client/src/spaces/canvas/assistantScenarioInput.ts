import { selectionFromAttachment } from './assistantAsk'
import type { SelectionRef } from './konva/selection'
import type { PromptChatMessage } from './promptChatTypes'

export interface ScenarioInput {
  // вход сценария, который надо записать в ленту ДО запуска; null — записывать
  // нечего, цепочка идёт по тому, что уже сказано в разговоре
  record: { text: string; refs: SelectionRef[] } | null
  // на чём реально пойдёт цепочка
  runRefs: SelectionRef[]
  // очистить ли поле и ручные чипы (их содержимое уже уехало в запись)
  clearComposer: boolean
}

// На чём запускается цепочка помощника. Правило неочевидное и до сих пор жило
// шестьюдесятью строками прямо в разметке кнопки:
//
// — Напечатанный текст побеждает: он идёт референсом вместе с чипами, пишется
//   в ленту как вход сценария, а поле очищается. Запись делается ДО запуска,
//   иначе прогон пошёл бы от материала, которого в разговоре не видно.
// — Поля не тронули — цепочка продолжает разговор: подхватывается ПОСЛЕДНЕЕ
//   сообщение пользователя целиком, вместе с его вложениями. Иначе кнопка на
//   пустом поле запускала бы сценарий вообще без материала.
export function assistantScenarioInput(input: {
  typedPrompt: string
  composerRefs: SelectionRef[]
  messages: PromptChatMessage[]
}): ScenarioInput {
  const sentRefs = input.composerRefs.map((ref) => ({ ...ref }))
  const typed = input.typedPrompt.trim()

  if (typed) {
    return {
      record: { text: typed, refs: sentRefs },
      runRefs: [
        ...sentRefs,
        { shapeId: 'prompt-input-text', kind: 'text', label: "text", text: typed },
      ],
      clearComposer: true,
    }
  }

  const lastUser = [...input.messages].reverse().find((message) => message.role === 'user')
  const runRefs = [...sentRefs]
  if (lastUser?.text) {
    runRefs.push({
      shapeId: 'last-user-msg-text',
      kind: 'text',
      label: "text",
      text: lastUser.text,
    })
  }
  for (const attachment of lastUser?.attachments ?? []) {
    runRefs.push(selectionFromAttachment(attachment))
  }
  return { record: null, runRefs, clearComposer: false }
}
