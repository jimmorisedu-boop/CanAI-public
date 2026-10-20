// Раскладка красной карточки «Не получилось». Считается от КРАЁВ карточки, а
// не отступами от центра: текст ошибки бывает в четыре строки и наезжал на
// кнопки. Кнопки прибиты к низу, текст занимает остаток сверху и обрезается
// многоточием. Всё в конечных пикселях — Konva сама ничего не раскладывает.

export interface ErrorCardLayout {
  pad: number
  titleY: number
  titleSize: number
  showTitle: boolean
  detailY: number
  detailH: number
  detailSize: number
  buttonsY: number
  btnW: number
  btnH: number
  gap: number
}

export function errorCardLayout(input: {
  w: number
  h: number
  scale: number
}): ErrorCardLayout {
  const { w, h, scale } = input
  const pad = 14 * scale
  const titleSize = 14 * scale
  const detailSize = 11.5 * scale
  const btnH = 26 * scale
  const gap = 8 * scale
  // две кнопки должны помещаться по ширине даже на узкой карточке
  const btnW = Math.max(48 * scale, Math.min(96 * scale, (w - pad * 2 - gap) / 2))

  const buttonsY = Math.max(pad, h - pad - btnH)
  const titleY = pad
  const titleBottom = titleY + titleSize * 1.3
  const detailY = titleBottom + 6 * scale
  const detailH = Math.max(0, buttonsY - 10 * scale - detailY)
  // на совсем низкой карточке важнее кнопки: заголовок уступает им место
  const showTitle = buttonsY - 6 * scale >= titleBottom

  return {
    pad,
    titleY,
    titleSize,
    showTitle,
    detailY,
    detailH,
    detailSize,
    buttonsY,
    btnW,
    btnH,
    gap,
  }
}
