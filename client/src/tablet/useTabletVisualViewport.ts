import { useEffect, useRef, useState } from 'react'
import { tabletViewportState } from './visualViewportModel'

export function useTabletVisualViewport() {
  // На iPad Safari иногда уменьшает одновременно `innerHeight` и
  // `visualViewport.height`. Если брать первый прямо из каждого события,
  // клавиатура выглядит как обычный viewport и док остаётся под ней. Высота
  // layout viewport живёт дольше одного события и меняется только после
  // реального изменения ширины (Split View/ориентация) или когда visual
  // viewport вернулся к исходной области.
  const layoutHeightRef = useRef<number | null>(null)
  const layoutWidthRef = useRef<number | null>(null)
  const read = () => {
    const hasWindow = typeof window !== 'undefined'
    const innerHeight = hasWindow ? Math.max(1, Math.round(window.innerHeight)) : 1
    const innerWidth = hasWindow ? Math.max(1, Math.round(window.innerWidth)) : 1
    const viewport = hasWindow ? window.visualViewport : undefined
    const viewportHeight = Math.max(1, Math.round(viewport?.height ?? innerHeight))
    const offsetTop = Math.max(0, Math.round(viewport?.offsetTop ?? 0))

    if (layoutHeightRef.current == null || layoutWidthRef.current == null) {
      layoutHeightRef.current = innerHeight
      layoutWidthRef.current = innerWidth
    } else {
      const widthChanged = Math.abs(innerWidth - layoutWidthRef.current) >= 80
      const bottomInset = layoutHeightRef.current - viewportHeight - offsetTop
      if (widthChanged || bottomInset < 120) {
        layoutHeightRef.current = innerHeight
        layoutWidthRef.current = innerWidth
      }
    }

    return tabletViewportState(layoutHeightRef.current ?? innerHeight, {
      height: viewportHeight,
      offsetTop,
    })
  }
  const [state, setState] = useState(read)

  useEffect(() => {
    const update = () => setState(read())
    update()
    window.addEventListener('resize', update)
    window.visualViewport?.addEventListener('resize', update)
    window.visualViewport?.addEventListener('scroll', update)
    return () => {
      window.removeEventListener('resize', update)
      window.visualViewport?.removeEventListener('resize', update)
      window.visualViewport?.removeEventListener('scroll', update)
    }
  }, [])

  return state
}
