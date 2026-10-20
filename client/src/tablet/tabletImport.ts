import type { CanvasStore } from '../spaces/canvas/konva/canvasStore'
import { importFilesAt } from '../spaces/canvas/konva/importMedia'
import { viewportBounds } from './boardGestures'
import type { TabletRuntime } from './runtime'

// Добавить снимки с планшета.
//
// Кнопка «Добавить» открывает обычный выбор файлов — на iPad это и «Фотоплёнка»,
// и «Файлы», и «Снять фото». Разбирать это самим не нужно и не нужно вовсе:
// системный выбор знает про iCloud, права и HEIC лучше любого нашего экрана.
//
// Загрузка — тот же путь, что на компьютере (importFilesAt): файл уходит
// БИНАРЁМ на сервер и ложится в media, а на доске остаётся ссылка. Инвариант
// «никакого base64 в доске» держится сам собой.

export async function importFilesToBoard(
  store: CanvasStore,
  files: FileList,
  runtime?: TabletRuntime,
  projectId?: string,
): Promise<string[]> {
  const camera = store.getCamera()
  const host = document.querySelector('.tablet-board')
  const viewport = {
    w: host?.clientWidth ?? window.innerWidth,
    h: host?.clientHeight ?? window.innerHeight,
  }
  // Кладём в центр того, что человек сейчас видит: искать добавленное по всей
  // доске — не то, чего ждут от кнопки «Добавить».
  const bounds = viewportBounds(camera, viewport, 0)
  const center = { x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h / 2 }
  return importFilesAt(
    store,
    [...files],
    center,
    {},
    undefined,
    runtime && projectId ? runtime.uploadProjectRef(projectId) : undefined,
    runtime?.uploadAsset && projectId
      ? async (file, signal) => runtime.uploadAsset!(projectId, file, signal)
      : undefined,
  )
}
