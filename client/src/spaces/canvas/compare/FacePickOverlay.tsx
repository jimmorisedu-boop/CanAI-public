import { useRef } from 'react'
import { useModalFocus } from '../../../tablet/modalFocus'
import { faceBoxFraction, type DetectedFace } from './faceMath'
import { useT } from '../../../i18n/context.js'


// Выбор лица на групповом кадре.
//
// ⚠️ Рамки НЕ показываются сами. Сравнение лиц — не главная работа в
// просмотрщике, и рамки поверх картинки мешали бы всем, кому нужно просто
// сравнить два кадра (просьба пользователя 21.08.2026). Слой открывается
// только по нажатию на «в кадре несколько лиц» и закрывается сразу после
// выбора: показали ровно тогда, когда о них спросили.
//
// Слой отдельный, а не рамки поверх режимов сравнения: в «Шторе» и
// «Переключении» нужная картинка видна лишь частично, и выбирать лицо на
// половине кадра — издевательство.

export function FacePickOverlay({
  src,
  faces,
  natural,
  selected,
  title,
  onPick,
  onCancel,
}: {
  src: string
  faces: DetectedFace[]
  /** Натуральный размер кадра: рамки детектора заданы в его пикселях. */
  natural: { width: number; height: number }
  selected: number
  /** Чьё лицо выбираем — «Исходник» или «Кандидат». */
  title: string
  onPick(index: number): void
  onCancel(): void
}) {
  const t = useT()
  const dialogRef = useRef<HTMLDivElement>(null)
  useModalFocus(dialogRef, onCancel)
  return (
    <div ref={dialogRef} tabIndex={-1} className="face-pick" role="dialog" aria-modal="true" aria-label={t('Select face: {0}', { 0: title })}>
      <div className="face-pick-head">
        <span className="face-pick-title">
          <strong>{title}{t(': which face to compare')}</strong>
          <span>
            {faces.length > 1
              ? t('Click the face to select; faces in the frame: {0}', { 0: faces.length })
              : t('Click a face to select it')}
          </span>
        </span>
        <button type="button" onClick={onCancel}>{t('Cancel')}</button>
      </div>
      <div className="face-pick-stage">
        {/* Обёртка сжимается ровно до картинки: рамки заданы её долями, и
            любой лишний воздух вокруг увёл бы их от лиц. */}
        <div className="face-pick-frame">
        <img className="face-pick-image" src={src} alt="" draggable={false} />
        {faces.map((face, index) => {
          const box = faceBoxFraction(face, natural.width, natural.height)
          return (
          <button
            key={`${face.x}-${face.y}-${index}`}
            type="button"
            className={`face-pick-box${index === selected ? ' on' : ''}`}
            style={{
              left: `${box.x * 100}%`,
              top: `${box.y * 100}%`,
              width: `${box.w * 100}%`,
              height: `${box.h * 100}%`,
            }}
            aria-label={t('Face {0}{1}', { 0: index + 1, 1: index === selected ? ' (selected)' : '' })}
            onClick={() => onPick(index)}
          >
            <span>{index + 1}</span>
          </button>
          )
        })}
        </div>
      </div>
    </div>
  )
}
