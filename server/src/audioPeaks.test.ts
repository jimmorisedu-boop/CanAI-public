import assert from 'node:assert/strict'
import test from 'node:test'
import { isUsefulPeaks, peaksFromPcm, sanitizePeaks, PEAK_COUNT } from './audioPeaks.js'

function pcm(samples: number[]): Buffer {
  const buffer = Buffer.alloc(samples.length * 2)
  samples.forEach((value, index) => buffer.writeInt16LE(value, index * 2))
  return buffer
}

test('тихая запись всё равно рисуется во всю высоту', () => {
  // Нормируем по самому громкому месту дорожки, а не по максимуму формата:
  // иначе тихо записанный голос лёг бы ровной полоской у нижнего края и
  // волна перестала бы что-либо показывать.
  const quiet = peaksFromPcm(pcm([100, 200, 400, 200]), 4)
  assert.deepEqual(quiet, [25, 50, 100, 50])

  const loud = peaksFromPcm(pcm([8000, 16000, 32000, 16000]), 4)
  assert.deepEqual(loud, [25, 50, 100, 50])
})

test('в столбик попадает самое громкое место, а не среднее', () => {
  // Среднее сглаживает удары — по такой волне не найти границу шота.
  // Первый столбик: один громкий отсчёт среди тишины. По среднему он дал бы
  // треть высоты, по пику — полную, и удар остаётся виден.
  const peaks = peaksFromPcm(pcm([1000, 0, 0, 500, 500, 500]), 2)
  assert.deepEqual(peaks, [100, 50])
})

test('тишина не делится на ноль и не выдумывает волну', () => {
  assert.deepEqual(peaksFromPcm(pcm([0, 0, 0, 0]), 2), [0, 0])
  assert.equal(isUsefulPeaks(peaksFromPcm(pcm([0, 0]), 2)), false)
  assert.equal(isUsefulPeaks(peaksFromPcm(pcm([0, 5]), 2)), true)
})

test('коротких данных не хватает на все столбики — берём сколько есть', () => {
  const peaks = peaksFromPcm(pcm([1000, -2000]), 64)
  assert.equal(peaks.length, 2)
  assert.deepEqual(peaks, [50, 100], 'знак не важен, важна громкость')
})

test('пустой и обрезанный буфер не роняют расчёт', () => {
  assert.deepEqual(peaksFromPcm(Buffer.alloc(0)), [])
  // Нечётная длина: последний байт — половина отсчёта, его просто нет
  assert.deepEqual(peaksFromPcm(Buffer.from([0x10]), 4), [])
})

test('в проект пускаем только короткий список целых 0..100', () => {
  assert.deepEqual(sanitizePeaks([0, 50.4, 100]), [0, 50, 100])
  assert.deepEqual(sanitizePeaks([-20, 500]), [0, 100], 'выходящее за края прижимаем, а не отвергаем')
  assert.equal(sanitizePeaks([]), undefined)
  assert.equal(sanitizePeaks('волна'), undefined)
  assert.equal(sanitizePeaks([1, 'два']), undefined)
  assert.equal(sanitizePeaks([1, Number.NaN]), undefined)
  assert.equal(sanitizePeaks(new Array(PEAK_COUNT + 1).fill(10)), undefined, 'длинный массив раздувает доску')
})
