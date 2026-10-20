import type { SelectionRef } from './konva/selection'

export interface GenerationComposerRequest {
  prompt: string
  refs: SelectionRef[]
}

export interface GenerationComposerHandler {
  fill(request: GenerationComposerRequest): void
  generate(request: GenerationComposerRequest): Promise<void>
}

let handler: GenerationComposerHandler | null = null

export function registerGenerationComposer(
  next: GenerationComposerHandler | null,
): () => void {
  handler = next
  return () => {
    if (handler === next) handler = null
  }
}

export function requestGenerationComposerFill(
  request: GenerationComposerRequest,
): boolean {
  if (!handler) return false
  handler.fill(request)
  return true
}

export async function requestGenerationComposerGenerate(
  request: GenerationComposerRequest,
): Promise<boolean> {
  if (!handler) return false
  await handler.generate(request)
  return true
}
