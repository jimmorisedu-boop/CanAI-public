import { useEffect, useState } from 'react'
import { api } from '../../../api'

/**
 * Реальные пики громкости аудиодорожки клипа (0..100) для отрисовки волны речи
 * под плёнкой кадров. Если пики уже сохранены на объекте холста — отдаёт их
 * сразу без запроса к серверу; если в клипе нет звука — пустой массив.
 */
export function useClipAudioPeaks(
  src: string | undefined,
  hasAudio: boolean | undefined,
  cachedPeaks: readonly number[] | undefined,
): readonly number[] {
  const [fetched, setFetched] = useState<{ src: string; peaks: readonly number[] } | null>(null)

  useEffect(() => {
    if (!src || hasAudio !== true) return
    if (cachedPeaks && cachedPeaks.length > 0) return
    let cancelled = false
    api.audioPeaks(src)
      .then((res) => {
        if (!cancelled && Array.isArray(res.peaks)) {
          setFetched({ src, peaks: res.peaks })
        }
      })
      .catch(() => {
        // Волна — визуальный ориентир; сбой чтения пиков не должен мешать монтажу.
      })
    return () => { cancelled = true }
  }, [src, hasAudio, cachedPeaks])

  if (hasAudio === false) return []
  if (cachedPeaks && cachedPeaks.length > 0) return cachedPeaks
  if (hasAudio === true && src && fetched?.src === src) return fetched.peaks
  return []
}
