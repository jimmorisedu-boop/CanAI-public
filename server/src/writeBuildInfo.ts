import fs from 'node:fs'
import path from 'node:path'
import { BUILD_INFO_FILE, readBuildInfo } from './buildInfo.js'

/**
 * Номер сборки файлом — в папку поставки (пункт 5.1).
 *
 * У покупателя папки `.git` нет, и без этого файла и сервер, и сборщик
 * страницы честно сказали бы «сборка неизвестна» — а разбор жалобы начинается
 * ровно с вопроса, какая у человека версия. Зовут make-dist.ps1 и
 * make-dist.sh: `npm --prefix server run build-info -- <папка поставки>`.
 * Правило чтения одно с сервером — `readBuildInfo`.
 */

const out = process.argv[2]
if (!out || !fs.existsSync(out)) {
  console.error('[dist] provide an existing distribution folder')
  process.exit(2)
}
const info = readBuildInfo()
if (!info.commit) {
  console.error('[dist] build number unknown: git unavailable')
  process.exit(1)
}
if (info.dirty) {
  console.warn('[dist] WARNING: folder has uncommitted changes; the build number does not describe them')
}
fs.writeFileSync(path.join(out, BUILD_INFO_FILE), `${JSON.stringify({ commit: info.commit, date: info.date })}\n`)
console.log(`[dist] build ${info.commit}`)
