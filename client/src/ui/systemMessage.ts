import { legacyParamRefusal, paramRefusalMessage } from './paramRefusal'
import { t } from '../i18n/translate.js'

/** English presentation for system errors from older servers and saved state.
 * Never run this over user content or whole response documents. */
const LEGACY_MESSAGES: Readonly<Record<string, string>> = {
  'тип файла не поддерживается': 'This file type is not supported.',
  'неподдерживаемый тип файла': 'This file type is not supported.',
  'не удалось прочитать индекс досок': 'Could not read the board index.',
  'ошибка записи снимка': 'Could not save the board snapshot.',
  'слишком много запросов': 'Too many requests. Try again later.',
  'неверный путь к файлу': 'Invalid file path.',
  'нет доступа к файлу доски': "You do not have access to this board's file.",
  'недостаточно прав': 'You do not have permission to do this.',
  'нет прав': 'You do not have permission to do this.',
  'доступ запрещён': 'Access denied.',
  'доступ запрещен': 'Access denied.',
  'доступ отозван': 'Access has been revoked.',
  'требуется вход': 'Sign-in required.',
  'сеанс входа истёк': 'Your session has expired. Sign in again.',
  'сеанс входа истек': 'Your session has expired. Sign in again.',
  'сессия истекла': 'Your session has expired. Sign in again.',
  'войдите в аккаунт': 'Sign in to your account.',
  'сначала выберите команду': 'Select a team first.',
  'файл не найден': 'File not found.',
  'доска не найдена': 'Board not found.',
  'проект не найден': 'Board not found.',
  'задача не найдена': 'Job not found.',
  'диалог не найден': 'Chat not found.',
  'модель не найдена': 'Model not found.',
  'помощник не найден': 'Assistant not found.',
  'макрос не найден': 'Macro not found.',
  'такого адреса нет': 'This address was not found.',
  'сервер не отвечает': 'The server is not responding.',
  'сервер временно недоступен': 'The server is temporarily unavailable.',
  'временно недоступен': 'The server is temporarily unavailable.',
  'нет связи': 'Connection lost.',
  'сеть': 'Network error.',
  'сеть недоступна': 'The network is unavailable.',
  'ошибка сети': 'Network error.',
  'временный сбой сети': 'A temporary network error occurred.',
  'сервер недоступен': 'The server is unavailable.',
  'командный сервер не отвечает': 'The team server is not responding.',
  'файл занят': 'The file is busy.',
  'файл проекта повреждён': 'The project file is corrupted.',
  'файл проекта поврежден': 'The project file is corrupted.',
  'доска удалена': 'The board was deleted.',
  'хранилище недоступно': 'Storage is unavailable.',
  'модель отклонена сервером': 'The model was rejected by the server.',
  'не удалось создать': 'Could not create the item.',
  'не удалось загрузить модели': 'Could not load models.',
  'не удалось загрузить описание модели': 'Could not load the model description.',
  'не удалось загрузить список': 'Could not load the list.',
  'не удалось скачать': 'Download failed.',
  'не удалось сохранить': 'Save failed.',
  'не удалось открыть': 'Could not open the item.',
  'не удалось прочитать vimeo': 'Could not read Vimeo.',
  'видео недоступно': 'Video unavailable.',
  'cdn недоступен': 'The CDN is unavailable.',
  'ошибка загрузки': 'Upload failed.',
  'ошибка скачивания': 'Download failed.',
  'ошибка сохранения': 'Save failed.',
  'неверный ответ сервера': 'The server returned an invalid response.',
  'сервер команды сбросил вход': 'The team server reset your sign-in.',
  'провайдер не ответил за отведённое время': 'The provider did not respond in time.',
  'подтвердите котировку': 'Confirm the price estimate.',
  'подтвердите стоимость': 'Confirm the estimated cost.',
  'недостаточно средств': 'Insufficient balance.',
  'пустой файл': 'The file is empty.',
  // помощник сетевой доски: без перевода эти отказы сервера команды
  // становились «Request failed», и причину не видел никто (19.10.2026)
  'для помощника выберите изображение или кадр из видео': 'The assistant accepts images only. Take a frame from the video.',
  'не удалось подготовить изображения для помощника': 'Could not prepare images for the assistant.',
  'доска недоступна для генерации': 'This board is not available for generation.',
  'диалог находится в корзине': 'This chat is in the trash.',
  'отменено': 'Cancelled',
}

export const SYSTEM_ERROR_FALLBACK = 'Request failed. Open the diagnostic log for details.'

const CODE_MESSAGES: Readonly<Record<string, string>> = {
  MEDIA_LINK_LOGIN_REQUIRED: 'Sign in to the source website to download this file.',
  MEDIA_LINK_LOGIN_STALE: 'Sign in to the source website to download this file.',
  PROMPT_CHAT_COST_CONFIRM_REQUIRED: 'Confirm the estimated cost.',
  PRICE_CONFIRMATION_REQUIRED: 'Confirm the price estimate.',
  UNSUPPORTED_MEDIA_TYPE: 'This file type is not supported.',
  RATE_LIMIT: 'Too many requests. Try again later.',
  AUTH_REQUIRED: 'Sign-in required.',
  UNAUTHORIZED: 'Sign-in required.',
  FORBIDDEN: 'You do not have permission to do this.',
  NOT_FOUND: 'The requested item was not found.',
  JOB_NOT_FOUND: 'Task not found.',
  CANCELLED: 'Cancelled',
}

export function systemMessage(
  message: string | undefined,
  fallback = SYSTEM_ERROR_FALLBACK,
  code?: string,
  details?: unknown,
): string {
  // Отказ «не то значение параметра» называет модель, параметр и значение —
  // фраза собирается, а не берётся из таблицы (см. paramRefusal.ts). Шаблон
  // проверяем ДО разбиения по ': ': в «Размер: 4K» оно есть.
  const refusal = paramRefusalMessage(code, details) ?? (message ? legacyParamRefusal(message) : null)
  if (refusal) return refusal
  if (!message?.trim()) return t(fallback)
  const key = message.trim().replace(/[.!]+$/u, '').toLowerCase()
  const translated = Object.hasOwn(LEGACY_MESSAGES, key) ? LEGACY_MESSAGES[key] : undefined
  if (translated) return t(translated)

  // A local action may prefix an upstream error with its English context.
  const separator = message.lastIndexOf(': ')
  if (separator >= 0 && !/[А-Яа-яЁё]/u.test(message.slice(0, separator))) {
    const prefix = message.slice(0, separator + 2)
    return prefix + systemMessage(message.slice(separator + 2), fallback, code, details)
  }

  // Preserve quoted names only in a named-content context. Arbitrary quoted
  // provider errors and serialized error JSON are still system messages.
  const systemText = message.replace(/"[^"\n]*"|'[^'\n]*'|«[^»\n]*»|“[^”\n]*”|`[^`\n]*`/gu, (quoted, offset: number) => {
    const before = message.slice(0, offset)
    return /(?:board|project|file|folder|model|macro|assistant|profile|member|team|node|asset|image|video|audio|document|prompt|open|upload|download|save|rename|export|import|delete|restore|copy|move)\s*$/iu.test(before)
      ? ''
      : quoted
  }) || message
  if (!/[А-Яа-яЁё]/u.test(systemText)) return t(message)
  return code && Object.hasOwn(CODE_MESSAGES, code) ? t(CODE_MESSAGES[code]) : t(fallback)
}

/**
 * Convert an unknown caught value into a system-facing message.
 *
 * Error values are common at rendering boundaries (toasts, notices and task
 * cards), while persisted snapshots sometimes contain a plain string. Keep
 * this helper deliberately narrow: callers opt into it for fields owned by
 * the application; prompts, board names and generated text must go through
 * unchanged.
 */
export function systemErrorMessage(
  error: unknown,
  fallback = SYSTEM_ERROR_FALLBACK,
  code?: string,
): string {
  const message = error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : undefined
  // Транспорт хранит код и подробности на самой ошибке (TabletHttpError,
  // ApiError) — отказ параметра собирается из них, а не из русской фразы.
  const carried = error instanceof Error ? error as Error & { code?: unknown; details?: unknown } : undefined
  const refusal = paramRefusalMessage(code ?? (typeof carried?.code === 'string' ? carried.code : undefined), carried?.details)
  return refusal ?? systemMessage(message, fallback, code)
}

/**
 * Presentation for a short application-owned progress/stage label. Unknown
 * legacy Cyrillic stages become a neutral English status instead of the
 * diagnostic error copy used by systemErrorMessage. Raw stage values remain
 * in the task/document state for recovery and diagnostics.
 */
const LEGACY_STATUS_MESSAGES: Readonly<Record<string, string>> = {
  'подготовка': 'Preparing…',
  'подготовка…': 'Preparing…',
  'подготовка запроса': 'Preparing request…',
  'загрузка': 'Uploading…',
  'загрузка…': 'Uploading…',
  'скачивание': 'Downloading…',
  'скачивание…': 'Downloading…',
  'генерация': 'Generating…',
  'обработка': 'Processing…',
  'ожидание': 'Waiting…',
  'ожидает': 'Waiting…',
}

export function systemStatusMessage(
  status: string | undefined,
  fallback = 'Working…',
): string {
  if (!status?.trim()) return t(fallback)
  const key = status.trim().replace(/[.!]+$/u, '').toLowerCase()
  const translated = Object.hasOwn(LEGACY_STATUS_MESSAGES, key) ? LEGACY_STATUS_MESSAGES[key] : undefined
  if (translated) return t(translated)
  if (/[А-Яа-яЁё]/u.test(status)) return t(fallback)
  return status
}
