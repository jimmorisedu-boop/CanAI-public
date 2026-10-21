import React, { useEffect, useState } from 'react'
import { api } from '../api'
import type { RemoteAccessInfo } from '../types'
import { copyText } from '../ui/ids'
import { systemErrorMessage } from '../ui/systemMessage'
import { useT } from '../i18n/context.js'


// Одна строка для PowerShell: разрешить входящие ровно на планшетный порт.
// Не «выключить брандмауэр» — выключать его целиком ради одной программы
// значит открыть машину всей сети.
const FIREWALL_RULE =
  'New-NetFirewallRule -DisplayName "CanAI tablet" -Direction Inbound -Protocol TCP -LocalPort 8789 -Action Allow'

// Доступ с планшета — единственное место, где он включается.
//
// Сам планшет своих прав менять не может: эти ручки не входят в белый список
// (server/src/remoteAllowlist.ts). Так и должно быть — иначе устройство,
// стоящее в сети, могло бы расширить себе доступ само.

// ⚠️ Адресов бывает несколько, и первый не обязательно тот.
//
// С поднятым VPN у компьютера появляется ещё один приватный адрес (обычно
// 10.x от туннеля), и он вполне может оказаться первым в списке — а планшет
// по нему не достучится. Показываем ВСЕ: человек попробует второй за пять
// секунд, а гадать, почему «адрес не открывается», будет полчаса.
function addressLines(info: RemoteAccessInfo): Array<{ url: string; name?: string; virtual?: boolean }> {
  const links = info.server.links
  if (links && links.length > 0) return links
  return info.server.addresses.map((url) => ({ url }))
}

export function RemoteAccessSection() {
  const t = useT()
  const [info, setInfo] = useState<RemoteAccessInfo | null>(null)
  const [pin, setPin] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = () => {
    api.remoteAccess().then(setInfo).catch(() => setInfo(null))
  }
  useEffect(load, [])


  const run = async (action: () => Promise<RemoteAccessInfo>) => {
    setBusy(true)
    setError(null)
    try {
      setInfo(await action())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not complete action')
    } finally {
      setBusy(false)
    }
  }

  const addresses = info ? addressLines(info) : []

  return (
    <section className="settings-section" aria-labelledby="remote-settings-title">
      <div className="settings-section-heading">
        <div>
          <h3 id="remote-settings-title">{t('Tablet on my network')}</h3>
          <p>{t('Opens your boards on a tablet on the same network: view them, start generations, and continue work started here. The fal key, Settings, and external editor are unavailable on the tablet.')}</p>
        </div>
        <span
          className="settings-connection"
          data-tone={info?.enabled ? 'ok' : 'idle'}
          role="status"
        >
          {info?.enabled ? t('on') : t('off')}
        </span>
      </div>

      <label className="settings-label" htmlFor="remote-pin">
        {info?.pinSet ? t('New access code') : t('Access code (4–12 digits)')}
      </label>
      <div className="settings-key-row">
        <input
          id="remote-pin"
          inputMode="numeric"
          autoComplete="off"
          value={pin}
          placeholder={info?.pinSet ? t('Set — enter a new one to replace it') : t('For example, 4821')}
          disabled={busy}
          onChange={(event) => setPin(event.target.value.replace(/\D/g, '').slice(0, 12))}
        />
        <button
          type="button"
          className="ui-btn"
          disabled={busy || pin.length < 4}
          onClick={() => void run(async () => {
            const next = await api.setRemotePin(pin)
            setPin('')
            return next
          })}
        >

          {t('Save code')}
        </button>
      </div>

      <div className="settings-key-row">
        <button
          type="button"
          className="ui-btn"
          disabled={busy || !info?.pinSet}
          onClick={() => void run(() => api.setRemoteEnabled(!info?.enabled))}
        >
          {info?.enabled ? t('Turn off access') : t('Turn on access')}
        </button>
        {info && info.devices.length > 0 && (
          <button type="button" className="ui-btn" disabled={busy} onClick={() => void run(() => api.revokeRemoteDevices())}>
            {t('Disconnect devices ({0})', { 0: info.devices.length })}
          </button>
        )}
      </div>

      {error && <p className="settings-note" role="alert">{systemErrorMessage(error, 'Could not complete action')}</p>}

      {info?.enabled && (
        addresses.length > 0 ? (
          <div className="settings-note">
            <p>
              {t('On the tablet, open {0} and enter the code. Then choose “Share” → “Add to Home Screen” to add the app icon.', { 0: addresses.length > 1 ? t('one of the addresses') : t('the address') })}
            </p>
            <ul className="settings-address-list">
              {addresses.map((entry) => (
                <li key={entry.url}>
                  <code>{entry.url}</code>
                  {entry.name && <span className="settings-address-name">{entry.name}</span>}
                </li>
              ))}
            </ul>
            {info.server.platform === 'win32' && (
              // ⚠️ На Windows входящие подключения по умолчанию режет
              // брандмауэр, и выглядит это как «планшет не открывает адрес»:
              // на самом компьютере страница работает, а снаружи её нет.
              // Живой случай: планшет и компьютер в одной сети, адрес верный,
              // Safari отвечает «нет соединения». Сказать надо ЗАРАНЕЕ —
              // человек ищет причину в планшете, которой там нет.
              <div className="settings-firewall-note">
                <p>
                  <strong>{t('Can’t open the address on the tablet?')}</strong> {t('Windows Firewall probably blocks incoming connections. Open PowerShell as administrator and run this one line; it allows only this port:')}
                </p>
                <code className="settings-firewall-cmd">{FIREWALL_RULE}</code>
                <button
                  type="button"
                  className="ui-btn quiet"
                  onClick={() => { void copyText(FIREWALL_RULE) }}
                >

                  {t('Copy command')}
                </button>
              </div>
            )}
            {addresses.length > 1 && (
              <p>
                {t('There are several addresses because the computer has several network connections. Use the one for your Wi-Fi; the tablet cannot reach virtual adapters or tunnels. The first is most likely; try the next if it does not open.')}
              </p>
            )}
          </div>
        ) : (
          <p className="settings-note">{t('No local network address found. Check that this computer is connected to Wi-Fi.')}</p>
        )
      )}
      {info && !info.enabled && info.pinSet && (
        <p className="settings-note">{t('Code set. Turn on access when the tablet is on the same network.')}</p>
      )}
      {info?.server.error && <p className="settings-note" role="alert">{systemErrorMessage(info.server.error, 'The local server reported an error')}</p>}
    </section>
  )
}
