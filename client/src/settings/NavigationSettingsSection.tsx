import React from 'react'
import type { NavigationMode } from './navigationMode'
import { IconMouse, IconTouchpad } from '../ui/icons'
import { useT } from '../i18n/context.js'


export function NavigationSettingsSection({
  mode,
  disabled,
  onChange,
}: {
  mode: NavigationMode
  disabled: boolean
  onChange: (mode: NavigationMode) => void
}) {
  const t = useT()
  return (
    <section className="settings-section settings-navigation" aria-labelledby="navigation-settings-title">
      <div className="settings-section-heading">
        <div>
          <h3 id="navigation-settings-title">{t('Navigation')}</h3>
          <p>{t('Choose the device you use to move around the canvas and zoom.')}</p>
        </div>
      </div>
      <fieldset className="settings-segmented" disabled={disabled}>
        <legend className="settings-visually-hidden">{t('Navigation device')}</legend>
        <label>
          <input
            type="radio"
            name="navigation-mode"
            value="mouse"
            checked={mode === 'mouse'}
            onChange={() => onChange('mouse')}
          />
          <span><IconMouse aria-hidden="true" />{t('Mouse')}</span>
        </label>
        <label>
          <input
            type="radio"
            name="navigation-mode"
            value="touchpad"
            checked={mode === 'touchpad'}
            onChange={() => onChange('touchpad')}
          />
          <span><IconTouchpad aria-hidden="true" />{t('Touchpad')}</span>
        </label>
      </fieldset>
      <p className="settings-note">
        {mode === 'touchpad'
          ? t('Two fingers pan the canvas; pinch to zoom.')
          : t('The wheel zooms; the middle button or Space + drag pans the canvas.')}
      </p>
    </section>
  )
}
