import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { askConfirm, registerConfirmHost } from './confirmBus'

test('без хоста askConfirm отвечает «нет», а не выдумывает согласие', async () => {
  registerConfirmHost(null)
  assert.equal(await askConfirm({ title: 'x', confirmLabel: 'ok' }), false)
})

test('хост получает запрос и его ответ доезжает до вызывающего', async () => {
  registerConfirmHost((request, resolve) => {
    assert.equal(request.title, 'Удалить?')
    resolve(true)
  })
  assert.equal(await askConfirm({ title: 'Удалить?', confirmLabel: 'Удалить' }), true)
  registerConfirmHost(null)
})

test('второй вопрос поверх первого не оставляет первый без ответа', async () => {
  const answers: Array<(ok: boolean) => void> = []
  registerConfirmHost((_request, resolve) => answers.push(resolve))
  const first = askConfirm({ title: 'первый', confirmLabel: 'ok' })
  const second = askConfirm({ title: 'второй', confirmLabel: 'ok' })
  // хост обязан ответить обоим — иначе вызывающий код повиснет навсегда
  answers[0](false)
  answers[1](true)
  assert.deepEqual(await Promise.all([first, second]), [false, true])
  registerConfirmHost(null)
})

// Страж: браузер предлагает заглушить нативные диалоги после серии подряд, и
// тогда «Отмена» приходит сама собой — действие молча не выполняется. Один раз
// это уже стоило продукту тихого отказа запуска генерации (аудит F-04).
test('в исходниках нет нативных window.confirm / prompt / alert', () => {
  const root = path.resolve(import.meta.dirname, '..')
  const offenders: string[] = []
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!/\.tsx?$/.test(entry.name) || entry.name.includes('.test.')) continue
      const source = fs.readFileSync(full, 'utf8')
      for (const [index, line] of source.split('\n').entries()) {
        if (line.trimStart().startsWith('//') || line.trimStart().startsWith('*')) continue
        if (/\bwindow\.(confirm|prompt|alert)\s*\(/.test(line)) {
          offenders.push(`${path.relative(root, full)}:${index + 1}`)
        }
      }
    }
  }
  walk(root)
  assert.deepEqual(
    offenders,
    [],
    'вместо нативного окна используйте askConfirm из ui/confirmBus',
  )
})
