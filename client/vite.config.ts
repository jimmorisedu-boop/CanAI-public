import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { ortRuntime } from './viteOrt'
import { buildDefine } from './viteBuildInfo'

const apiTarget = process.env.CANAI_SERVER_URL ?? 'http://127.0.0.1:8787'

export default defineConfig({
  plugins: [react(), ortRuntime()],
  // Номер сборки вшивается в страницу (пункт 5.1, см. viteBuildInfo.ts).
  define: buildDefine(),
  optimizeDeps: { exclude: ['onnxruntime-web'] },
  server: {
    // host указан явно: на новых Node «localhost» биндится только на IPv6,
    // и браузер, идущий по IPv4, не может подключиться
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      // ⚠️ ws: true — иначе сокет сетевой доски (/api/cloud-board/socket) в
      // dev-режиме не проксируется, и доска команды вечно «грузится».
      '/api': { target: apiTarget, ws: true },
      '/media': apiTarget,
    },
  },
})
