import { apiRequest } from '../api'
import type {
  DesktopUpdateApplyRequest,
  DesktopUpdatePrepareRequest,
  DesktopUpdateStatus,
} from '../../../packages/desktop-updates/protocol'

export interface DesktopUpdateTransport {
  status(signal?: AbortSignal): Promise<DesktopUpdateStatus>
  check(signal?: AbortSignal): Promise<DesktopUpdateStatus>
  prepare(input: DesktopUpdatePrepareRequest, signal?: AbortSignal): Promise<DesktopUpdateStatus>
  apply(input: DesktopUpdateApplyRequest, signal?: AbortSignal): Promise<DesktopUpdateStatus>
}

const jsonHeaders = { 'content-type': 'application/json' }

function post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  return apiRequest<T>(path, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  })
}

export const desktopUpdateTransport: DesktopUpdateTransport = {
  status: (signal) => apiRequest<DesktopUpdateStatus>('/api/desktop-updates', signal ? { signal } : undefined),
  check: (signal) => post<DesktopUpdateStatus>('/api/desktop-updates/check', {}, signal),
  prepare: (input, signal) => post<DesktopUpdateStatus>('/api/desktop-updates/prepare', input, signal),
  apply: (input, signal) => post<DesktopUpdateStatus>('/api/desktop-updates/apply', input, signal),
}
