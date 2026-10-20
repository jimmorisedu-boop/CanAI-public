import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import ts from 'typescript'
import * as React from 'react'
import * as jsx from 'react/jsx-runtime'
import * as frameStep from '../spaces/canvas/compare/compareFrameStep.js'
import * as compareSync from '../spaces/canvas/compare/compareSync.js'
import * as layout from '../spaces/canvas/compare/compareLayout.js'

// Executes the actual TabletCompare render, its video ref callbacks, and the
// actual shared player effects. Only React scheduling and media decoding are
// substituted, so omitting the hook or forgetting a Panel→Media ref fails here.
function load(relative: string, imports: Record<string, unknown>) {
  const source = fs.readFileSync(new URL(relative, import.meta.url), 'utf8')
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText
  const exports: Record<string, any> = {}
  new Function('exports', 'require', js)(exports, (name: string) => {
    assert.ok(name in imports, `unhandled import ${name}`)
    return imports[name]
  })
  return exports
}

for (const baselineKind of ['image', 'video']) {
  test(`TabletCompare ${baselineKind}+video refs reach real frame handler with probed FPS`, async () => {
    const effects: Array<() => void | (() => void)> = []
    const cleanups: Array<() => void> = []
    const hooks = { ...React,
      useRef: (current: unknown) => ({ current }), useMemo: (run: () => unknown) => run(), useCallback: (run: unknown) => run,
      useImperativeHandle: (ref: any, init: () => unknown) => { if (ref) ref.current = init() },
      useState: (value: unknown) => [typeof value === 'function' ? value() : value, () => {}],
      useEffect: (run: () => void | (() => void)) => effects.push(run),
    }
    const requests: string[] = []
    const api = { probeVideo: async (src: string) => { requests.push(src); return { fps: src.includes('base') ? 60 : 24 } } }
    const playbackRefs: any[] = []
    const playbackControls = ({ mediaRef }: { mediaRef: any }) => {
      playbackRefs.push(mediaRef)
      return jsx.jsx('div', { className: 'media-playback-controls', 'aria-label': 'Media playback controls' })
    }
    const player = load('../spaces/canvas/compare/useComparePlayer.ts', {
      react: hooks, '../../../api': { api }, './compareFrameStep': frameStep, './compareSync': compareSync,
    })
    let active = true
    const tablet = load('./TabletCompare.tsx', {
      react: hooks, 'react/jsx-runtime': jsx,
      '../ui/icons': { IconNext: () => null, IconPrev: () => null },
      '../spaces/canvas/konva/useStore': { useContentVersion() {} },
      '../spaces/canvas/genOptions': { useCatalogModels: () => ({ models: [] }) },
      '../spaces/canvas/compare/compareLayout': layout,
      '../spaces/canvas/compare/compareLabels': { panelLabel: () => '', panelSubLabel: () => '' },
      '../spaces/canvas/compare/faceMath': { DEFAULT_FACE_THRESHOLD: 0.5 },
      '../spaces/canvas/compare/FaceSimilarityChip': { useFaceSimilarity: () => null, FaceSimilarityChip: () => null },
      '../api': { api }, '../spaces/canvas/notifications': { notify() {} }, '../ui/plural': { plural: () => '' },
      './TabletFullScreen': { TabletFullScreen: ({ children, footer }: any) => jsx.jsxs('main', { children: [children, footer] }) },
      './remoteSession': { previewSrc: (src: string) => src }, './boardHistory': { useBoardHistory: () => ({ undo() {} }) },
      '../spaces/canvas/compare/useComparePlayer': player,
      './modalFocus': { isActiveModal: () => active },
      '../ui/MediaPlaybackControls': { MediaPlaybackControls: playbackControls },
    })
    const listeners = new Set<(event: any) => void>()
    const saved = ['window', 'requestAnimationFrame', 'cancelAnimationFrame'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const)
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { addEventListener: (type: string, run: any) => { if (type === 'keydown') listeners.add(run) }, removeEventListener: (_: string, run: any) => listeners.delete(run) } })
    Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: () => 1 })
    Object.defineProperty(globalThis, 'cancelAnimationFrame', { configurable: true, value: () => {} })
    const videos: any[] = []
    const text: string[] = []
    const walk = (node: any) => {
      if (Array.isArray(node)) { node.forEach(walk); return }
      if (typeof node === 'string') { text.push(node); return }
      if (!node || typeof node !== 'object') return
      if (typeof node.type === 'function') { walk(node.type(node.props)); return }
      let host: any = { closest: () => ({}) }
      if (node.type === 'video') {
        assert.equal(Boolean(node.props.controls), false, 'native video controls stay disabled')
        host = { currentTime: 0, duration: node.props.src.includes('base') ? 2 : 3, readyState: 4, paused: false,
          pause() { this.paused = true }, play: async () => {}, getAttribute: () => node.props.src, addEventListener() {}, removeEventListener() {} }
        videos.push(host)
      }
      if (typeof node.ref === 'function') node.ref(host)
      else if (node.ref) node.ref.current = host
      walk(node.props?.children)
    }
    const press = (options: Record<string, unknown> = {}) => {
      const event = { code: 'KeyD', key: 'в', shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, target: { tagName: 'VIDEO' }, defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true }, stopPropagation() {}, ...options }
      listeners.forEach(run => run(event)); return event
    }
    try {
      const items = [{ id: 'base', kind: baselineKind, src: '/media/base.mp4' }, { id: 'candidate', kind: 'video', src: '/media/candidate.mp4' }]
      walk(tablet.TabletCompare({ store: { getItem: (id: string) => items.find(item => item.id === id), getContentVersion: () => 1 }, baseId: 'base', candidateIds: ['candidate'], onClose() {} }))
      for (const run of effects) { const cleanup = run(); if (cleanup) cleanups.push(cleanup) }
      await Promise.resolve()
      assert.equal(playbackRefs.length, videos.length, 'every video gets English playback controls')
      assert.ok(playbackRefs.every((ref) => ref.current), 'playback controls receive mounted media refs')
      assert.ok(requests.includes('/media/candidate.mp4'), 'the actual tablet hook must probe video FPS')
      assert.equal(press().defaultPrevented, true)
      assert.ok(videos.every(video => video.currentTime === 1.5 / 24 && video.paused))
      press({ shiftKey: true }); assert.ok(videos.every(video => video.currentTime === 11.5 / 24))
      press({ code: 'KeyA', key: 'ф', shiftKey: true }); assert.ok(videos.every(video => video.currentTime === 1.5 / 24))
      press({ code: 'KeyA', key: 'a' }); assert.ok(videos.every(video => video.currentTime === 0))
      for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) assert.equal(press({ target: { tagName } }).defaultPrevented, false)
      assert.equal(press({ ctrlKey: true }).defaultPrevented, false)
      active = false; assert.equal(press().defaultPrevented, false, 'a higher modal owns the keyboard')
      assert.ok(videos.every(video => video.currentTime === 0))
      assert.match(text.join(' '), /A.*D.*10/u)
    } finally {
      cleanups.forEach(run => run())
      for (const [name, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor)
        else Reflect.deleteProperty(globalThis, name)
      }
    }
    assert.equal(listeners.size, 0, 'closing comparison removes the key listener')
  })
}
