import { afterEach, describe, expect, it, vi } from 'vitest'
import { cliVersion, isNewerVersion, latestBrewVersion, latestNpmVersion } from './updates.js'

afterEach(() => vi.unstubAllGlobals())

describe('CLI release versions', () => {
  it.each([
    ['codex-cli 0.9.0', '0.10.0', true],
    ['2.1.226 (Claude Code)', '2.1.263', true],
    ['v1.0.13', '1.0.13', false],
    ['1.1.0', '1.0.99', false],
    ['1.0.0-alpha.9', '1.0.0-alpha.10', true],
    ['1.0.0-alpha.10', '1.0.0-alpha.9', false],
    ['1.0.0-alpha.1', '1.0.0', true],
    ['1.0.0', '1.0.0-alpha.1', false],
    ['1.0.0+build', '1.0.0+new-build', false],
    ['unknown', '2.0.0', false],
    ['1.0.0', 'bad-release', false],
  ])('compares %s against %s', (current, latest, expected) => {
    expect(isNewerVersion(current, latest)).toBe(expected)
  })

  it('does not parse version-shaped command text', () => {
    expect(cliVersion('1.0.0; echo bad')).toBeUndefined()
  })

  it('uses a fixed release host and bounds the network check', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ version: '2.1.236' }))
    vi.stubGlobal('fetch', fetch)
    await expect(latestNpmVersion('@anthropic-ai/claude-code', 'stable')).resolves.toBe('2.1.236')
    expect(fetch).toHaveBeenCalledWith(
      'https://registry.npmjs.org/%40anthropic-ai%2Fclaude-code/stable',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
  })

  it('refuses failed and malformed release responses', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(Response.json({ version: '; bad' }))
    vi.stubGlobal('fetch', fetch)
    await expect(latestNpmVersion('@openai/codex')).rejects.toThrow('unavailable')
    await expect(latestNpmVersion('@openai/codex')).rejects.toThrow('invalid version')
  })

  it('uses the release actually available in Homebrew for a cask install', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ version: '0.153.3' }))
    vi.stubGlobal('fetch', fetch)
    await expect(latestBrewVersion('codex')).resolves.toBe('0.153.3')
    expect(fetch).toHaveBeenCalledWith(
      'https://formulae.brew.sh/api/cask/codex.json',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
  })
})
