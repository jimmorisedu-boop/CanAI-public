// Исход прогона макроса. Раньше здесь жила ещё и машина состояний для строки
// под рядом слотов — она показывала РОВНО ОДИН статус и теряла все остальные
// (F-09). Прогресс теперь у центра задач в шапке (по каждому прогону), исход —
// тостом, поэтому от модуля осталась сборка сообщения.

export type MacroStatusKind =
  | 'progress'
  | 'success'
  | 'error'
  | 'partial'
  | 'stopped'
  | 'output_missing'

export function macroCompletionStatus(
  macroName: string,
  deliveredOutputs: number,
): { kind: MacroStatusKind; message: string } {
  return deliveredOutputs > 0
    ? { kind: 'success', message: `${macroName}: ready ✓` }
    : {
        kind: 'output_missing',
        message: `${macroName}: nothing reached Output`,
      }
}
