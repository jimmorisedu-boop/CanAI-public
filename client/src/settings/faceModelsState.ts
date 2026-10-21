import type { FaceModelsResponse } from '../api'
import { t } from '../i18n/translate.js'

// Как объяснить словами состояние моделей сравнения лиц. Отдельно от
// компонента — чтобы формулировки и правило показа кнопки проверялись тестом,
// а не глазами в модалке. Тот же приём, что у компонента обработки видео.

export interface FaceModelsView {
  label: string
  tone: 'ok' | 'warn' | 'danger' | 'neutral'
  note: string | null
  /** Подпись кнопки; null — кнопки нет. */
  action: string | null
  busy: boolean
}

export function faceModelsView(state: FaceModelsResponse | null): FaceModelsView {
  if (!state) {
    return { label: t('Checking…'), tone: 'neutral', note: null, action: null, busy: true }
  }

  if (state.state === 'ready') {
    return {
      label: t('Ready'),
      tone: 'ok',
      // Про «наружу ничего не уходит» говорим прямо: речь о лицах живых людей,
      // и человек вправе знать, что считает его собственный компьютер.
      note: t('Models live in the app folder and travel with it. Comparison runs on this computer; images are not uploaded.'),
      action: null,
      busy: false,
    }
  }

  if (state.state === 'downloading') {
    return {
      label: `${state.percent ?? 0}%`,
      tone: 'neutral',
      note: t('Downloading models — about 38 MB. You can keep working.'),
      action: null,
      busy: true,
    }
  }

  if (state.state === 'failed') {
    return {
      label: t('Download failed'),
      tone: 'danger',
      note: state.message || t('Could not download models.'),
      action: t('Try again'),
      busy: false,
    }
  }

  return {
    label: t('Not installed'),
    tone: 'warn',
    note: t('Two models, about 38 MB. They power face similarity in comparison. Without them, comparison keeps its previous behavior.'),
    action: t('Download'),
    busy: false,
  }
}

/** Опрашивать состояние есть смысл только пока идёт закачка. */
export function shouldPollFaceModels(state: FaceModelsResponse | null): boolean {
  return state?.state === 'downloading'
}

/** Строка про лицензии: приложение продаётся, и видно, что в нём лежит. */
export function faceModelsLicenses(state: FaceModelsResponse | null): string | null {
  if (!state?.models?.length) return null
  return state.models.map((model) => `${model.name.replace(/\.onnx$/, '')} — ${model.license}`).join(', ')
}
