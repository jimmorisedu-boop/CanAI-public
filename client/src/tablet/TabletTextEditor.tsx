import { useEffect, useRef, useState } from 'react'
import type { CanvasStore } from '../spaces/canvas/konva/canvasStore'
import { DEFAULT_FONT_SIZE } from '../spaces/canvas/konva/canvasLayout'
import { TabletDialog } from './TabletDialog'
import { confirmDiscardDraft } from './confirmDiscardDraft'
import { useT } from '../i18n/context.js'


// Правка текста на доске.
//
// Не «редактор» в полный экран: текстовый объект короткий, и полноэкранная
// правка увела бы человека от доски ради одной строки. Окно с полем и
// размером кегля — ровно столько, сколько нужно.
//
// Пустой текст, закрытый без ввода, УДАЛЯЕТСЯ: так же ведёт себя инлайн-правка
// на компьютере — иначе кнопка «Текст» оставляла бы на доске невидимые пустышки.

const SIZES = [12, 15, 20, 28, 40, 64]

export function TabletTextEditor({
  store,
  itemId,
  onClose,
}: {
  store: CanvasStore
  itemId: string
  onClose(): void
}) {
  const t = useT()
  const item = store.getItem(itemId)
  const [text, setText] = useState(item?.text ?? '')
  const [size, setSize] = useState(item?.fontSize ?? DEFAULT_FONT_SIZE)
  const [initialText] = useState(text)
  const [initialSize] = useState(size)
  const areaRef = useRef<HTMLTextAreaElement>(null)
  const created = useRef(!item?.text)

  useEffect(() => {
    areaRef.current?.focus()
  }, [])

  if (!item) return null

  const close = async () => {
    if (!await confirmDiscardDraft(text !== initialText || size !== initialSize)) return
    if (created.current) store.removeItems([itemId])
    onClose()
  }

  const save = () => {
    if (!text.trim()) {
      store.removeItems([itemId])
      onClose()
      return
    }
    store.updateItem(itemId, { text, fontSize: size })
    store.autoFitText(itemId)
    onClose()
  }

  return (
    <TabletDialog
      title={t('Text')}
      onClose={close}
      wide
      actions={
        <>
          <button type="button" className="ui-btn quiet" onClick={close}>{t('Cancel')}</button>
          <button type="button" className="ui-btn primary" onClick={save}>{t('Done')}</button>
        </>
      }
    >
      <textarea
        ref={areaRef}
        className="ui-field tablet-text-area"
        aria-label={t('Object text')}
        value={text}
        rows={6}
        style={{ fontSize: Math.min(size, 28) }}
        onChange={(event) => setText(event.target.value)}
      />
      <div className="tablet-text-sizes">
        <span>{t('Font size')}</span>
        <div className="ui-toggle" role="group" aria-label={t('Font size')}>
          {SIZES.map((value) => (
            <button
              key={value}
              type="button"
              className={size === value ? 'on' : ''}
              aria-pressed={size === value}
              onClick={() => setSize(value)}
            >
              {value}
            </button>
          ))}
        </div>
      </div>
    </TabletDialog>
  )
}
