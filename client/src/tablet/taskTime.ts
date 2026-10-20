export function minutesSince(at: number, now = Date.now()): string {
  if (!Number.isFinite(at) || at <= 0) return 'time unknown'
  const minutes = Math.floor((now - at) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours} hr ago` : `${Math.floor(hours / 24)} days ago`
}
