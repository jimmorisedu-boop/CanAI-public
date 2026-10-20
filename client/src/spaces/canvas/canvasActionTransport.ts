import {
  api,
  type CanvasActionPreparationInput,
  type CanvasActionPreparationStart,
  type CanvasActionPreparationStatus,
} from '../../api'

export type {
  CanvasActionPreparationInput,
  CanvasActionPreparationStart,
  CanvasActionPreparationStatus,
} from '../../api'

/** Narrow transport boundary for the action dock. No UI state or launch logic belongs here. */
export interface CanvasActionTransportClient {
  prepareCanvasAction(input: CanvasActionPreparationInput): Promise<CanvasActionPreparationStart>
  getCanvasAction(id: string): Promise<CanvasActionPreparationStatus>
  cancelCanvasAction(id: string): Promise<{ ok: boolean; status?: string }>
}

export function createCanvasActionTransport(
  client: CanvasActionTransportClient = api,
): {
  prepare(input: CanvasActionPreparationInput): Promise<CanvasActionPreparationStart>
  status(id: string): Promise<CanvasActionPreparationStatus>
  cancel(id: string): Promise<{ ok: boolean; status?: string }>
} {
  return {
    prepare: (input) => client.prepareCanvasAction(input),
    status: (id) => client.getCanvasAction(id),
    cancel: (id) => client.cancelCanvasAction(id),
  }
}

export const canvasActionTransport = createCanvasActionTransport()

export const prepareCanvasAction = (input: CanvasActionPreparationInput) => (
  canvasActionTransport.prepare(input)
)

export const getCanvasAction = (id: string) => canvasActionTransport.status(id)

export const cancelCanvasAction = (id: string) => canvasActionTransport.cancel(id)
