import { useId, type CSSProperties, type ReactElement, cloneElement } from 'react'

/** Куда открывается подсказка. По умолчанию — вниз, по правому краю значка
 *  (так её рисует шапка приложения). Нижним рядам окна нужен верх: снизу
 *  подсказке некуда деться, её срезало бы краем окна. */
export type TooltipPlacement = 'bottom-end' | 'top' | 'top-start' | 'top-end'

/**
 * Подсказка у иконки: название и строка о том, что произойдёт.
 *
 * ⚠️ Материал общий с подсказкой экспорта, а не свой: у иконок в шапке уже
 * было по три почти одинаковых значка, и заводить для них ещё и собственный
 * вид всплывающей подписи значило бы разводить интерфейс дальше.
 *
 * ⚠️ Родной `title` у обёрнутой кнопки СНИМАЕТСЯ: браузер показал бы вторую
 * подсказку поверх нашей, с задержкой и в своём оформлении.
 *
 * `hostClassName`/`hostStyle` — для случая, когда сама обёртка должна встать на
 * место (метка на дорожке лежит в процентах от её ширины): обёртка и есть
 * тот элемент, который позиционируется, а подсказка висит у него.
 */
export function Tooltip({
  title,
  hint,
  placement = 'bottom-end',
  hostClassName,
  hostStyle,
  children,
}: {
  title: string
  hint?: string
  placement?: TooltipPlacement
  hostClassName?: string
  hostStyle?: CSSProperties
  children: ReactElement<{ title?: string; 'aria-describedby'?: string }>
}) {
  const id = useId()
  return (
    <span className={hostClassName ? `ui-tooltip-host ${hostClassName}` : 'ui-tooltip-host'} style={hostStyle}>
      {cloneElement(children, { title: undefined, 'aria-describedby': id })}
      <span className={placement === 'bottom-end' ? 'ui-tooltip' : `ui-tooltip ${placement}`} role="tooltip" id={id}>
        <strong>{title}</strong>
        {hint ? <span>{hint}</span> : null}
      </span>
    </span>
  )
}
