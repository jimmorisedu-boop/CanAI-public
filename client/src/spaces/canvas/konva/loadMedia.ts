// Загрузка картинки в <img> для offscreen-склейки: кроп, скетч, экспорт.
//
// Жила двумя одинаковыми копиями в cropApply и sketchExport, различаясь лишь
// текстом ошибки. Копии опасны не размером, а тем, что crossOrigin здесь не
// украшение: без него холст, куда картинку рисуют, становится «испорченным»
// (tainted), и toBlob падает — то есть кроп и скетч молча перестают
// применяться. Поправить такое в одной копии и забыть про вторую — вопрос
// времени.
export function loadImage(src: string, what = 'image'): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error(`failed to load ${what}`))
    img.src = src
  })
}
