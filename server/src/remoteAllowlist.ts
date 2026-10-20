import { isPrivateIpv4Host } from './shareLan.js'

// Что видно с планшета.
//
// Правило простое и намеренно скучное: наружу пускается ТОЛЬКО перечисленное
// здесь. Не «всё, кроме опасного» — такой список забывают пополнять, и первая
// же новая ручка оказывается открытой. Здесь наоборот: новая ручка недоступна
// с планшета, пока её не впишут сюда руками.
//
// Чего тут нет и не будет:
//  • POST /settings — пишет server/.env с ключом fal (частичная правка без
//    секретов ходит через PATCH /settings, см. ниже);
//  • /lifecycle/shutdown — выключение приложения;
//  • /edit-sessions — запускает программы на компьютере (Photoshop);
//  • /media-tools/*/prepare, /face-models/prepare — качают компоненты в runtime/;
//  • /workflow-draft и запись макросов — редактор нод на планшете не живёт.

interface Rule {
  methods: readonly string[]
  pattern: RegExp
}

const ID = '[^/]{1,120}'

const RULES: readonly Rule[] = [
  // Состояние приложения и каталог моделей.
  { methods: ['GET'], pattern: /^\/status$/ },
  { methods: ['GET'], pattern: /^\/models$/ },
  { methods: ['GET'], pattern: /^\/components$/ },
  // Настройки: читать целиком, править — только без секретов. PATCH заведён
  // ровно для этого и принимает явный короткий список полей (см. routes.ts);
  // POST по-прежнему закрыт, потому что он пишет ключ fal и путь к Photoshop.
  { methods: ['GET', 'PATCH'], pattern: /^\/settings$/ },
  // Состояние моделей сходства лиц: читать можно, качать (prepare) — нет.
  { methods: ['GET'], pattern: /^\/face-models$/ },
  { methods: ['GET'], pattern: new RegExp(`^/face-models/file/${ID}$`) },
  { methods: ['GET'], pattern: /^\/media-tools\/ffmpeg$/ },
  { methods: ['GET', 'PATCH'], pattern: /^\/onboarding$/ },
  { methods: ['GET'], pattern: /^\/fal-balance$/ },
  { methods: ['GET'], pattern: /^\/fal-history$/ },

  // Доски.
  { methods: ['GET', 'POST'], pattern: /^\/projects$/ },
  { methods: ['PATCH', 'DELETE'], pattern: new RegExp(`^/projects/${ID}$`) },
  { methods: ['GET'], pattern: new RegExp(`^/projects/${ID}/versions$`) },
  { methods: ['POST'], pattern: new RegExp(`^/projects/${ID}/versions/${ID}/restore$`) },
  { methods: ['GET', 'POST'], pattern: /^\/project$/ },
  { methods: ['GET', 'DELETE'], pattern: /^\/project-trash$/ },
  { methods: ['POST'], pattern: new RegExp(`^/project-trash/${ID}/restore$`) },
  { methods: ['DELETE'], pattern: new RegExp(`^/project-trash/${ID}$`) },

  // Правка клипа: обрезка, резы, кадр, звук, волна. Это обычные операции над
  // файлом доски — их место там же, где и сам файл. Докачка ffmpeg (prepare)
  // остаётся за столом: она пишет в runtime/.
  { methods: ['POST'], pattern: /^\/media\/(extract-audio|audio-peaks|probe-video|detect-shots|cut-video|mux-audio)$/ },

  // Генерация и её задачи.
  { methods: ['POST'], pattern: /^\/generate$/ },
  // Closed text-only action preparation; the later media launch still uses
  // the ordinary generation contract after an explicit client review.
  { methods: ['POST'], pattern: /^\/canvas\/actions\/prepare$/ },
  { methods: ['GET'], pattern: new RegExp(`^/canvas/actions/prepare/${ID}$`) },
  { methods: ['POST'], pattern: new RegExp(`^/canvas/actions/prepare/${ID}/cancel$`) },
  { methods: ['GET'], pattern: new RegExp(`^/jobs/${ID}$`) },
  { methods: ['POST'], pattern: new RegExp(`^/jobs/${ID}/cancel$`) },
  // Ожидание изменения задач одним запросом (3.7) — только чтение состояния.
  { methods: ['POST'], pattern: /^\/jobs\/wait$/ },
  { methods: ['POST'], pattern: /^\/assets$/ },
  { methods: ['POST'], pattern: /^\/assets\/upload$/ },
  { methods: ['POST'], pattern: /^\/exports\/reserve$/ },

  // Непрерывность сеанса.
  { methods: ['GET', 'POST', 'DELETE'], pattern: /^\/session-draft$/ },
  { methods: ['GET', 'POST'], pattern: /^\/board-presence$/ },

  // Помощник.
  { methods: ['GET', 'POST'], pattern: /^\/prompt-chats$/ },
  { methods: ['PATCH'], pattern: /^\/prompt-chats\/preferences$/ },
  { methods: ['GET'], pattern: /^\/prompt-chats\/trash$/ },
  { methods: ['GET', 'DELETE'], pattern: new RegExp(`^/prompt-chats/${ID}$`) },
  { methods: ['POST'], pattern: new RegExp(`^/prompt-chats/${ID}/(activate|estimate|messages|history|history/events|restore)$`) },
  { methods: ['GET'], pattern: /^\/assistants$/ },
  // Включить и выключить помощника: ради этого ряд помощников на планшете и
  // стоит. Ручки не было в списке, и переключатель на своей доске молча
  // откатывался («Это действие доступно только на компьютере»). Она выбирает
  // включённого и отвечает тем же списком, что GET /assistants: имена и
  // инструкции в нём есть, текстов документов нет. ⚠️ То есть инструкции
  // помощников с планшета ВИДНЫ — и были видны до этой ручки, через список;
  // закрыты тексты документов (их отдаёт только выгрузка). Правка, выгрузка и
  // приём помощников остаются за столом.
  { methods: ['POST'], pattern: /^\/assistants\/active$/ },

  // Агент на планшете — только чтение установленной библиотеки/каталога и
  // управление локальными задачами. Установка Git/ZIP, portable runtime и
  // изменение пакетов остаются на Desktop Host; маршруты задач дополнительно
  // отклоняют Cloud projectRef до вызова AgentHost.
  { methods: ['GET'], pattern: /^\/agents\/llm\/catalog$/ },
  { methods: ['GET'], pattern: /^\/agents\/generation\/catalog$/ },
  { methods: ['POST'], pattern: /^\/agents\/generation\/capture$/ },
  { methods: ['GET'], pattern: /^\/agents\/packages$/ },
  { methods: ['GET'], pattern: new RegExp(`^/agents/packages/${ID}$`) },
  { methods: ['POST'], pattern: /^\/agent-tasks$/ },
  { methods: ['GET'], pattern: /^\/agent-tasks$/ },
  { methods: ['GET'], pattern: new RegExp(`^/agent-tasks/${ID}$`) },
  { methods: ['GET'], pattern: new RegExp(`^/agent-tasks/${ID}/events$`) },
  { methods: ['POST'], pattern: new RegExp(`^/agent-tasks/${ID}/(pause|resume|cancel)$`) },
  { methods: ['POST'], pattern: new RegExp(`^/agent-tasks/${ID}/reviews/${ID}/decision$`) },

  // Макросы: смотреть и ЗАПУСКАТЬ. Прогон живёт на сервере и переживает
  // заблокированный планшет, поэтому запускать их отсюда безопасно. Править
  // граф по-прежнему нельзя — редактор нод на планшет не переносится.
  // Публикация доски: УПРАВЛЯТЬ уже созданной можно, создавать — нет.
  // Разница не формальная: пауза, новая секретная ссылка и обновление снимка
  // ничего не открывают наружу сверх того, что автор уже открыл сам, а
  // создание публикации и подъём канала выставляют доску в интернет — это
  // решение принимается за столом (решение пользователя 26.08.2026).

  { methods: ['GET'], pattern: /^\/macros$/ },
  { methods: ['GET'], pattern: new RegExp(`^/macros/${ID}/plan$`) },
  { methods: ['POST'], pattern: new RegExp(`^/macros/${ID}/run$`) },
  { methods: ['GET'], pattern: /^\/macro-runs$/ },
  { methods: ['POST'], pattern: new RegExp(`^/macro-runs/${ID}/cancel$`) },
]

/**
 * Пускать ли запрос с планшета.
 *
 * `apiPath` — путь ВНУТРИ /api, без строки запроса.
 */
export function isAllowedRemoteApi(method: string, apiPath: string): boolean {
  const verb = method.toUpperCase()
  // Строку запроса и точки в пути отсекаем до сравнения: «/project?x» и
  // «/../settings» не должны притворяться разрешёнными.
  const path = apiPath.split('?')[0]
  if (path.includes('..')) return false
  if (verb === 'OPTIONS') return true
  return RULES.some((rule) => rule.methods.includes(verb) && rule.pattern.test(path))
}

/**
 * Кто может стучаться в планшетную дверь.
 *
 * Домен, направленный на этот адрес, не пройдёт: в Host у него останется имя,
 * а пускаем мы только литералы приватных адресов и loopback. Тот же приём, что
 * у гостевого сервера с `shareLanAccess`.
 */
export function isAllowedRemoteHost(hostname: string): boolean {
  return hostname === '127.0.0.1'
    || hostname === 'localhost'
    || hostname === '::1'
    || isPrivateIpv4Host(hostname)
}
