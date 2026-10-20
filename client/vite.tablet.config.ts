import react from '@vitejs/plugin-react'
import fs from 'node:fs/promises'
import path from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import { ortRuntime } from './viteOrt'
import { buildDefine } from './viteBuildInfo'

function localManifest(outDir: string): Plugin {
  return {
    name: 'canai-tablet-manifest-local-mode',
    apply: 'build',
    async closeBundle() {
      const target = path.resolve(outDir, 'tablet.webmanifest')
      const raw = await fs.readFile(target, 'utf8')
      const manifest = JSON.parse(raw) as { start_url?: string; scope?: string; icons?: Array<{ src?: string }> }
      manifest.start_url = '/'
      manifest.scope = '/'
      for (const icon of manifest.icons ?? []) {
        if (icon.src === '/tablet/favicon.svg') icon.src = '/favicon.svg'
      }
      await fs.writeFile(target, `${JSON.stringify(manifest, null, 2)}\n`)
    },
  }
}

export default defineConfig({
  base: '/',
  define: {
    'crypto.subtle': 'undefined',
    ...buildDefine(),
  },
  plugins: [react(), ortRuntime(), localManifest('dist/tablet')],
  optimizeDeps: { exclude: ['onnxruntime-web'] },
  build: {
    outDir: 'dist/tablet',
    emptyOutDir: true,
    rollupOptions: { input: { tablet: 'tablet.html' } },
  },
})
