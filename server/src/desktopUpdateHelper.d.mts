export interface DesktopUpdateHelperJob {
  [key: string]: unknown
}

export function applyUpdate(job: DesktopUpdateHelperJob, overrides?: Record<string, unknown>): Promise<{ rolledBack: boolean }>
export function copyManagedTree(sourceRoot: string, destinationRoot: string, managedPaths: readonly string[], protectedPaths: readonly string[]): Promise<number>
export function waitForProcessExit(pid: number, timeoutMs?: number): Promise<void>
export function run(jobFile: string): Promise<{ rolledBack: boolean }>
