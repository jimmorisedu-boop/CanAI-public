import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SelectionRef } from './konva/selection'
import { ReferenceChips } from './ReferenceChips'
import { refChipFallback } from './refChipFallback'
import { refChipHoverSrc } from './RefChipPreview'
import { refChipFailureLabel } from './RefChip'

test('the shared list numbers media only and keeps text references visible', () => {
  const refs: SelectionRef[] = [
    {
      shapeId: 'image',
      kind: 'image',
      label: 'Кадр',
      src: '/media/frame.png',
    },
    {
      shapeId: 'note',
      kind: 'text',
      label: 'Контекст',
      text: 'Контекст',
    },
    {
      shapeId: 'video',
      kind: 'video',
      label: 'Ролик',
      src: '/media/clip.mp4',
    },
  ]
  const html = renderToStaticMarkup(
    <ReferenceChips refs={refs} onRemove={() => {}} onTag={() => {}} />,
  )

  assert.equal((html.match(/class="ref-chip"/g) ?? []).length, 3)
  assert.match(html, /class="ref-chip-num">1</)
  assert.match(html, /class="ref-chip-num">2</)
  assert.doesNotMatch(html, /class="ref-chip-num">3</)
  assert.match(html, /Контекст/)
  assert.equal((html.match(/role="button"/g) ?? []).length, 3)
  assert.equal((html.match(/tabindex="0"/g) ?? []).length, 3)
  assert.match(html, /aria-label="Кадр/)
})

test('limits the visible chips to 15 and shows the remaining count', () => {
  const refs: SelectionRef[] = Array.from({ length: 25 }, (_, i) => ({
    shapeId: `id-${i}`,
    kind: 'image',
    label: `Изображение ${i}`,
    src: `/media/${i}.png`,
  }))
  const html = renderToStaticMarkup(
    <ReferenceChips refs={refs} onRemove={() => {}} onTag={() => {}} />,
  )
  assert.equal((html.match(/class="ref-chip"/g) ?? []).length, 15)
  assert.match(html, /class="ref-chip ref-chip-more"/)
  assert.match(html, /\+10/)
})

test('shows the active replacement slot and its available gesture', () => {
  const refs: SelectionRef[] = [{
    shapeId: 'image',
    kind: 'image',
    label: 'Кадр',
    src: '/media/frame.png',
  }]
  const html = renderToStaticMarkup(
    <ReferenceChips
      refs={refs}
      onRemove={() => {}}
      onTag={() => {}}
      onReplace={() => {}}
      replacingShapeId="image"
    />,
  )

  assert.match(html, /class="ref-chip is-replacing"/)
  assert.match(html, /Replace by double clicking or Shift\+Enter/)
  assert.match(html, /Double click - replace reference/)
})

test('a local image chip uses the bounded preview and keeps retry details readable', () => {
  const ref: SelectionRef = {
    shapeId: 'local-image',
    kind: 'image',
    src: '/media/ast_ref.png',
    label: 'изображение',
  }
  const html = renderToStaticMarkup(
    <ReferenceChips refs={[ref]} onRemove={() => {}} onTag={() => {}} />,
  )

  assert.match(html, /src="\/media\/preview\/ast_ref\.png\?w=256"/)
  assert.doesNotMatch(html, /src="\/media\/ast_ref\.png"/)

  const broken = refChipFallback(ref)
  assert.equal(broken.name, 'ast_ref.png')
  assert.match(refChipFailureLabel(broken), /ast_ref\.png.*Click to retry loading/)
})

test('hover and read-only chips keep local image previews and local video sources', () => {
  assert.equal(
    refChipHoverSrc({
      shapeId: 'hover-image',
      kind: 'image',
      label: 'изображение',
      src: '/media/ast_hover.png',
    }),
    '/media/preview/ast_hover.png?w=256',
  )
  assert.equal(
    refChipHoverSrc({
      shapeId: 'hover-video',
      kind: 'video',
      label: 'Ролик',
      src: '/media/ast_video.mp4',
    }),
    '/media/ast_video.mp4',
  )
})
