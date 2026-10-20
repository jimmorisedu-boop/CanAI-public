export const ARCHIVE_PAGE_SIZE = 40

export function archiveDisplayPage<T>(entries: T[], limit: number): {
  visible: T[]
  remaining: number
} {
  const safeLimit = Math.max(0, Math.floor(limit))
  return {
    visible: entries.slice(0, safeLimit),
    remaining: Math.max(0, entries.length - safeLimit),
  }
}
