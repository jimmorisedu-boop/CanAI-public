export type MediaProvider = 'direct' | 'youtube' | 'vimeo' | 'tiktok' | 'instagram'
export type MediaEntryKind = 'image' | 'video'

export type MediaImportStatus =
  | 'queued'
  | 'preparing'
  | 'downloading'
  | 'processing'
  | 'completed'
  | 'error'
  | 'cancelled'
  | 'interrupted'

export interface MediaLinkEntry {
  id: string
  kind: MediaEntryKind
  title: string
  aspectRatio: number
}

export interface MediaLinkPreview {
  normalizedUrl: string
  provider: MediaProvider
  sourceLabel: string
  title: string
  previewSrc?: string
  previewKind?: MediaEntryKind
  entries: MediaLinkEntry[]
}

export interface MediaImportResult {
  url: string
  assetId?: string
  assetRevision?: number
  assetChecksum?: string
  mime: string
  name: string
  width?: number
  height?: number
}

export interface MediaImportItem extends MediaLinkEntry {
  status: MediaImportStatus
  downloadedBytes: number
  totalBytes?: number
  percent?: number
  stage?: string
  error?: string
  result?: MediaImportResult
}

export interface MediaImportTask {
  id: string
  sourceUrl: string
  provider: MediaProvider
  status: MediaImportStatus
  createdAt: number
  updatedAt: number
  items: MediaImportItem[]
  error?: string
}
