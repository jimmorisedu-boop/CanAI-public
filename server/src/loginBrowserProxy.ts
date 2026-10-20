/**
 * Дорога окна входа.
 *
 * ⚠️ Окно входа — отдельный Firefox со своим ЧИСТЫМ профилем, а чистый профиль
 * ходит в интернет напрямую. Само приложение при этом умеет искать рабочую
 * дорогу (`cloudRoute.ts`) и нередко ходит через прокси — то есть окно входа
 * оказывалось единственным местом, которое идёт не тем путём, что всё
 * остальное. Замер 18.09.2026 на машине пользователя: `youtube.com` напрямую
 * не отвечает ВОВСЕ, через локальный прокси отдаёт 200; страница входа Google
 * при этом переадресуется на `accounts.google.ru` и там виснет — человек видит
 * «Время ожидания соединения истекло» и думает, что сломалось приложение.
 *
 * Поэтому перед запуском кладём в профиль `user.js` с той же дорогой, которую
 * приложение выбрало для себя. Firefox читает этот файл при КАЖДОМ старте,
 * поэтому смена дороги подхватывается сама.
 *
 * ⚠️ Когда прокси нет, файл НЕ пишем и удаляем прежний: выставлять «ходить
 * напрямую» нельзя — у человека может быть системный прокси или VPN-клиент,
 * который Firefox по умолчанию уважает (`network.proxy.type = 5`), и мы бы его
 * отняли.
 */

/** Логин и пароль в прокси Firefox из файла настроек не прочитает — он их
 *  спросит окном. Поэтому из адреса берём только хост и порт. */
export function firefoxProxyPrefs(proxy: string | null | undefined): string | null {
  if (!proxy) return null
  let url: URL
  try {
    url = new URL(proxy)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  const host = url.hostname
  if (!host) return null
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80))
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null
  return [
    '// Created by CanAI: the sign-in window uses the same route as the app.',
    'user_pref("network.proxy.type", 1);',
    `user_pref("network.proxy.http", ${JSON.stringify(host)});`,
    `user_pref("network.proxy.http_port", ${port});`,
    // ssl_* нужны отдельно: без них HTTPS пойдёт мимо прокси, а весь вход — это HTTPS.
    `user_pref("network.proxy.ssl", ${JSON.stringify(host)});`,
    `user_pref("network.proxy.ssl_port", ${port});`,
    'user_pref("network.proxy.share_proxy_settings", true);',
    // Локальные адреса мимо прокси: туда он не нужен и только мешает.
    'user_pref("network.proxy.no_proxies_on", "localhost, 127.0.0.1");',
    '',
  ].join('\n')
}
