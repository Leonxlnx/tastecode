import { readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { claudeLimitSource } from './limits.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Claude Code subscription limits', () => {
  it('reports unavailable without touching the network', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)

    await expect(claudeLimitSource()).resolves.toEqual({ status: 'unavailable' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('keeps provider-owned credentials and private OAuth APIs out of production sources', async () => {
    const sourceDir = dirname(fileURLToPath(import.meta.url))
    const names = (await readdir(sourceDir)).filter(
      (name) => name.endsWith('.ts') && !name.endsWith('.test.ts'),
    )
    const productionSource = (
      await Promise.all(names.map((name) => readFile(join(sourceDir, name), 'utf8')))
    ).join('\n')
    const forbidden = [
      '.creden' + 'tials.json',
      '/api/oauth/' + 'usage',
      '/v1/oauth/' + 'token',
      'refresh_' + 'token',
      'client_' + 'id',
      'claude-code/' + '2.',
    ]

    for (const marker of forbidden) expect(productionSource).not.toContain(marker)
  })
})
