// Открытие окна настроек из любого места (например, когда пользователь
// пытается открыть картинку в редакторе, а путь к программе не указан).
import type { SettingsSectionId } from './settingsSections'

type Handler = (hint?: string, section?: SettingsSectionId) => void

let handler: Handler | null = null

export function onOpenSettings(h: Handler | null): void {
  handler = h
}

/** Раздел передаётся ЯВНО: подсказка ведёт к конкретной настройке, а искать её
 *  по всем разделам — это ровно та громоздкость, от которой окно и делили. */
export function openSettings(hint?: string, section?: SettingsSectionId): void {
  handler?.(hint, section)
}

// «настройки сохранены» — например, PromptBar перечитывает статус ключа fal,
// чтобы баннер мок-режима погас сразу, без перезагрузки страницы
const savedSubs = new Set<() => void>()

export function onSettingsSaved(cb: () => void): () => void {
  savedSubs.add(cb)
  return () => savedSubs.delete(cb)
}

export function notifySettingsSaved(): void {
  for (const cb of savedSubs) cb()
}

// «вход в команду изменился» — вошли или вышли в разделе «Команда». Галерея
// перечитывает связь сразу: плашка в её шапке обязана говорить правду, а не
// ждать следующей перезагрузки.
const teamSubs = new Set<() => void>()

export function onTeamAccountChanged(cb: () => void): () => void {
  teamSubs.add(cb)
  return () => teamSubs.delete(cb)
}

export function notifyTeamAccountChanged(): void {
  for (const cb of teamSubs) cb()
}
