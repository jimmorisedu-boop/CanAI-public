// Реестр запусков макроса. Один макрос можно запускать СЕРИЯМИ: каждый клик по
// слоту — независимый параллельный прогон (требование пользователя). Поэтому
// флаг отмены живёт на ЗАПУСК, а не на макрос:
//  - «Стоп» помечает все прогоны, которые идут ПРЯМО СЕЙЧАС;
//  - прогон, начатый ПОСЛЕ остановки, отмену не наследует (иначе повторный
//    запуск сразу после «Стоп» мгновенно самоотменялся).
export interface MacroLaunchRegistry {
  // зарегистрировать начавшийся прогон, вернуть его токен
  begin(macroId: string): number
  // отменён ли конкретный прогон (это и уходит в движок как isCancelled)
  isCancelled(token: number): boolean
  // остановить ОДИН прогон по его токену (центр задач останавливает точечно);
  // false — такого активного прогона нет
  cancel(token: number): boolean
  // остановить все прогоны макроса, идущие сейчас; false — нечего останавливать
  cancelAll(macroId: string): boolean
  // прогон завершился (успех, ошибка или отмена) — забыть его
  end(macroId: string, token: number): void
  // сколько прогонов этого макроса идёт сейчас
  activeCount(macroId: string): number
}

export function createMacroLaunchRegistry(): MacroLaunchRegistry {
  let seq = 0
  const active = new Map<string, Set<number>>()
  const cancelled = new Set<number>()

  return {
    begin(macroId) {
      const token = ++seq
      const launches = active.get(macroId) ?? new Set<number>()
      launches.add(token)
      active.set(macroId, launches)
      return token
    },
    isCancelled(token) {
      return cancelled.has(token)
    },
    cancel(token) {
      // проверяем, что токен ещё активен: иначе отменённый номер осел бы в
      // cancelled навсегда (end() чистит только живые)
      for (const launches of active.values()) {
        if (!launches.has(token)) continue
        cancelled.add(token)
        return true
      }
      return false
    },
    cancelAll(macroId) {
      const launches = active.get(macroId)
      if (!launches || launches.size === 0) return false
      for (const token of launches) cancelled.add(token)
      return true
    },
    end(macroId, token) {
      cancelled.delete(token)
      const launches = active.get(macroId)
      if (!launches) return
      launches.delete(token)
      if (launches.size === 0) active.delete(macroId)
    },
    activeCount(macroId) {
      return active.get(macroId)?.size ?? 0
    },
  }
}
