// @ts-expect-error Тест запускается через tsx с Node-типами.
import assert from 'node:assert/strict'
// @ts-expect-error Тест запускается через tsx с Node-типами.
import test from 'node:test'
import { panelParams } from './genOptions'
import type { CatalogModel } from '../../types'

const ratio = (name: string) => ({
  name,
  label: 'Пропорции',
  widget: 'select' as const,
  default: 'auto',
  options: [
    { value: 'auto', label: 'Авто' },
    { value: '1:1', label: 'Квадрат 1:1' },
    { value: '16:9', label: 'Широкий 16:9' },
  ],
})

const model = (paramName: string): CatalogModel => ({
  id: 'm', name: 'М', kind: 'image', params: [ratio(paramName)],
} as unknown as CatalogModel)

test('без референса «Авто» не предлагается', () => {
  // ⚠️ «Авто» означает «решает модель ПО РЕФЕРЕНСУ». Без референса решать не по
  // чему, и выбор превращается в обещание, которого никто не выполнит: сервер
  // молча подставит своё значение.
  const [param] = panelParams(model('aspect_ratio'), false)
  assert.deepEqual(param?.options?.map((o) => o.value), ['1:1', '16:9'])
  assert.equal(param?.default, '1:1', 'умолчанием осталось недостижимое «авто»')
})

test('имя параметра значения не имеет — важно содержимое', () => {
  // ⚠️ На командной доске каталог свой, и параметр зовётся `aspect`, а не
  // `aspect_ratio`. Проверка по имени пропускала «Авто» именно там — и человек
  // видел выбор, который ничего не решает.
  const concrete = model('aspect')
  concrete.params[0] = { ...concrete.params[0], default: '1:1' }
  const [param] = panelParams(concrete, false)
  assert.deepEqual(param?.options?.map((o) => o.value), ['1:1', '16:9'])
  assert.equal(param?.default, '1:1')
})

test('«Авто» по умолчанию у сервера команды — «не задано», и из списка не убирается', () => {
  // ⚠️ У канона сервера команды такой «Авто» не обещание «решит по референсу»:
  // сервер просто не шлёт параметр провайдеру и принимает его без референса.
  // Раньше он вырезался из списка, а в запрос уходил всё равно: планшет и нода
  // показывали «1:1», а пропорции решал провайдер (проверка 01.10.2026).
  // Подменять его первым пунктом тоже нельзя — у видео это квадрат.
  const [param] = panelParams(model('aspect'), false)
  assert.deepEqual(param?.options?.map((o) => o.value), ['auto', '1:1', '16:9'])
  assert.equal(param?.default, 'auto')
})

test('с референсом «Авто» остаётся: там ему есть по чему решать', () => {
  const [param] = panelParams(model('aspect'), true)
  assert.deepEqual(param?.options?.map((o) => o.value), ['auto', '1:1', '16:9'])
  assert.equal(param?.default, 'auto')
})

test('десктопный промпт оставляет «Авто» доступным и без референса', () => {
  const concreteDefault = model('aspect_ratio')
  concreteDefault.params[0] = { ...concreteDefault.params[0], default: '1:1' }
  const [param] = panelParams(concreteDefault, false, true)
  assert.deepEqual(param?.options?.map((o) => o.value), ['auto', '1:1', '16:9'])
  assert.equal(param?.default, 'auto')
})

test('параметры без «Авто» не трогаем', () => {
  const plain = {
    name: 'duration', label: 'Длительность', widget: 'number' as const, default: 5,
  }
  const [param] = panelParams({ id: 'm', name: 'М', kind: 'video', params: [plain] } as unknown as CatalogModel, false)
  assert.deepEqual(param, plain)
})

test('режим auto пользовательской модели остаётся доступен без референса', () => {
  const [param] = panelParams(model('custom__mode'), false)
  assert.equal(param?.default, 'auto')
  assert.deepEqual(param?.options?.map((option) => option.value), ['auto', '1:1', '16:9'])
})
