import assert from 'node:assert/strict'
import test from 'node:test'
import { FilePickError, nothingPickedMessage, pickerCommand } from './filePicker.js'

test('на Windows диалог получает свой фильтр, и кавычки скрипта целы', () => {
  const application = pickerCommand('application', 'win32')
  const cookies = pickerCommand('cookies', 'win32')
  assert.equal(application.command, 'powershell.exe')
  const script = application.args.at(-1) ?? ''
  assert.match(script, /OpenFileDialog/)
  assert.match(script, /\$dialog\.Filter = 'Programs \(\*\.exe\)\|\*\.exe'/u)
  // Фильтр целиком внутри одной пары кавычек: разорванная строка ломает диалог
  // молча, и человек видит просто «не удалось открыть выбор файла».
  assert.equal((script.match(/'/g) ?? []).length % 2, 0)
  assert.match(cookies.args.at(-1) ?? '', /Files cookies/u)
  assert.notEqual(application.args.at(-1), cookies.args.at(-1))
})

test('на маке программу и файл выбирают РАЗНЫМИ диалогами', () => {
  // «choose application» показывает список программ — файл cookies им не выбрать.
  assert.match(pickerCommand('application', 'darwin').args.at(-1) ?? '', /choose the application/u)
  assert.match(pickerCommand('cookies', 'darwin').args.at(-1) ?? '', /choose the cookie file/u)
})

test('на прочих системах честно отказываем, а не открываем ничего', () => {
  assert.throws(() => pickerCommand('cookies', 'linux'), (error: unknown) => {
    assert(error instanceof FilePickError)
    assert.equal(error.status, 400)
    assert.match(error.message, /provide the path manually/u)
    return true
  })
})

test('отмена называется по имени того, что выбирали', () => {
  assert.equal(nothingPickedMessage('application'), 'Program not selected')
  assert.equal(nothingPickedMessage('cookies'), 'File not selected')
})
