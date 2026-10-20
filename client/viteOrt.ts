import fs from 'node:fs'
import path from 'node:path'
import type { Plugin } from 'vite'

// Движок сравнения лиц (onnxruntime-web) подгружает свой .mjs динамическим
// импортом. Файлы берём прямо из node_modules и кладём в сборку сами —
// держать 13 МБ двоичного кода в git незачем, а в дистрибутиве он нужен.
//
// ⚠️ В разработке отдаём их сами: dev-сервер Vite дописывает такому импорту
// «?import» и отвечает 500, из-за чего движок не поднимается вовсе. В проде
// статику раздаёт express, и запрос ему не мешает.
//
// Плагин ОБЩИЙ для приложения и планшета: на планшете сравнение лиц тоже
// работает, и без этого файла (плюс `optimizeDeps.exclude`) сборщик втягивает
// 13 МБ wasm прямо в чанк планшетной страницы — то есть в память вкладки,
// ради экономии которой планшетная сборка и заведена.
const ORT_DIST = path.join(process.cwd(), 'node_modules', 'onnxruntime-web', 'dist')
const ORT_FILES = ['ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.mjs']

export function ortRuntime(): Plugin {
  return {
    name: 'canai-ort-runtime',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const pathname = (req.url ?? '').split('?')[0]
        if (!pathname.startsWith('/ort/')) return next()
        const file = path.join(ORT_DIST, path.basename(pathname))
        if (!ORT_FILES.includes(path.basename(pathname)) || !fs.existsSync(file)) return next()
        res.setHeader('Content-Type', pathname.endsWith('.wasm') ? 'application/wasm' : 'text/javascript')
        fs.createReadStream(file).pipe(res)
      })
    },
    generateBundle() {
      for (const name of ORT_FILES) {
        this.emitFile({
          type: 'asset',
          fileName: `ort/${name}`,
          source: fs.readFileSync(path.join(ORT_DIST, name)),
        })
      }
    },
  }
}
