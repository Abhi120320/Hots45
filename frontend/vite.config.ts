import { copyFileSync, mkdirSync } from 'node:fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Static hosts (Vercel) have no SPA fallback: put the app shell at each /view/<chart>/ deep link. Keep in sync with CHARTS in src/url.ts.
const viewPages = {
  name: 'view-pages',
  closeBundle() {
    for (const c of ['calendar', 'timeline', 'monthly', 'before-after']) {
      mkdirSync(`dist/view/${c}`, { recursive: true })
      copyFileSync('dist/index.html', `dist/view/${c}/index.html`)
    }
  },
}

export default defineConfig({
  plugins: [react(), tailwindcss(), viewPages],
  server: { proxy: { '/api': 'http://127.0.0.1:8000' } },
  build: { chunkSizeWarningLimit: 4000 },
})
