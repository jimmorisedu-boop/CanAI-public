import fs from 'node:fs/promises'
import path from 'node:path'
import { config } from './config.js'
import { FfmpegBinary, ffmpegPlatform, type FfmpegTools } from './ffmpegBinary.js'

// Один экземпляр на приложение. Живёт в runtime/media-tools/ вместе с yt-dlp
// и gallery-dl — не только ради порядка: yt-dlp ищет ffmpeg рядом с собой, и
// от такого соседства склейка потоков у медиассылок начинает работать сама.

export interface FfmpegSearchPlan {
  directories: string[]
  names: { ffmpeg: string; ffprobe: string }
}

/** Где и что искать. Отдельно от файловой системы — иначе разбор PATH
 *  нельзя проверить: у windows-путей внутри есть двоеточие, и тест на
 *  linux-разделитель на windows-машине проверял бы сам себя. */
export function ffmpegSearchPlan(
  pathValue: string | undefined,
  platform: NodeJS.Platform,
): FfmpegSearchPlan {
  const names = ffmpegPlatform(platform, process.arch)?.binaries
    ?? (platform === 'win32' ? { ffmpeg: 'ffmpeg.exe', ffprobe: 'ffprobe.exe' } : { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' })
  const separator = platform === 'win32' ? ';' : ':'
  return {
    names,
    directories: (pathValue ?? '')
      .split(separator)
      .map((entry) => entry.trim().replace(/^"|"$/g, ''))
      .filter(Boolean),
  }
}

/** Ищем ffmpeg и ffprobe в PATH. Нужны ОБА: одного мало (см. locate). */
export async function systemFfmpegTools(
  pathValue: string | undefined = process.env.PATH,
  platform: NodeJS.Platform = process.platform,
): Promise<FfmpegTools | null> {
  const { directories, names } = ffmpegSearchPlan(pathValue, platform)

  for (const directory of directories) {
    const candidate: FfmpegTools = {
      ffmpeg: path.join(directory, names.ffmpeg),
      ffprobe: path.join(directory, names.ffprobe),
    }
    const [hasFfmpeg, hasFfprobe] = await Promise.all([
      fs.access(candidate.ffmpeg).then(() => true, () => false),
      fs.access(candidate.ffprobe).then(() => true, () => false),
    ])
    if (hasFfmpeg && hasFfprobe) return candidate
  }
  return null
}

export const ffmpegBinary = new FfmpegBinary({
  runtimeDir: config.mediaToolsDir,
  systemTools: () => systemFfmpegTools(),
})

/** Инструменты для операции. Сама операция НЕ качает: закачка в 40 МБ должна
 *  быть видимым действием пользователя, а не сюрпризом посреди правки. */
export async function requireFfmpeg(): Promise<FfmpegTools> {
  const tools = await ffmpegBinary.locate()
  if (!tools) {
    throw new Error('Video processing component is not installed; download it in Settings')
  }
  return tools
}
