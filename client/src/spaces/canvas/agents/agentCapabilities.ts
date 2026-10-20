/**
 * What the current board transport is willing to expose in the agent UI.
 *
 * This is intentionally presentation-level: components must not infer a
 * transport from `ProjectRef.source`, because a paired/remote Host can have
 * the same project source while offering a different set of operations.
 */
export interface AgentPresentationCapability {
  /** Server-advertised transport, not derived from ProjectRef.source. */
  transport?: 'host' | 'cloud'
  /** Whether this catalog is installed locally or pinned by Cloud operator. */
  catalog?: 'host-installed' | 'cloud-published'
  billing?: 'local-fal' | 'cloud-wallet' | 'none'
  canObserve?: boolean
  /** Optional server grant for transferring selected canvas media to Cloud. */
  canTransferMedia?: boolean
  canControl: boolean
  canLaunch: boolean
  canReview?: boolean
  label: string
  reason?: string
}
