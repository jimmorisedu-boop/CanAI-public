
import { useT } from '../i18n/context.js'
export function BehaviorSettingsSection({
  optimiseLargeImages,
  shareLanAccess,
  confirmCostAboveUsd,
  tabletDailyGenerationLimit,
  tabletApproveDailyLimit,
  disabled,
  onOptimiseLargeImagesChange,
  onShareLanAccessChange,
  onConfirmCostChange,
  onTabletDailyLimitChange,
  onTabletApproveLimitChange,
}: {
  optimiseLargeImages: boolean
  shareLanAccess: boolean
  confirmCostAboveUsd: number
  tabletDailyGenerationLimit: number
  tabletApproveDailyLimit: number
  disabled: boolean
  onOptimiseLargeImagesChange(value: boolean): void
  onShareLanAccessChange(value: boolean): void
  onConfirmCostChange(value: number): void
  onTabletDailyLimitChange(value: number): void
  onTabletApproveLimitChange(value: number): void
}) {
  const t = useT()
  return (
    <section className="settings-section" aria-labelledby="behavior-settings-title">
      <div className="settings-section-heading">
        <div>
          <h3 id="behavior-settings-title">{t('Behavior')}</h3>
          <p>{t('Import, tablet limits, and spending confirmations.')}</p>
        </div>
      </div>
      <div className="settings-option-list">
        <label className="settings-checkbox">
          <input
            type="checkbox"
            checked={optimiseLargeImages}
            disabled={disabled}
            onChange={(event) => onOptimiseLargeImagesChange(event.target.checked)}
          />
          <span><b>{t('Optimize large images on import')}</b><small>{t('Downscales files larger than 5 MB to 2560 px. Off by default to preserve original quality.')}</small></span>
        </label>
      </div>
      <label className="settings-label" htmlFor="confirm-cost">{t('Confirm expensive generations over, $')}</label>
      <input
        id="confirm-cost"
        type="number"
        min={0}
        max={1000}
        step={0.1}
        value={confirmCostAboveUsd}
        disabled={disabled}
        onChange={(event) => onConfirmCostChange(Math.max(0, Number(event.target.value) || 0))}
      />
      <p className="settings-note">{t('0 — confirm every generation with a known price. Estimates are approximate.')}</p>
      <label className="settings-label" htmlFor="tablet-daily-limit">{t('Daily tablet generation limit')}</label>
      <input
        id="tablet-daily-limit"
        type="number"
        min={0}
        max={10000}
        step={1}
        value={tabletDailyGenerationLimit}
        disabled={disabled}
        onChange={(event) => onTabletDailyLimitChange(Math.max(0, Math.floor(Number(event.target.value) || 0)))}
      />
      <p className="settings-note">{t('How many generations a tablet can start per day over the local network. 0 — unlimited. Resets at local midnight. The tablet cannot change its own limit.')}</p>
      <label className="settings-label" htmlFor="tablet-approve-daily-limit">{t('Daily paid agent approval limit from tablet')}</label>
      <input
        id="tablet-approve-daily-limit"
        type="number"
        min={0}
        max={10000}
        step={1}
        value={tabletApproveDailyLimit}
        disabled={disabled}
        onChange={(event) => onTabletApproveLimitChange(Math.max(0, Math.floor(Number(event.target.value) || 0)))}
      />
      <p className="settings-note">{t('How many times per day a tablet can approve an agent decision backed by a paid generation. 0 — unlimited. Resets at local midnight. Once reached, spending is blocked until the next day. The tablet cannot change its own limit.')}</p>
    </section>
  )
}
