import { useRef } from 'react'
import type { AgentArtifact, AgentReviewMaterial } from '../../../../../packages/agent-protocol/index'
import { artifactMediaHref, artifactPreviewHref, reviewArtifactMatch } from './agentPanelPresentation'
import { MediaPlaybackControls } from '../../../ui/MediaPlaybackControls'

const artifactKindLabel: Record<AgentArtifact['kind'], string> = {
  image: 'Image', video: 'Video', audio: 'Audio', text: 'Text', document: 'Document', plan: 'Plan',
}

function AgentVideoReview({ src, caption }: { src: string; caption: string }) {
  const mediaRef = useRef<HTMLVideoElement>(null)
  const fullscreenRef = useRef<HTMLDivElement>(null)
  return (
    <div className="agent-review-artifact-player" ref={fullscreenRef}>
      <video className="agent-review-artifact-preview" ref={mediaRef} src={src} playsInline preload="metadata" aria-label={caption} />
      <MediaPlaybackControls mediaRef={mediaRef} fullscreenRef={fullscreenRef} />
    </div>
  )
}

export function AgentReviewMaterials({
  materials,
  artifacts,
}: {
  materials: readonly AgentReviewMaterial[]
  artifacts: readonly AgentArtifact[]
}) {
  return (
    <div className="agent-review-materials">
      {materials.map((material) => {
        const match = reviewArtifactMatch(artifacts, material)
        const artifact = match.state === 'ready' ? match.artifact : undefined
        const inlineText = typeof (material as unknown as Record<string, unknown>).text === 'string'
          ? String((material as unknown as Record<string, unknown>).text)
          : undefined
        const mediaHref = artifact ? artifactMediaHref(artifact) : undefined
        const previewHref = artifact ? artifactPreviewHref(artifact) : undefined
        return (
          <article className="agent-review-material" key={`${material.artifactId}:${material.revision}`}>
            <div className="agent-review-material-head">
              <strong>{material.caption}</strong>
              {artifact && <span>{artifactKindLabel[artifact.kind]}</span>}
            </div>
            {previewHref && artifact?.kind === 'image' && (
              <img className="agent-review-artifact-preview" src={previewHref} alt={artifact.caption} loading="lazy" />
            )}
            {previewHref && artifact?.kind === 'video' && (
              <AgentVideoReview key={previewHref} src={previewHref} caption={artifact.caption} />
            )}
            {(artifact?.text ?? inlineText) && <pre className="agent-review-artifact-text">{artifact?.text ?? inlineText}</pre>}
            {mediaHref ? (
              <a className="agent-review-artifact-link" href={mediaHref} target="_blank" rel="noreferrer">
                Open artifact file
              </a>
            ) : inlineText ? (
              <span className="agent-review-artifact-missing">Prepared text is shown above</span>
            ) : match.state === 'ready' ? (
              <span className="agent-review-artifact-missing">
                {artifact?.text !== undefined ? 'Material text is available in the card' : 'Material file is not available yet'}
              </span>
            ) : match.state === 'stale' ? (
              <span className="agent-review-artifact-missing">The material version changed — a new card is expected</span>
            ) : (
              <span className="agent-review-artifact-missing">Material is still loading</span>
            )}
          </article>
        )
      })}
    </div>
  )
}
