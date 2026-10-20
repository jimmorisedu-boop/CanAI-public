// @ts-expect-error Тест запускается через tsx с Node-типами.
import assert from 'node:assert/strict'
// @ts-expect-error Тест запускается через tsx с Node-типами.
import { readdirSync, readFileSync } from 'node:fs'
// @ts-expect-error Тест запускается через tsx с Node-типами.
import path from 'node:path'
// @ts-expect-error Тест запускается через tsx с Node-типами.
import { fileURLToPath } from 'node:url'
// @ts-expect-error Тест запускается через tsx с Node-типами.
import test from 'node:test'
import type { CatalogModel } from '../../types.js'
import { estimatedAspectRatio } from './genOptions.js'
import {
  materializeModelParams,
  reconcileModelParams,
} from './modelParamContract.js'

const base: CatalogModel = {
  id: 'base',
  name: 'Base',
  kind: 'image',
  refs: false,
  params: [
    {
      name: 'aspect_ratio',
      label: 'Пропорции',
      widget: 'select',
      default: '4:3',
      options: ['auto', '4:3', '9:16'].map((value) => ({ value, label: value })),
    },
    {
      name: 'quality',
      label: 'Качество',
      widget: 'select',
      default: 'high',
      options: [{ value: 'high', label: 'Высокое' }],
    },
  ],
}

const edit: CatalogModel = {
  ...base,
  id: 'edit',
  refs: true,
  params: base.params.map((param) => (
    param.name === 'aspect_ratio' ? { ...param, default: 'auto' } : param
  )),
}

test('явная пропорция переживает переход base → edit', () => {
  assert.deepEqual(
    reconcileModelParams(edit, { aspect_ratio: '9:16' }, {}),
    { aspect_ratio: '9:16' },
  )
})

test('неизменённое значение остаётся отсутствующим и получает edit default при submit', () => {
  const current = reconcileModelParams(edit, {}, {})
  assert.deepEqual(current, {})
  assert.deepEqual(materializeModelParams(edit, current, { hasMediaRefs: true }), {
    aspect_ratio: 'auto',
    quality: 'high',
  })
})

// Найдено живой проверкой каталога 2026-08-07: клиент хранил число, не глядя
// на границы, а сервер такое отвергает целиком — «Параметры не соответствуют
// выбранной модели». Пользователю по этой фразе понять нечего, а сломать её
// могла простая смена min в каталоге (так и вышло с max_tokens: 64 → 128).
test('число вне границ не переживает смену модели', () => {
  const withRange: CatalogModel = {
    ...base,
    params: [
      { name: 'max_tokens', label: 'Лимит', widget: 'number', default: 1024, min: 128, max: 8192 },
      { name: 'seed', label: 'Seed', widget: 'seed', default: -1 },
    ],
  }
  assert.deepEqual(reconcileModelParams(withRange, { max_tokens: 64 }, {}), {})
  assert.deepEqual(reconcileModelParams(withRange, { max_tokens: 9000 }, {}), {})
  assert.deepEqual(reconcileModelParams(withRange, { max_tokens: 256 }, {}), { max_tokens: 256 })
  // у seed границ нет: −1 означает «случайный» и обязан проходить
  assert.deepEqual(reconcileModelParams(withRange, { seed: -1 }, {}), { seed: -1 })
})

test('отсутствующая память параметров считается пустой', () => {
  const missingSaved = undefined as unknown as Record<string, unknown>

  assert.deepEqual(reconcileModelParams(base, {}, missingSaved), {})
})

test('legacy image_size и неподдерживаемое значение не проходят в новую модель', () => {
  assert.deepEqual(
    reconcileModelParams(
      base,
      { image_size: 'portrait_16_9', aspect_ratio: '21:9' },
      {},
    ),
    {},
  )
})

test('правило пропорций живёт одним местом и знает про auto', () => {
  // правило переехало из двух почти одинаковых эффектов PromptBar в
  // modelAspect — поведение проверяется в modelAspect.test, здесь только то,
  // что оно не расползлось обратно по разметке
  const rule = readFileSync(new URL('./modelAspect.ts', import.meta.url), 'utf8')
  // Имя параметра задаёт каталог (aspect_ratio у своего, aspect у сервера
  // команды), поэтому правило пишет в найденное имя.
  assert.match(rule, /\[name\]:\s*['"]auto['"]/)
  const promptBar = readFileSync(new URL('./PromptBar.tsx', import.meta.url), 'utf8')
  // упоминание в комментарии допустимо, присвоение — нет
  assert.doesNotMatch(
    promptBar,
    /aspect_ratio:\s*\S/,
    'пропорции настраивает modelAspect, а не промпт-бар',
  )
})

// hasMediaRefs обязан передаваться во ВСЕ вызовы: без него materializeModelParams
// подменяет «Авто» первой не-авто опцией (у GPT это 1:1), и портретный референс
// уезжал в квадрат — и в отправке, и в цене. Проверяем ВСЕ исходники, а не один
// файл: после разделения промпт-бара вызовы разъехались по модулям, и проверка
// одного файла молча перестала бы что-либо гарантировать.
test('hasMediaRefs передаётся в каждый вызов materializeModelParams', () => {
  const root = path.resolve(fileURLToPath(import.meta.url), '../../..')
  const calls: Array<{ where: string; call: string }> = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!/\.tsx?$/.test(entry.name) || entry.name.includes('.test.')) continue
      // сам модуль объявляет функцию — его сигнатура не вызов
      if (entry.name === 'modelParamContract.ts') continue
      const source = readFileSync(full, 'utf8')
      for (const call of source.match(/materializeModelParams\([\s\S]*?\n\s*\)/g) ?? []) {
        calls.push({ where: path.relative(root, full), call })
      }
    }
  }
  walk(root)

  assert.ok(calls.length >= 2, `ожидали вызовы materializeModelParams, нашли ${calls.length}`)
  for (const { where, call } of calls) {
    assert.match(call, /hasMediaRefs/, `вызов без hasMediaRefs в ${where}: ${call}`)
  }
})

test('без медиа-референсов «Авто» подменяется, с ними — сохраняется', () => {
  // именно эта подмена и превращала портрет в квадрат, когда флаг терялся:
  // без референсов «авто» не к чему привязать, поэтому берётся конкретная
  // пропорция — но при референсе «авто» обязано дойти до сервера как есть
  const withoutRefs = materializeModelParams(edit, { aspect_ratio: 'auto' }, { hasMediaRefs: false })
  assert.notEqual(withoutRefs.aspect_ratio, 'auto')

  const withRefs = materializeModelParams(edit, { aspect_ratio: 'auto' }, { hasMediaRefs: true })
  assert.equal(withRefs.aspect_ratio, 'auto')
})

// ⚠️ Имя параметра задаёт каталог: у сервера команды пропорции зовутся `aspect`.
// Проверка знала только `aspect_ratio`, и на планшете сетевой доски панель
// показывала конкретную пропорцию, а в запрос уходило 'auto'.
test('правило «Авто без референса» знает и имя сервера команды', () => {
  const cloud: CatalogModel = {
    ...edit,
    id: 'cloud',
    params: [{
      name: 'aspect', label: 'Пропорции', widget: 'select', default: '4:3',
      options: ['auto', '4:3', '9:16'].map((value) => ({ value, label: value })),
    }],
  }
  assert.equal(materializeModelParams(cloud, { aspect: 'auto' }, { hasMediaRefs: false }).aspect, '4:3')
  assert.deepEqual(reconcileModelParams(cloud, {}, { aspect: 'auto' }), {})
  assert.equal(materializeModelParams(cloud, { aspect: 'auto' }, { hasMediaRefs: true }).aspect, 'auto')
  assert.equal(
    materializeModelParams(cloud, { aspect: 'auto' }, { hasMediaRefs: false, allowAutoWithoutRefs: true }).aspect,
    'auto',
  )
})

// У канона сервера команды «Авто» ПО УМОЛЧАНИЮ значит «параметр не задан»:
// панель так и показывает, и подменять его нечем (см. autoParam.ts).
test('«Авто» по умолчанию у сервера команды уходит как есть и без референса', () => {
  const unset: CatalogModel = {
    ...edit,
    id: 'unset',
    params: [{
      name: 'aspect', label: 'Пропорции', widget: 'select', default: 'auto',
      options: ['auto', '9:16', '16:9'].map((value) => ({ value, label: value })),
    }],
  }
  assert.equal(materializeModelParams(unset, {}, { hasMediaRefs: false }).aspect, 'auto')
  assert.deepEqual(reconcileModelParams(unset, { aspect: 'auto' }, {}), { aspect: 'auto' })
})

test('десктопный промпт отправляет «Авто» и без референса', () => {
  const desktop = materializeModelParams(
    edit,
    { aspect_ratio: 'auto' },
    { hasMediaRefs: false, allowAutoWithoutRefs: true },
  )
  assert.equal(desktop.aspect_ratio, 'auto')
})

test('портретная каноническая пропорция задаёт портретную заглушку', () => {
  assert.equal(estimatedAspectRatio(edit, { aspect_ratio: '9:16' }, null), 9 / 16)
})

test('auto использует пропорцию референса', () => {
  assert.equal(estimatedAspectRatio(edit, { aspect_ratio: 'auto' }, 3 / 4), 3 / 4)
})

test('расчёт заглушки больше не зависит от именованных image_size', () => {
  const source = readFileSync(new URL('./genOptions.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /IMAGE_SIZE_RATIO/)
  assert.doesNotMatch(source, /\['aspect_ratio',\s*'image_size'\]/)
})
