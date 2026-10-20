import { api, type MacroScope } from '../../api'
import type { CatalogDefaults, CatalogModel, ProjectSource } from '../../types'
import { defaultNodeModelId } from '../nodes/nodeModel'
import type { NodeKind } from '../nodes/types'
import {
  cleanName, isMacroText, libraryFileName, serializeLibraryFile, type LibraryCatalog,
} from './libraryFile'
import { pickLibraryFile, saveLibraryFile } from './libraryFileIO'
import { buildMacroFile, readMacroFile } from './macroFile'
import { adaptMacroFile } from './macroFileAdapt'

// Макрос наружу и обратно: файлом и через буфер обмена — для своей доски и
// сетевой. Что лежит в файле, решает macroFile.ts, как граф подгоняется под
// каталог получателя — macroFileAdapt.ts; здесь только каталог, диск, буфер и
// библиотека.
//
// ⚠️ Путь внутрь ОДИН — `importMacroFromText`: и «Из файла», и Ctrl+V. Раньше
// вставка из буфера клала граф как есть, мимо чистки и перевода каталога:
// макрос, скопированный на своей доске и вставленный на сетевой, нёс чужие
// модели и параметры и падал на запуске.

/** Ровно то, что обмену нужно от api: тест подставляет своё. */
export interface MacroLibraryApi {
  models(): Promise<{ models: CatalogModel[]; defaults?: CatalogDefaults }>
  saveMacro(
    name: string,
    graph: unknown,
    id?: string,
    slot?: number,
    baseRevision?: number,
    scope?: MacroScope,
  ): Promise<unknown>
}

/** Чей каталог моделей у макросов этой доски. */
export function macroCatalogOf(_source: ProjectSource): LibraryCatalog {
  return 'local'
}

async function loadCatalog(
  source: ProjectSource,
  library: MacroLibraryApi,
): Promise<{ models: CatalogModel[]; defaults?: CatalogDefaults }> {
  // Тот же локальный каталог, по которому редактор нод рисует ноды.
  const local = await library.models()
  return { models: local.models, defaults: local.defaults }
}

/** Отдаёт макрос файлом. Возвращает пояснение, если что-то в файл не попало. */
export async function exportMacroToFile(
  macro: { name: string; graph: unknown },
  source: ProjectSource,
  library: MacroLibraryApi = api,
): Promise<string | null> {
  const { models } = await loadCatalog(source, library)
  const { file, droppedFiles } = buildMacroFile(macro, macroCatalogOf(source), models)
  saveLibraryFile(libraryFileName(macro.name, 'macro'), file)
  return droppedFiles > 0 ? "The file from the “File” node was not included in it - the recipient will select his" : null
}

/**
 * Текст макроса для буфера обмена — тот же файл обмена, что «Сохранить в
 * файл»: с пометкой каталога, именами моделей и сведениями о параметрах.
 *
 * Считается сразу, без сети: буфер пишут в том же нажатии. `models` — каталог
 * доски, на которой копируют. Негодный макрос (пустой, со встроенной
 * картинкой) — `LibraryFileError` с текстом для человека.
 */
export function macroClipboardText(
  macro: { name: string; graph: unknown },
  catalog: LibraryCatalog,
  models: readonly CatalogModel[],
): string {
  return serializeLibraryFile(buildMacroFile(macro, catalog, models).file)
}

// Сам признак живёт в libraryFile.ts: его зовёт и холст (KonvaCanvas.onPaste),
// а тянуть туда api и каталоги ради одной проверки незачем.
export { isMacroText }

export interface ImportedMacro {
  name: string
  notes: string[]
}

/**
 * Макрос из текста (файла или буфера) — в библиотеку: разбор, подгонка под
 * каталог локальной доски и запись в указанный свободный слот. `rename` даёт
 * копии своё имя (вставка из буфера).
 */
export async function importMacroFromText(
  text: string,
  source: ProjectSource,
  scope: MacroScope,
  freeSlot: number | undefined,
  rename?: (name: string) => string,
  library: MacroLibraryApi = api,
): Promise<ImportedMacro> {
  const parsed = readMacroFile(text)
  const { models, defaults } = await loadCatalog(source, library)
  const adapted = adaptMacroFile(parsed, {
    catalog: macroCatalogOf(source),
    models,
    defaultModelId: (kind) => defaultNodeModelId(models, kind as NodeKind, defaults),
  })
  const name = (rename && cleanName(rename(adapted.name), 100)) || adapted.name
  await library.saveMacro(name, adapted.graph, undefined, freeSlot, undefined, scope)
  return { name, notes: adapted.notes }
}

/**
 * Загружает макрос из выбранного файла в библиотеку. `null` — файл не выбрали.
 */
export async function importMacroFromFile(
  source: ProjectSource,
  scope: MacroScope,
  freeSlot: number | undefined,
): Promise<ImportedMacro | null> {
  const text = await pickLibraryFile('macro')
  if (text === null) return null
  return importMacroFromText(text, source, scope, freeSlot)
}
