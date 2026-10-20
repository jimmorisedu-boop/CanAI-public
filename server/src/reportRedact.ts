/**
 * Секреты, которые не имеют права уехать в жалобу (пункт 5.9).
 *
 * Журнал страницы уже чистит поля по именам (`client/src/diag/logSanitize.ts`),
 * а здесь — вторая линия по ШАБЛОНАМ: серверный журнал пишется строками, и имя
 * поля там не поймать. ⚠️ Двойник — `redactSecrets` в `diagnosticReports.ts`
 * сервера команды (он чистит повторно, на случай старого клиента); правишь
 * шаблон здесь — поправь и там.
 */
const REDACTIONS: Array<[RegExp, string]> = [
  // Ключ fal: «uuid:32 hex».
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{32}\b/giu, '[key hidden]'],
  [/\b(authorization|cookie|set-cookie|x-canai-remote-csrf)(["']?\s*[:=]\s*)["']?[^\s"',;]+(?:\s[^\s"',;]+)?/giu, '$1$2[hidden]'],
  [/\b(Bearer|Key)\s+[A-Za-z0-9._~+/=-]{16,}/gu, '$1 [hidden]'],
  [/\bsk-[A-Za-z0-9_-]{16,}/gu, '[key hidden]'],
  // ⚠️ Граница слова — своя: `\b` в JS знает только латиницу, и «пароль»
  // после пробела он не видит.
  [/(?<![\p{L}\p{N}_])(password|passwd|пароль|secret|token|api[_-]?key|refresh[_-]?token|access[_-]?token)(["']?\s*[:=]\s*["']?)[^\s"',;}]{4,}/giu, '$1$2[hidden]'],
  // После «token=…»: иначе от такой записи оставался хвост « скрыт]».
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/gu, '[token hidden]'],
  // Картинки и прочее двоичное: жалобе нужны события, а не содержимое файлов.
  [/data:([\w/+.-]+);base64,[A-Za-z0-9+/=]{64,}/gu, 'data:$1;base64,[removed]'],
  [/[A-Za-z0-9+/]{200,}={0,2}/gu, '[long string removed]'],
]

export function redactReportText(text: string): string {
  let out = text
  for (const [pattern, replacement] of REDACTIONS) out = out.replace(pattern, replacement)
  return out
}
