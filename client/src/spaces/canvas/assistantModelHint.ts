/**
 * Список модели диалога помощника: что в нём показать и почему он выключен.
 * Одно правило на компьютер (`AssistantShelf`) и планшет (`TabletPrompt`) —
 * по списку на каждом экране разошлись бы при первой же правке (так и вышло:
 * подсказка о выключенном списке появилась только у компьютера).
 *
 * Без React: это правила, а не разметка, и проверяются они отдельно от неё.
 */

export type AssistantChatLoadState = 'idle' | 'loading' | 'ready' | 'error'

export interface AssistantModelOption {
  value: string
  label: string
  /** Пункт-пояснение, а не выбор: показывается, но выбрать его нельзя. */
  disabled?: boolean
  title?: string
}

interface CatalogEntry {
  id: string
  name: string
  kind: string
}

/**
 * Почему список моделей выключен. Модель принадлежит диалогу, и пока его нет,
 * выбирать её не для чего — но молчащий выключенный список читается как
 * сломанный (жалоба 09.10.2026 «не открывается выбор модели»).
 */
export function modelSelectHint(loadState: AssistantChatLoadState): string {
  return loadState === 'error'
    ? "The chat did not load - click “Retry” and the model can be selected"
    : "The model can be selected when the chat loads"
}

/**
 * Подпись списка, когда у диалога нет модели. Без неё в выключенном списке
 * стояла бы первая модель каталога (читается как выбор) либо, на планшете,
 * «Загрузка моделей…» — хотя модели давно пришли, а не загрузился диалог.
 */
function noDialogLabel(
  loadState: AssistantChatLoadState,
  catalogHasTextModels: boolean,
): string {
  // Сбой диалога называем первым: именно у него есть кнопка «Повторить».
  if (loadState === 'error') return "Chat didn't load"
  if (!catalogHasTextModels) return "Loading models..."
  return loadState === 'ready' ? "No chat selected" : "Loading chat..."
}

/**
 * Пункты списка модели диалога.
 *
 * ⚠️ Список не имеет права врать. Модель диалога задаёт сервер (выбор диалога,
 * модель помощника или умолчание), и в каталоге её может не быть — например,
 * тимлид снял модель с публикации. Тогда без отдельного пункта в шапке стояла
 * бы ПЕРВАЯ модель каталога, а выбрать её было бы нельзя: она и так «выбрана»,
 * событие change не приходит.
 */
export function assistantModelOptions(input: {
  models: readonly CatalogEntry[]
  /** Модель активного диалога; пусто — диалога нет. */
  selectedModelId: string | undefined
  chatLoadState: AssistantChatLoadState
}): AssistantModelOption[] {
  const text: AssistantModelOption[] = input.models
    .filter((model) => model.kind === 'text')
    .map((model) => ({ value: model.id, label: model.name }))
  const selected = input.selectedModelId ?? ''

  if (!selected) {
    return [
      {
        value: '',
        label: noDialogLabel(input.chatLoadState, text.length > 0),
        disabled: true,
      },
      ...text,
    ]
  }
  if (text.some((option) => option.value === selected)) return text
  // Каталог ещё не пришёл — имя модели узнать не у кого, остаётся её id; а
  // «недоступна» про неё можно сказать, только увидев каталог без неё.
  if (text.length === 0) return [{ value: selected, label: selected, disabled: true }]
  return [
    {
      value: selected,
      label: `Model not available ${selected}`,
      disabled: true,
      title: `Model “${selected}” is not in the catalog - select another`,
    },
    ...text,
  ]
}
