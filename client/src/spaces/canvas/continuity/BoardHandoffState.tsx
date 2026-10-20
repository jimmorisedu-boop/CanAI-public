import React from 'react'
import { OperationState } from '../../../ui/OperationState'
import type { BoardHolder } from '../../../types'
import { isSameDevice } from './deviceIdentity'

// Доску открыли на другом устройстве.
//
// Экран заменяется целиком намеренно: пока за рулём другое устройство, правки
// здесь никуда не сохранятся, и оставить холст живым значило бы дать человеку
// работать в пустоту. Одно действие, одна кнопка — «вернуть сюда».

/**
 * Заголовок карточки. Вторая вкладка того же браузера — это НЕ «другое
 * устройство»: сказать человеку «доска на устройстве Windows», когда он сидит
 * за этим самым Windows, значит заставить его искать несуществующий второй
 * компьютер.
 */
export function boardHandoffTitle(device: string, sameDevice: boolean): string {
  return sameDevice
    ? 'Board is open in another tab'
    : `The board is currently on device “${device}”`
}

export function boardHandoffDetail(holder: BoardHolder, now: number = Date.now()): string {
  const minutes = Math.floor(Math.max(0, now - holder.since) / 60_000)
  const when = minutes < 1
    ? 'just now'
    : minutes < 60
      ? `${minutes} min ago`
      : `${Math.floor(minutes / 60)} h ago`
  return `Opened ${when}. While the board is open there, edits here are not saved; this is a snapshot from the handoff.`
}

export function BoardHandoffState({
  holder,
  returning,
  onReturn,
}: {
  holder: BoardHolder
  returning: boolean
  onReturn(): void
}) {
  return (
    <OperationState
      tone="info"
      title={boardHandoffTitle(holder.device, isSameDevice(holder.clientId))}
      detail={boardHandoffDetail(holder)}
      action={{
        label: returning ? 'Returning…' : 'Return here',
        onClick: onReturn,
        disabled: returning,
      }}
    />
  )
}
