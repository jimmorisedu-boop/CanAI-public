import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Keep the local rule document aligned with the profile instruction limit. */
export const ASSISTANT_RULES_MAX_CHARS = 24_000

export class AssistantRulesError extends Error {
  readonly code = 'ASSISTANT_RULES_INVALID'
}

function rulesFilePath(): string {
  const override = process.env.CANAI_ASSISTANT_RULES_FILE?.trim()
  if (override) return path.resolve(override)
  return fileURLToPath(new URL('./canvas-assistant.md', import.meta.url))
}

/**
 * Read the canonical assistant contract for every request.
 *
 * There is deliberately no module-level cache: editing the portable rules file
 * takes effect on the next estimate or delivery without restarting the server.
 */
export function readAssistantRules(): string {
  const file = rulesFilePath()
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (error) {
    const reason = error instanceof Error ? `: ${error.message}` : ''
    throw new AssistantRulesError(`Could not read assistant rules (${file})${reason}`)
  }
  const normalized = text.replace(/^\uFEFF/u, '')
  if (!normalized.trim()) {
    throw new AssistantRulesError(`Assistant rules file is empty (${file})`)
  }
  if (normalized.length > ASSISTANT_RULES_MAX_CHARS) {
    throw new AssistantRulesError(`Assistant rules file is too large (${file}); maximum ${ASSISTANT_RULES_MAX_CHARS} characters`)
  }
  return normalized
}
