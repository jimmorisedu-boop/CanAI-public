import { Router } from 'express'
import {
  clearRemoteAccess,
  loadRemoteAccess,
  revokeRemoteSessions,
  setRemoteEnabled,
  setRemotePin,
} from './remoteAccess.js'
import { remoteServerState, startRemoteServer } from './remoteRuntime.js'

// Управление доступом с планшета — с КОМПЬЮТЕРА. Сам планшет свои права
// менять не может: эти ручки в белый список (remoteAllowlist) не входят.
export const remoteAccessRouter = Router()

async function currentState() {
  const state = await loadRemoteAccess()
  return {
    enabled: state.enabled,
    pinSet: Boolean(state.pin),
    devices: state.sessions.map((session) => ({
      device: session.device,
      createdAt: session.createdAt,
    })),
    server: remoteServerState(state.enabled),
  }
}

remoteAccessRouter.get('/remote-access', async (_req, res) => {
  try {
    res.json(await currentState())
  } catch {
    res.status(500).json({ error: 'Could not read access settings' })
  }
})

remoteAccessRouter.post('/remote-access/pin', async (req, res) => {
  const pin = (req.body ?? {}) as { pin?: unknown }
  if (typeof pin.pin !== 'string') {
    return res.status(400).json({ error: 'Code must contain 4–12 digits' })
  }
  try {
    await setRemotePin(pin.pin)
    res.json(await currentState())
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Could not set the access code' })
  }
})

remoteAccessRouter.post('/remote-access', async (req, res) => {
  const body = (req.body ?? {}) as { enabled?: unknown }
  if (typeof body.enabled !== 'boolean') {
    return res.status(400).json({ error: 'Invalid access state' })
  }
  try {
    await setRemoteEnabled(body.enabled)
    // Слушатель переезжает с loopback на все интерфейсы и обратно сразу:
    // просить человека перезапустить приложение ради галочки — плохой обмен.
    await startRemoteServer()
    res.json(await currentState())
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Could not change access settings' })
  }
})

remoteAccessRouter.post('/remote-access/revoke', async (_req, res) => {
  try {
    await revokeRemoteSessions()
    res.json(await currentState())
  } catch {
    res.status(500).json({ error: 'Could not disable devices' })
  }
})

remoteAccessRouter.delete('/remote-access', async (_req, res) => {
  try {
    await clearRemoteAccess()
    await startRemoteServer()
    res.json(await currentState())
  } catch {
    res.status(500).json({ error: 'Could not turn off access' })
  }
})
