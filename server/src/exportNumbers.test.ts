import assert from 'node:assert/strict'
import test from 'node:test'
import { exportBoardName, exportNumberKey } from './exportNumbers.js'

// Сам reserveExportNumbers пишет в data/ и проверяется живым прогоном (см.
// комментарий в модуле); здесь — правила, из которых складывается имя и ключ
// счётчика. Именно они отвечают за требование «двух одинаковых имён быть не
// должно».

test('запрещённые в именах файлов символы вычищаются', () => {
  // Windows не создаст файл с \/:*?"<>| — а имя доски пользователь пишет
  // как хочет, включая двоеточия и слэши.
  assert.equal(exportBoardName('моя/свалка: часть 2'), 'моя свалка часть 2')
  assert.equal(exportBoardName('  лишние   пробелы  '), 'лишние пробелы')
})

test('доска без имени всё равно получает имя', () => {
  // Иначе файл назывался бы «1-1_.png» — и такое имя столкнулось бы с любым
  // другим безымянным.
  assert.equal(exportBoardName(''), 'board')
  assert.equal(exportBoardName(null), 'board')
  assert.equal(exportBoardName('///'), 'board')
})

test('слишком длинное имя обрезается', () => {
  const длинное = 'д'.repeat(200)
  assert.equal(exportBoardName(длинное).length, 60)
})

test('счётчик общий у одноимённых досок, но раздельный у разных меток', () => {
  // Доски нередко называются одинаково («Без названия»), и раздельные счётчики
  // выдали бы им один и тот же «1-1_Без названия». По имени они делят счётчик.
  assert.equal(exportNumberKey(1, 'Без названия'), exportNumberKey(1, 'без названия'))
  assert.notEqual(exportNumberKey(1, 'моя свалка'), exportNumberKey(2, 'моя свалка'))
  assert.notEqual(exportNumberKey(1, 'моя свалка'), exportNumberKey(1, 'другая доска'))
})
