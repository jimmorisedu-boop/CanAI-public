export interface AccountPublication {
  id: string
  sourceKind: 'personal' | 'cloud'
  personalDraftId: string | null
  projectId?: string | null
  title?: string
  state?: 'active' | 'paused'
  commentsEnabled?: boolean
  expiresAt?: number | null
  activeRevisionId?: string | null
  createdAt?: number
  updatedAt?: number
  /**
   * Готовая ссылка для заказчика.
   *
   * ⚠️ Её собирает СЕРВЕР: публичный адрес знает только он. У публикаций,
   * созданных до того, как сервер начал хранить ссылку, её нет — там остался
   * лишь отпечаток, и получить ссылку можно только выпустив новую.
   */
  url?: string | null
}

export interface AccountPublicationResult {
  share: AccountPublication
  token: string
  url: string
}

export interface AccountPublishedRevision {
  revisionId: string
  shareId: string
  revision: number
  checksum: string
  createdAt: number
}

export function publicationAction(input: {
  dirty: boolean
  canPublish: boolean
}): 'publish' | 'blocked' | 'none' {
  if (!input.dirty) return 'none'
  return input.canPublish ? 'publish' : 'blocked'
}

/** Autosync is private backup only. Keeping this explicit prevents a future
 * status effect from accidentally turning into customer publication. */
export function autoSyncEffect(_input: {
  dirty: boolean
  publicationId: string | null
}): { publishes: false } {
  return { publishes: false }
}

export function publicationForPersonalDraft<T extends Pick<AccountPublication, 'sourceKind' | 'personalDraftId'>>(
  publications: T[],
  draftId: string | undefined,
): T | undefined {
  if (!draftId) return undefined
  return publications.find((publication) => (
    publication.sourceKind === 'personal' && publication.personalDraftId === draftId
  ))
}

export function hasUnpublishedChanges(
  currentRemoteRevisionId: string | undefined,
  publishedSourceRevisionId: string | undefined,
): boolean {
  return Boolean(
    currentRemoteRevisionId
    && publishedSourceRevisionId
    && currentRemoteRevisionId !== publishedSourceRevisionId,
  )
}

export type AccountShareSourceKind = AccountPublication['sourceKind']

/**
 * Публикация КОМАНДНОЙ доски. ⚠️ Ищется по projectId, а не по личному
 * черновику: у сетевой доски черновика нет вовсе, и общий поиск нашёл бы
 * чужую публикацию либо не нашёл ничего.
 */
export function publicationForCloudBoard<
  T extends Pick<AccountPublication, 'sourceKind' | 'projectId'>,
>(items: readonly T[], projectId: string | undefined): T | null {
  if (!projectId) return null
  return items.find((item) => item.sourceKind === 'cloud' && item.projectId === projectId) ?? null
}
