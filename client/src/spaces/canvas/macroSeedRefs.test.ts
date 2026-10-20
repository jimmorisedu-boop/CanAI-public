// @ts-expect-error Клиентские тесты запускаются через tsx с Node-типами.
import assert from 'node:assert/strict'
// @ts-expect-error Production-клиент не зависит от Node-типов.
import test from 'node:test'
import { toMacroSeedRefs } from './macroSeedRefs.js'

test('typed Input graph preserves a selected video as video', async () => {
  const refs = await toMacroSeedRefs(
    [
      {
        shapeId: 'video',
        kind: 'video',
        label: 'видео',
        src: '/media/source.mp4',
      },
    ],
    true,
  )

  assert.equal(refs.length, 1)
  assert.equal(refs[0].kind, 'video')
  assert.equal('src' in refs[0] ? refs[0].src : undefined, '/media/source.mp4')
})
