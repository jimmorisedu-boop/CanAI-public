/** Метки сортируются по показу: порядок пакетов кодека может отличаться. */
export async function collectFrameTimes(packets: AsyncIterable<{ timestamp: number }>, signal?: AbortSignal): Promise<number[]> {
  const times: number[] = []
  for await (const packet of packets) {
    signal?.throwIfAborted()
    if (Number.isFinite(packet.timestamp) && packet.timestamp >= 0) times.push(packet.timestamp)
    if (times.length > 120_000) throw new Error('Use second-based seeking for this long clip')
    if (times.length % 500 === 0) await new Promise(resolve => setTimeout(resolve, 0))
  }
  return [...new Set(times)].sort((a, b) => a - b)
}

export function adjacentFrameTime(times: number[], current: number, direction: -1 | 1): number {
  if (!times.length) return current
  let lo = 0, hi = times.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (times[mid] <= current + 0.000001) lo = mid + 1
    else hi = mid
  }
  const shown = Math.max(0, lo - 1)
  return times[Math.max(0, Math.min(times.length - 1, shown + direction))]
}

export async function readVideoFrameTimes(src: string, signal: AbortSignal): Promise<number[]> {
  const { Input, UrlSource, MP4, QTFF, WEBM, MATROSKA, EncodedPacketSink } = await import('mediabunny')
  signal.throwIfAborted()
  const input = new Input({ formats: [MP4, QTFF, WEBM, MATROSKA], source: new UrlSource(src, {
    maxCacheSize: 8 * 1024 * 1024, parallelism: 1, getRetryDelay: attempts => attempts < 2 ? 1 : null,
  }) })
  const abort = () => input.dispose()
  signal.addEventListener('abort', abort, { once: true })
  const timeout = setTimeout(abort, 25_000)
  try {
    const track = await input.getPrimaryVideoTrack()
    if (!track) throw new Error('Video track not found')
    return await collectFrameTimes(new EncodedPacketSink(track).packets(undefined, undefined, { metadataOnly: true }), signal)
  } finally {
    clearTimeout(timeout)
    signal.removeEventListener('abort', abort)
    input.dispose()
  }
}
