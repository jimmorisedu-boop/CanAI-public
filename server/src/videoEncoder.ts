// Выбор кодировщика для операций, которые нельзя сделать копированием потока
// (кроп меняет каждый кадр). Порядок не случаен и не про «побыстрее»:
//
// 1. Аппаратные NVENC / QSV / AMF — их считает видеокарта, они быстрые и, что
//    важнее для проданного приложения, лицензией GPL не заражены.
// 2. libopenh264 — программный, от Cisco, под BSD. Медленнее, но есть в нашей
//    LGPL-сборке и работает на машине без видеокарты.
//
// x264 в списке нет намеренно: он GPL, и его нет в сборке, которую мы кладём
// покупателю (см. ffmpegBinary).

// h264_videotoolbox стоит первым осознанно: на маке это единственный
// аппаратный кодировщик, и он есть на КАЖДОЙ машине. На Windows его в сборке
// нет вовсе, ffmpeg не покажет его в списке -encoders, и выбор пойдёт как
// раньше — с h264_nvenc.
export const ENCODER_PREFERENCE = ['h264_videotoolbox', 'h264_nvenc', 'h264_qsv', 'h264_amf', 'libopenh264'] as const

export type VideoEncoder = (typeof ENCODER_PREFERENCE)[number]

/** Имена кодировщиков из вывода `ffmpeg -encoders`. */
export function parseEncoders(text: string): Set<string> {
  const found = new Set<string>()
  for (const line of text.split('\n')) {
    // Строка вида « V....D h264_nvenc           NVIDIA NVENC H.264 encoder»
    const match = /^\s*[VASFXBD.]{6}\s+(\S+)/.exec(line)
    if (match) found.add(match[1])
  }
  return found
}

export function pickEncoder(available: ReadonlySet<string>): VideoEncoder | null {
  for (const name of ENCODER_PREFERENCE) {
    if (available.has(name)) return name
  }
  return null
}

/** Аргументы качества для выбранного кодировщика.
 *
 * У аппаратных и программного кодировщиков ручки называются по-разному, и
 * общего «качества» у них нет: cq у NVENC, global_quality у QSV, qp у AMF,
 * обычный q у libopenh264. Значения подобраны так, чтобы результат визуально
 * не отличался от исходника — кроп не повод терять качество.
 *
 * ⚠️ У VideoToolbox шкала ПЕРЕВЁРНУТАЯ: 1..100, где БОЛЬШЕ значит лучше. У
 * остальных наоборот — меньше число, выше качество. Поэтому общий запасной
 * `-q 20` (он для libopenh264) на маке означал бы не «почти без потерь», а
 * сильное ухудшение: замер на клипе 1280×720 дал SSIM 0.967 против 0.9986
 * при 65, и файл усыхал в пять раз. Значение 65 подобрано замером: результат
 * неотличим на глаз и при этом ЛЕГЧЕ исходника (2.43 МБ против 2.68 МБ). */
export function encoderArgs(encoder: VideoEncoder): string[] {
  if (encoder === 'h264_videotoolbox') return ['-q:v', '65']
  if (encoder === 'h264_nvenc') return ['-preset', 'p5', '-rc', 'vbr', '-cq', '20', '-b:v', '0']
  if (encoder === 'h264_qsv') return ['-global_quality', '20']
  if (encoder === 'h264_amf') return ['-quality', 'quality', '-rc', 'cqp', '-qp_i', '20', '-qp_p', '20']
  return ['-q', '20']
}

/** Кроп в долях кадра → пиксели ffmpeg.
 *
 * Размеры округляются до ЧЁТНЫХ: у H.264 цветность прорежена вдвое, и кадр с
 * нечётной стороной кодировщик либо не примет, либо молча подгонит сам —
 * лучше решить это здесь, чем ловить расхождение в результате. */
export function cropFilter(
  crop: { x: number; y: number; w: number; h: number },
  size: { width: number; height: number },
): string | null {
  const rawW = crop.w * size.width
  const rawH = crop.h * size.height
  // Проверяем ДО округления: иначе схлопнутая в точку рамка превращалась бы в
  // честный на вид кадр 2×2 вместо отказа, и человек получал бы пиксель.
  if (!(rawW >= 2) || !(rawH >= 2)) return null
  if (crop.x < 0 || crop.y < 0 || crop.x + crop.w > 1.001 || crop.y + crop.h > 1.001) return null

  const even = (value: number) => Math.round(value / 2) * 2
  const w = Math.min(size.width, Math.max(2, even(rawW)))
  const h = Math.min(size.height, Math.max(2, even(rawH)))
  const x = Math.max(0, Math.min(size.width - w, Math.round(crop.x * size.width)))
  const y = Math.max(0, Math.min(size.height - h, Math.round(crop.y * size.height)))
  return `crop=${w}:${h}:${x}:${y}`
}
