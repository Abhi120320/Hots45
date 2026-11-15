import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'

// Browser dialogs block the page and look unprofessional; use inline UI instead.
it('frontend never calls window.prompt / alert / confirm', () => {
  const dir = join(__dirname)
  const offenders = readdirSync(dir).filter(f => /\.(ts|tsx)$/.test(f) && !f.endsWith('.test.ts'))
    .filter(f => /(^|[^\w.])(window\.)?(prompt|alert|confirm)\s*\(/.test(readFileSync(join(dir, f), 'utf8')))
  expect(offenders).toEqual([])
})
