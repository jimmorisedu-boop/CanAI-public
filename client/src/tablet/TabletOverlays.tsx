import { Suspense, lazy } from 'react'
import type { CanvasStore } from '../spaces/canvas/konva/canvasStore'
import { TabletArchive } from './TabletArchive'
import { TabletCrop } from './TabletCrop'
import { TabletSettings } from './TabletSettings'
import { TabletHelp } from './TabletHelp'
import { TabletSketch } from './TabletSketch'
import { TabletTextEditor } from './TabletTextEditor'
import { tabletMediaUploader, type TabletRuntime } from './runtime'
import { useT } from '../i18n/context.js'


const TabletClip = lazy(() => import('./TabletClip').then((module) => ({ default: module.TabletClip })))
const TabletCompare = lazy(() => import('./TabletCompare').then((module) => ({ default: module.TabletCompare })))

export type TabletEditor =
  | null
  | { kind: 'sketch'; itemId: string }
  | { kind: 'crop'; itemId: string }
  | { kind: 'clip'; itemId: string; tool?: 'audio' }
  | { kind: 'compare'; baseId: string; candidateIds: string[] }
  | { kind: 'text'; itemId: string }
  | { kind: 'archive' }
  | { kind: 'settings' }
  | { kind: 'help' }

export function TabletOverlays({ editor, store, projectId, runtime, onClose }: {
  editor: TabletEditor
  store: CanvasStore
  projectId: string
  boardName: string
  runtime: TabletRuntime
  onClose(): void
}) {
  const t = useT()
  if (!editor) return null
  if (editor.kind === 'text') return <TabletTextEditor store={store} itemId={editor.itemId} onClose={onClose} />
  if (editor.kind === 'sketch') return <TabletSketch store={store} itemId={editor.itemId} projectId={projectId} projectSource="local" upload={tabletMediaUploader(runtime, projectId)} onClose={onClose} />
  if (editor.kind === 'crop') return <TabletCrop store={store} itemId={editor.itemId} upload={tabletMediaUploader(runtime, projectId)} onClose={onClose} />
  if (editor.kind === 'archive') return <TabletArchive store={store} onClose={onClose} />
  if (editor.kind === 'settings') return <TabletSettings onClose={onClose} />
  if (editor.kind === 'help') return <TabletHelp onClose={onClose} />
  return <Suspense fallback={<div className="tablet-modal-loading" role="status">{t('Opening…')}</div>}>
    {editor.kind === 'clip'
      ? <TabletClip store={store} upload={tabletMediaUploader(runtime, projectId)} itemId={editor.itemId} tool={editor.tool} onClose={onClose} />
      : <TabletCompare store={store} baseId={editor.baseId} candidateIds={editor.candidateIds} onClose={onClose} />}
  </Suspense>
}
