import type { MutableRefObject } from 'react'
import type { AgentArchiveUpload } from './agentHostClient'
import type { AgentPackageController } from './agentPanelController'
import { newRequestId, sourceDrafts, type ConnectionNotice, type SourceDraft, type UploadPending } from './agentConnectionsModel'

export async function uploadAgentArchive({
  archive,
  name,
  projectKey,
  draft,
  uploadPending,
  controller,
  serialRef,
  setDraft,
  setUploadPending,
  setBusy,
  setCheckRetry,
  setNotice,
  checkRequestId,
  checkSourceKey,
  showCurrentError,
}: {
  archive: Blob
  name: string
  projectKey: string
  draft: SourceDraft
  uploadPending: UploadPending | null
  controller: Pick<AgentPackageController, 'uploadPackageArchive'>
  serialRef: MutableRefObject<number>
  setDraft(value: SourceDraft): void
  setUploadPending(value: UploadPending | null): void
  setBusy(value: string | null): void
  setCheckRetry(value: SourceDraft | null): void
  setNotice(value: ConnectionNotice | null): void
  checkRequestId: MutableRefObject<string | null>
  checkSourceKey: MutableRefObject<string | null>
  showCurrentError(error: unknown, serial: number): void
}): Promise<void> {
  const operation = uploadPending && uploadPending.archive === archive
    ? uploadPending
    : { requestId: newRequestId('upload'), archive, name }
  setUploadPending(operation)
  setBusy('upload')
  setNotice(null)
  const serial = serialRef.current
  try {
    const upload: AgentArchiveUpload = await controller.uploadPackageArchive({ requestId: operation.requestId, archive })
    if (serial !== serialRef.current) return
    const next: SourceDraft = { ...draft, kind: 'archive', archiveId: upload.archiveId, archiveSha: upload.archiveSha, archiveSize: upload.sizeBytes, archiveName: name }
    // The receipt, not the local filename, is the immutable source pin.
    sourceDrafts.set(projectKey, next)
    setDraft(next)
    setUploadPending(null)
    setCheckRetry(null)
    checkRequestId.current = null
    checkSourceKey.current = null
    setNotice({ tone: 'success', title: 'Host accepted the ZIP', detail: 'Archive pinned by SHA. Click “Check” to read the manifest and permissions.' })
  } catch (error) {
    showCurrentError(error, serial)
  } finally {
    if (serial === serialRef.current) setBusy(null)
  }
}
