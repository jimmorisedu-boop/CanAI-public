import assert from 'node:assert/strict'
import test from 'node:test'
import { LOGIN_PROVIDERS, loginStatus, noBrowserNote } from './extractorLoginState'

test('без входа говорим прямо, что Vimeo так видео не отдаст', () => {
  const view = loginStatus('none', { available: true, signedIn: false })
  assert.equal(view.label, 'Not set')
  assert.equal(view.tone, 'idle')
  assert.match(view.note, /Vimeo/)
})

test('«вход выполнен» не утверждается по одному лишь профилю', () => {
  // Файл cookies появляется в тот миг, когда окно открылось, — то есть до
  // ввода пароля. Поэтому формулировка про ИСТОЧНИК входа, а не про успех.
  const opened = loginStatus('app', { available: true, signedIn: true })
  assert.doesNotMatch(opened.label, /выполнен/i)
  assert.match(opened.note, /link card|your account/i)
  const fresh = loginStatus('app', { available: true, signedIn: false })
  assert.equal(fresh.tone, 'idle')
  assert.match(fresh.note, /Sign in/)
})

test('файл показывается вместе с путём, пустой — как несделанный выбор', () => {
  const chosen = loginStatus('file', { available: true, signedIn: false, file: 'C:/c.txt' })
  assert.equal(chosen.tone, 'success')
  assert.match(chosen.note, /C:\/c\.txt/)
  const empty = loginStatus('file', { available: true, signedIn: false, file: null })
  assert.equal(empty.tone, 'idle')
})

test('без Firefox человек не остаётся в тупике', () => {
  const note = noBrowserNote(false)
  assert(note)
  assert.match(note, /Firefox/)
  // Запасной путь назван тут же, а не спрятан.
  assert.match(note, /cookies/)
  assert.equal(noBrowserNote(true), null)
})

test('в настройках кнопка входа одна — у площадки, которой он нужен', () => {
  // ⚠️ Остальные площадки поддержаны сервером, и вход туда предложит сама
  // карточка ссылки, когда упрётся. Ряд из четырёх кнопок здесь — это
  // приглашение сделать лишнее для тех, кто и так отдаёт видео.
  assert.deepEqual(LOGIN_PROVIDERS.map((provider) => provider.id), ['vimeo'])
})

test('состояния браузера объясняются разными словами и разными кнопками', async () => {
  const { loginBrowserView, shouldPollLoginBrowser } = await import('./extractorLoginState')

  // Не скачан — зовём кнопкой и честно пишем вес ДО нажатия.
  const missing = loginBrowserView({ state: 'missing' })
  assert.equal(missing.action !== null, true)
  assert.match(missing.action ?? '', /MB/)

  // Своя копия — кнопки нет, качать нечего.
  assert.equal(loginBrowserView({ state: 'ready', source: 'runtime' }).action, null)

  // ⚠️ Системная копия помечена отдельно: на своей машине она найдётся сама, и
  // без этого легко решить, что у покупателя тоже всё есть.
  const system = loginBrowserView({ state: 'ready', source: 'system' })
  assert.match(system.label, /System/)
  assert.equal(system.action !== null, true)

  // ⚠️ «Недоступен» ≠ «не скачан»: на маке Firefox ставится обычным способом,
  // и кнопки быть не должно — иначе зовём к тому, чего не произойдёт.
  const unsupported = loginBrowserView({ state: 'unsupported' })
  assert.equal(unsupported.action, null)
  assert.match(unsupported.note ?? '', /normally/)

  const failed = loginBrowserView({ state: 'failed', message: 'сеть отвалилась' })
  assert.match(failed.note ?? '', /сеть отвалилась/)
  assert.equal(failed.tone, 'danger')

  // Опрашиваем сервер только пока идёт закачка.
  assert.equal(shouldPollLoginBrowser({ state: 'downloading', percent: 5 }), true)
  assert.equal(shouldPollLoginBrowser({ state: 'ready', source: 'runtime' }), false)
  assert.equal(shouldPollLoginBrowser(null), false)
})
