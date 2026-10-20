import assert from 'node:assert/strict'
import test from 'node:test'
import { needsExtractorLogin } from './extractorLogin.js'

// Строки сняты с живых прогонов 18.09.2026 (yt-dlp 2026.08.19 и ночная сборка
// 2026.09.16) — ровно то, что видит сервер в stderr.
const LIVE_LOGIN_FAILURES = [
  'ERROR: [vimeo] 315204505: The web client only works when logged-in. Use --cookies, --cookies-from-browser, --username and --password, --netrc-cmd, or --netrc (vimeo) to provide account credentials.',
  'ERROR: [youtube] AbCdEf: Sign in to confirm you are not a bot. Use --cookies-from-browser or --cookies for the authentication.',
]

const OTHER_FAILURES = [
  'ERROR: Unsupported URL: https://example.test/watch',
  'ERROR: [vimeo] 315204505: Unable to download webpage: HTTP Error 401: Unauthorized',
  'ERROR: [generic] no suitable extractor found',
  // Закрытая публикация — это НЕ стена входа на площадке: там прежнее
  // «проверьте ссылку и доступность публикации» верно по существу.
  'ERROR: [vimeo] 12345: Private video. You might want to use a cookies file',
  // Диагностика с ключом: слово COOKIE не должно превращаться в «нужен вход».
  'C:\\Users\\Name\\runtime\\gallery-dl.exe failed COOKIE=secret',
]

test('вывод про вход в аккаунт опознаётся у каждой площадки', () => {
  for (const text of LIVE_LOGIN_FAILURES) {
    assert.equal(needsExtractorLogin(text), true, text)
  }
})

test('прочие отказы extractor не выдаются за требование входа', () => {
  for (const text of OTHER_FAILURES) {
    assert.equal(needsExtractorLogin(text), false, text)
  }
})
