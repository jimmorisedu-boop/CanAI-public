// Замеры холста прямо в странице (пункт 5.8). Одинаково для Firefox и Chrome.
//
// ⚠️ Частота requestAnimationFrame в Firefox НЕ показывает, что видит человек:
// холст рисуется в отдельном процессе, и страница бодро тикает 60 раз в
// секунду, пока картинка на экране меняется в разы реже. Поэтому стоимость
// кадра меряем С ДОЖИДАНИЕМ холста — getImageData после отрисовки.
(() => {
  const stage = () => window.Konva && window.Konva.stages && window.Konva.stages[0]
  const stats = (values) => {
    if (!values.length) return null
    const sorted = [...values].sort((a, b) => a - b)
    const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]
    const avg = values.reduce((a, b) => a + b, 0) / values.length
    return {
      n: values.length,
      avg: +avg.toFixed(1),
      p50: +at(0.5).toFixed(1),
      p95: +at(0.95).toFixed(1),
      max: +sorted[sorted.length - 1].toFixed(1),
      fps: +(1000 / avg).toFixed(0),
    }
  }
  const images = () => stage().find('Image')
  const flushCanvas = () => stage().getLayers()[0].getContext()._context.getImageData(0, 0, 1, 1)

  window.__canvasProbe = {
    status() {
      const st = stage()
      if (!st) return { ready: false }
      const all = images()
      const loaded = all.filter((node) => {
        const img = node.image()
        return img && (img.naturalWidth || img.videoWidth || img.width)
      })
      return { ready: true, scale: +st.scaleX().toFixed(3), images: all.length, loaded: loaded.length }
    },
    /** Какими копиями нарисованы картинки: ступень превью или оригинал. */
    steps() {
      const counts = {}
      for (const node of images()) {
        const img = node.image()
        let key = 'none'
        if (img instanceof HTMLVideoElement) key = 'video'
        else if (img instanceof HTMLCanvasElement) key = 'frame'
        else if (img) {
          const src = img.currentSrc || img.src || ''
          const step = src.match(/[?&]w=(\d+)/)
          key = step ? step[1] : 'original'
        }
        counts[key] = (counts[key] || 0) + 1
      }
      return counts
    },
    /** Стоимость полной перерисовки слоя картинок с дожиданием холста. */
    drawCost(times = 8) {
      const layer = stage().getLayers()[0]
      layer.draw()
      flushCanvas()
      const values = []
      for (let i = 0; i < times; i += 1) {
        const started = performance.now()
        layer.draw()
        flushCanvas()
        values.push(performance.now() - started)
      }
      return stats(values)
    },
    /** Запись кадров во время жеста; с дожиданием холста на каждом кадре. */
    recordStart() {
      const record = { stamps: [], on: true }
      window.__canvasRecord = record
      const tick = (time) => {
        if (!record.on) return
        flushCanvas()
        record.stamps.push(time)
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
      return true
    },
    recordStop() {
      const record = window.__canvasRecord
      record.on = false
      return stats(record.stamps.slice(1).map((value, index) => value - record.stamps[index]))
    },
  }
  return true
})()
