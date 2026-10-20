// Разделы окна настроек. Отдельным модулем — по той же причине, по которой
// отдельно живут формулировки состояний: список разделов и правило «куда
// открывать» проверяются тестом, а не глазами в модалке.
//
// ⚠️ Раздел, который сюда не вписан, в окне НЕДОСТИЖИМ. Это осознанно: пусть
// новый блок настроек потребует одной строки здесь, чем окажется висящим в
// пустоте, для любого локального компонента.

export type SettingsSectionId =
  | 'general'
  | 'generation'
  | 'agents'
  | 'editor'
  | 'components'
  | 'remote'
  | 'diagnostics'

export interface SettingsSectionInfo {
  id: SettingsSectionId
  label: string
  /** Одной строкой: что человек найдёт внутри. */
  summary: string
}

export const SETTINGS_SECTIONS: SettingsSectionInfo[] = [
  { id: 'general', label: 'General', summary: 'Canvas, images, and price confirmations' },
  { id: 'generation', label: 'fal.ai and models', summary: 'Key, default models, and local fal.ai catalog' },
  { id: 'agents', label: 'Agents', summary: 'Packages, trust, and portable runtime for local tasks' },
  { id: 'editor', label: 'External editor', summary: 'External program opened with F2 for image editing' },
  { id: 'components', label: 'Components', summary: 'Video and audio processing, site sign-in, face comparison' },
  { id: 'remote', label: 'Tablet access', summary: 'Work on the same board from another device' },
  { id: 'diagnostics', label: 'Diagnostics', summary: 'Activity log: what the app did and how the server responded' },
]

export const DEFAULT_SETTINGS_SECTION: SettingsSectionId = 'general'

export function isSettingsSection(value: unknown): value is SettingsSectionId {
  return SETTINGS_SECTIONS.some((section) => section.id === value)
}

/** Куда открыть окно. Раздел приходит ЯВНО от того, кто зовёт настройки, —
 *  угадывать его по тексту подсказки нельзя: такое ломается от любой
 *  переформулировки (ровно на этом уже обожглись коды ответов публикации). */
export function resolveSettingsSection(requested: unknown): SettingsSectionId {
  return isSettingsSection(requested) ? requested : DEFAULT_SETTINGS_SECTION
}
