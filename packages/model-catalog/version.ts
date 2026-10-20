export const CATALOG_REVISION = '2026-09-21.1'
export const EXECUTOR_VERSION = 2
export const ADAPTER_VERSION = 2

export function executorCompatibilityError(model: { minExecutorVersion?: number } | null | undefined): string | null {
  return model && (model.minExecutorVersion ?? 1) > EXECUTOR_VERSION ? 'Update CanAI to use this model' : null
}
