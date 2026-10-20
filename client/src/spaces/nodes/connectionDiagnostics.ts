import type { PortType } from './ports'

const SOURCE_NAMES: Record<PortType, string> = {
  text: 'Text',
  image: 'Image',
  video: 'Video',
  audio: 'Audio',
  media: 'Media',
  multimedia: 'Multimedia',
}

const TARGET_NAMES: Record<PortType, string> = {
  text: 'text input',
  image: 'image input',
  video: 'video input',
  audio: 'audio input',
  media: 'media input',
  multimedia: 'multimedia input',
}

export function connectionMismatchMessage(
  sourceType: PortType | null,
  targetType: PortType | null,
): string {
  if (sourceType == null || targetType == null) return 'Port no longer exists'
  const preposition = 'to'
  return `${SOURCE_NAMES[sourceType]} cannot connect ${preposition} ${TARGET_NAMES[targetType]}`
}

export function selfLoopMessage(): string {
  return 'A node cannot connect to itself'
}

export function connectionErrorAfterAttempt(
  current: string | null,
  connected: boolean,
): string | null {
  return connected ? null : current
}
