import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
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

// MIT/BSD/Apache licences require their notices to travel with the shipped code: write every production
// dependency's licence text (transitively) to dist/third-party-licenses.txt, served at /third-party-licenses.txt.
const licenses = {
  name: 'third-party-licenses',
  apply: 'build' as const,
  closeBundle() {
    const seen = new Map<string, string>()
    const find = (name: string, from: string): string | null => {
      for (let d = from; ; d = dirname(d)) {
        const c = join(d, 'node_modules', name)
        if (existsSync(join(c, 'package.json'))) return c
        if (dirname(d) === d) return null
      }
    }
    const walk = (dir: string) => {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
      const key = `${pkg.name}@${pkg.version}`
      if (seen.has(key)) return
      const files = readdirSync(dir).filter(f => /^(licen[cs]e|copying|notice)/i.test(f) && statSync(join(dir, f)).isFile()) // Apache-2.0 needs NOTICE too
      const lic = typeof pkg.license === 'string' ? pkg.license : JSON.stringify(pkg.license ?? pkg.licenses ?? 'UNKNOWN')
      seen.set(key, `${key}  (${lic})\n${files.length ? files.map(f => readFileSync(join(dir, f), 'utf8').trim()).join('\n\n') : '(no licence file in package)'}`)
      for (const dep of Object.keys(pkg.dependencies ?? {})) { const d = find(dep, dir); if (d) walk(d) }
    }
    for (const dep of Object.keys(JSON.parse(readFileSync('package.json', 'utf8')).dependencies)) { const d = find(dep, process.cwd()); if (d) walk(d) }
    const body = [...seen.keys()].sort().map(k => seen.get(k)).join('\n\n' + '-'.repeat(78) + '\n\n')
    writeFileSync('dist/third-party-licenses.txt', `Hots45 third-party software notices (${seen.size} packages shipped in the web app)\n\n${body}\n`)
  },
}

export default defineConfig({
  plugins: [react(), tailwindcss(), viewPages, licenses],
  server: { proxy: { '/api': 'http://127.0.0.1:8000' } },
  build: { chunkSizeWarningLimit: 4000 },
})
