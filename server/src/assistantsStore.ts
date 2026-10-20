import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { config } from './config.js'
import { logError, logNote } from './log.js'
import { assistantDocMissing } from './assistantDocs.js'
import {
  AssistantsStoreError,
  parseAssistantsState,
  type AssistantDoc,
  type AssistantsState,
} from './assistantsFormat.js'

// Библиотека помощников на диске: data/assistants.json и его запасная копия
// assistants.json.bak. Что считается библиотекой — assistantsFormat.ts; тексты
// документов знаний лежат отдельно — assistantDocs.ts.
//
// ⚠️ Нечитаемый файл — это НЕ пустой список. Раньше любой сбой чтения отдавал
// «помощников нет», и первое же действие с записью клало испорченный файл
// поверх хорошей .bak, а следом записывало библиотеку из одного нового
// помощника: пропадали и список, и копия, ради этого случая и заведённая.
// Правила такие:
//   • файла нет — помощников ещё не заводили, список пуст;
//   • файл не разбирается, а .bak разбирается — работаем с данными из .bak:
//     испорченный файл откладываем рядом под именем с отметкой времени, на его
//     место возвращаем копию — без документов, файлов которых уже нет;
//   • не разбираются оба (или файл не удалось даже прочитать) — отказ словами
//     и НИКАКОЙ записи: всё, что лежит на диске, остаётся как было;
//   • в .bak попадает только файл, который разбирается, а файл, который не
//     разбирается, переписывает только восстановление.
// Так же строги индекс досок и макросы (readIndex в projects.ts, readJson в
// workflows.ts): нет файла — пусто, не читается — отказ. Из копии они сами не
// восстанавливаются — её подкладывают руками. У помощников чинить руками
// некому и нечем (в окне для этого ничего нет), поэтому хорошую копию берём
// сами — как очередь импорта (mediaImportStore.ts), — но испорченный файл при
// этом не затираем, а откладываем.

// Сам класс — в assistantsFormat.ts (почему — сказано там); отсюда его берут
// те, кому нужна ошибка хранилища.
export { AssistantsStoreError }

const dataDir = path.dirname(config.settingsFile)
const stateFile = path.join(dataDir, 'assistants.json')
const backupFile = `${stateFile}.bak`

let queue: Promise<unknown> = Promise.resolve()

/** «Прочитал — изменил — записал» идёт строго по очереди, иначе вторая запись
 *  затёрла бы первую. Восстановление из копии живёт под тем же замком. */
export function withAssistantsLock<T>(run: () => Promise<T>): Promise<T> {
  const next = queue.then(run, run)
  queue = next.then(() => undefined, () => undefined)
  return next
}

/** Текст файла; null — файла нет. Любой другой сбой чтения — исключение. */
async function readText(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/** Записать файл целиком: во временный и переименованием. Недописанного файла
 *  на месте настоящего не бывает. */
async function replaceFile(file: string, text: string): Promise<void> {
  const tmp = `${file}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(tmp, text)
    await fs.rename(tmp, file)
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => {})
  }
}

/** Причина сбоя для журнала: код системы, а если его нет — текст ошибки. */
function causeOf(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code ?? (error instanceof Error ? error.message : String(error))
}

// ⚠️ В журнал — один раз на беду, а не на каждый запрос. Список помощников
// спрашивают часто (окно помощника, каждое обращение к диалогу), а журнал
// живёт до мегабайта: повторы вытеснили бы из него всё остальное.
let lastComplaint: string | null = null

/** Отказ: человеку — `message`, в журнал — он же с подробностями и путём. */
function refusal(message: string, details: string, cause?: unknown): AssistantsStoreError {
  const line = `${message} Details: ${details}. File: ${stateFile}`
  if (line !== lastComplaint) {
    lastComplaint = line
    logNote('assistants', line)
  }
  return new AssistantsStoreError(message, { cause })
}

// Занятый файл — не испорченный: чтение не удалось, но содержимое цело, и
// через минуту его снова можно будет прочитать.
const BUSY = 'The assistant list cannot be read: its file is locked or unavailable. '
  + 'The app made no changes; try again later.'

/** Сколько пропавших документов одного помощника называем в журнале поимённо:
 *  приложить их можно сколько угодно, а строка журнала обязана быть обозримой. */
const MAX_LOST_DOCS_NAMED = 10

/**
 * Убрать из списков помощников документы, файлов которых на диске уже нет.
 * Возвращает, что убрано, — готовыми кусками строки журнала; пусто — все
 * документы на месте, и список не тронут.
 *
 * ⚠️ Запасная копия на шаг старше файла. Если последним перед порчей было
 * «удалить помощника» или «убрать документ», копия ещё числит документы,
 * файлы которых то действие уже стёрло. Вернувшийся из неё помощник
 * показывал их в окне, а в ответы и в файл обмена они не попадали — «тот же
 * самый, только поглупел». Список обязан говорить правду.
 * ⚠️ В обратную сторону не чистим: файл документа, о котором копия не знает
 * (последней была запись с новым документом), остаётся на диске. Он никому не
 * мешает, а на него ссылается отложенный испорченный файл — вдруг его починят
 * руками.
 */
async function dropLostDocs(state: AssistantsState): Promise<string[]> {
  const lost: string[] = []
  for (const preset of state.presets) {
    const gone: AssistantDoc[] = []
    for (const doc of preset.docs) if (await assistantDocMissing(doc.id)) gone.push(doc)
    if (gone.length === 0) continue
    preset.docs = preset.docs.filter((doc) => !gone.includes(doc))
    const names = gone.slice(0, MAX_LOST_DOCS_NAMED).map((doc) => `«${doc.name}»`).join(', ')
    const unnamed = gone.length - MAX_LOST_DOCS_NAMED
    lost.push(`assistant “${preset.name}” — ${names}${unnamed > 0 ? ` and ${unnamed}` : ''}`)
  }
  return lost
}

/**
 * Основной файл не разбирается — берём запасную копию, если разбирается она.
 *
 * ⚠️ Порядок шагов такой, чтобы основной файл не исчезал ни на миг: «файла
 * нет» означает «помощников ещё не заводили», и сбой между шагами превратил
 * бы восстановление в пустой список. Поэтому испорченный файл уходит в
 * сторону КОПИЕЙ, а на его место копия встаёт одним переименованием.
 */
async function recoverFromBackup(broken: unknown): Promise<AssistantsState> {
  let backupText: string | null
  try {
    backupText = await readText(backupFile)
  } catch (error) {
    throw refusal(BUSY, `file — ${causeOf(broken)}; backup read — ${causeOf(error)}`, error)
  }
  let backup: AssistantsState | null = null
  let backupTrouble = 'not found'
  try {
    if (backupText !== null) backup = parseAssistantsState(backupText)
  } catch (error) {
    backupTrouble = causeOf(error)
  }
  if (backup === null || backupText === null) {
    throw refusal(
      'The assistant list cannot be read: its file and backup are corrupted. '
      + 'The app leaves them untouched to preserve usable data. '
      + 'The files assistants.json and assistants.json.bak are in the app data folder (usually server/data). '
      + 'Removing them resets the assistant list.',
      `file — ${causeOf(broken)}; backup — ${backupTrouble}`,
      broken,
    )
  }

  // Убрали хоть один документ — на место файла встаёт уже выверенный список:
  // иначе следующее же чтение вернуло бы убранное. Не убрали ничего — копия
  // слово в слово.
  const lostDocs = await dropLostDocs(backup)
  const restored = lostDocs.length > 0 ? JSON.stringify(backup, null, 2) : backupText

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const aside = path.join(dataDir, `assistants.corrupt-${stamp}.json`)
  try {
    await fs.copyFile(stateFile, aside, fs.constants.COPYFILE_EXCL)
    try {
      await replaceFile(stateFile, restored)
    } catch (error) {
      // Основной файл остался как был — отложенная копия не нужна: иначе
      // каждая новая попытка оставляла бы рядом ещё один такой же файл.
      await fs.rm(aside, { force: true }).catch(() => {})
      throw error
    }
  } catch (error) {
    throw refusal(
      'The assistant list is corrupted and could not be restored: the file is locked or the disk is full. '
      + 'The app made no changes; try again later.',
      `file — ${causeOf(broken)}; restore — ${causeOf(error)}`,
      error,
    )
  }

  lastComplaint = null
  logNote(
    'assistants',
    `assistant file assistants.json cannot be parsed (${causeOf(broken)}) — list restored from backup:  `
    + `assistants ${backup.presets.length}. The last change before the failure may not be included. `
    + `Corrupted file moved aside: ${path.basename(aside)}`
    + (lostDocs.length > 0
      ? `. Documents whose files are no longer on disk were removed from the list:  ${lostDocs.join('; ')}`
      : ''),
  )
  return backup
}

/** Прочитать библиотеку. Звать под замком `withAssistantsLock`. */
export async function readAssistantsState(): Promise<AssistantsState> {
  let text: string | null
  try {
    text = await readText(stateFile)
  } catch (error) {
    // Копия на шаг старше: подменять ею свежий список из-за минутной
    // блокировки нельзя.
    throw refusal(BUSY, `read — ${causeOf(error)}`, error)
  }
  if (text === null) {
    lastComplaint = null
    return { presets: [], activeId: null }
  }
  let state: AssistantsState
  try {
    state = parseAssistantsState(text)
  } catch (error) {
    return recoverFromBackup(error)
  }
  lastComplaint = null
  return state
}

/**
 * Запасная копия перед перезаписью — как у досок и макросов.
 *
 * ⚠️ В копию попадает только файл, который разбирается, и ровно тот текст,
 * который проверили. Файл, который НЕ разбирается, здесь не трогаем вовсе —
 * ни копией, ни записью поверх: его переписывает только восстановление,
 * отлоalive в сторону. В обычной работе сюда такой файл не доходит (перед
 * записью библиотеку читают), это страховка от записи без чтения.
 */
async function keepBackup(): Promise<void> {
  const current = await readText(stateFile)
  if (current === null) return
  try {
    parseAssistantsState(current)
  } catch (error) {
    throw refusal(
      'The assistant list is corrupted; the app did not overwrite it. Try again.',
      `overwrite of an unreadable file — ${causeOf(error)}`,
      error,
    )
  }
  // Копия — страховка, а не условие записи: не легла — прежняя остаётся на месте.
  await replaceFile(backupFile, current).catch(() => {})
}

/** Записать библиотеку. Звать под замком, после `readAssistantsState`. */
export async function writeAssistantsState(state: AssistantsState): Promise<void> {
  try {
    await fs.mkdir(dataDir, { recursive: true })
    await keepBackup()
    await replaceFile(stateFile, JSON.stringify(state, null, 2))
  } catch (error) {
    if (error instanceof AssistantsStoreError) throw error
    logError('assistants', error)
    throw new AssistantsStoreError(
      'Could not save assistants: the file is locked or the disk is full. Try again.',
      { cause: error },
    )
  }
}
