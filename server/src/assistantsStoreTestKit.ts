import fs from 'node:fs/promises'
import path from 'node:path'
import type { TestContext } from 'node:test'

// Оснастка тестов хранилища помощников — одна на assistantsStore.test.ts
// (запись и запасная копия) и assistantsRecovery.test.ts (восстановление из
// копии): библиотека-образец, способы её испортить и взгляд на диск.
//
// ⚠️ Модулей приложения здесь нет намеренно — только их типы. Папку данных
// выбирает config.ts при первом импорте, поэтому каждый тестовый файл сам
// задаёт её, сам импортирует ./assistants.js и передаёт сюда готовое. Импорт
// приложения отсюда выполнился бы раньше и увёл тест в настоящую папку данных.

type Assistants = typeof import('./assistants.js')

/** Помощники образца — в том порядке, в каком их заводит `library()`. */
export const EVERYONE = ['Арт-директор', 'Редактор', 'Сценарист']

/** Сбой файловой системы с кодом — каким его отдаёт Node. */
export const failure = (code: string): Error => Object.assign(new Error(`${code}: файл занят`), { code })

// ⚠️ Смотрим только на имена, которые в папку данных кладёт само приложение:
// библиотека, её копия, отложенный файл, их временные файлы и документы.
// Антивирус, проверяя только что заменённый или удалённый файл, на миг
// оставляет рядом свой «ИМЯ.tmp» (поймано на машине с Kaspersky:
// ASSISTANTS.JSON.BAK.tmp) — перечисление всей папки от этого мигало.
const OWN_FILE = /^assistants\.(?:json(?:\.bak)?(?:\.[0-9a-f-]{36}\.tmp)?|corrupt-[\dTZ-]+\.json)$/u
const OWN_TEMP = /\.tmp$/u
const DOC_FILE = /^[0-9a-f-]{36}\.txt$/u

const text = (file: string): Promise<string> => fs.readFile(file, 'utf8')
const ownFiles = async (dir: string, own: RegExp): Promise<string[]> => (
  (await fs.readdir(dir).catch(() => [] as string[])).filter((name) => own.test(name)).sort()
)

export function assistantsBench(dataDir: string, assistants: Assistants) {
  const stateFile = path.join(dataDir, 'assistants.json')
  const backupFile = `${stateFile}.bak`
  const docsDir = path.join(dataDir, 'assistant-docs')
  const logFile = path.join(dataDir, 'logs', 'server.log')
  /** Журнал с начала текущего случая: сам файл между случаями не трогаем. */
  let journalStart = 0
  const journal = async (): Promise<string> => (await text(logFile).catch(() => '')).slice(journalStart)

  return {
    stateFile,
    backupFile,
    text,
    journal,
    names: async (): Promise<string[]> => (await assistants.listAssistants()).presets.map((item) => item.name),
    /** Названия помощников в тексте файла библиотеки; обрезок не разберётся. */
    stored: (raw: string): string[] => (JSON.parse(raw) as { presets: Array<{ name: string }> }).presets.map((item) => item.name),
    /** Отложенные испорченные файлы. */
    asideFiles: async (): Promise<string[]> => (await ownFiles(dataDir, OWN_FILE)).filter((name) => name.startsWith('assistants.corrupt-')),
    /** Временные файлы записи, оставшиеся в папке данных: в норме их нет. */
    tempFiles: async (): Promise<string[]> => (await ownFiles(dataDir, OWN_FILE)).filter((name) => OWN_TEMP.test(name)),
    storeRefusal: (pattern: RegExp) => (error: unknown): boolean => (
      error instanceof assistants.AssistantsStoreError && pattern.test(error.message)
    ),

    /** Всё, что приложение держит на диске: путь → содержимое. */
    async disk(): Promise<Record<string, string>> {
      const found: Record<string, string> = {}
      for (const name of await ownFiles(dataDir, OWN_FILE)) found[name] = await text(path.join(dataDir, name))
      for (const name of await ownFiles(docsDir, DOC_FILE)) found[`assistant-docs/${name}`] = await text(path.join(docsDir, name))
      return found
    },

    /** Чистая папка данных: каждый случай портит библиотеку по-своему. */
    async reset(t: TestContext): Promise<void> {
      // Строки журнала дублируются в консоль — в отчёте прогона они только шум.
      t.mock.method(console, 'log', () => {})
      t.mock.method(console, 'error', () => {})
      // ⚠️ Здесь удаление — условие следующего случая, а не уборка: на Windows
      // только что записанный файл ещё держит антивирус, поэтому повторов с
      // запасом. Журнал не удаляем вовсе — запоминаем, где он кончался.
      for (const name of await fs.readdir(dataDir)) {
        if (name === 'logs') continue
        await fs.rm(path.join(dataDir, name), { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
      }
      journalStart = 0
      journalStart = (await journal()).length
      await assistants.listAssistants()
    },

    /** Три помощника, у первого документ, первый включён. */
    async library(): Promise<{ first: string; docId: string }> {
      const first = await assistants.saveAssistant({ name: 'Арт-директор', instructions: 'Проверяй композицию', modelId: 'gemini' })
      const doc = await assistants.addAssistantDoc(first.id, 'бренд.txt', 'Цвета бренда: вермилион.')
      await assistants.saveAssistant({ name: 'Редактор', instructions: 'Правь текст', modelId: 'gemini' })
      await assistants.saveAssistant({ name: 'Сценарист', instructions: 'Пиши сцены', modelId: 'gemini' })
      await assistants.setActiveAssistant(first.id)
      return { first: first.id, docId: doc.id }
    },

    /** Файл, обрезанный сбоем: начало настоящего, но JSON уже не разбирается. */
    async truncate(file: string): Promise<string> {
      const cut = (await text(file)).slice(0, 60)
      await fs.writeFile(file, cut)
      return cut
    },
  }
}
