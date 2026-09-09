import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cliPath, latestBrewVersion, latestNpmVersion } from '@harness/proc/updates'
import { CLAUDE_UPDATES } from './updates.js'

vi.mock('node:fs/promises', () => ({ readFile: vi.fn() }))
vi.mock('@harness/proc/updates', () => ({
  cliPath: vi.fn(),
  latestBrewVersion: vi.fn(),
  latestNpmVersion: vi.fn(),
}))
beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(latestNpmVersion).mockResolvedValue('2.1.263')
  vi.mocked(latestBrewVersion).mockResolvedValue('2.1.236')
  vi.mocked(cliPath).mockResolvedValue(path.join('local', 'share', 'claude', 'versions', '2.1.226'))
  vi.mocked(readFile).mockResolvedValue('{}')
})

describe('Claude Code update source', () => {
  it('uses the configured stable channel without changing the preference', async () => {
    vi.mocked(readFile).mockResolvedValue('{"autoUpdatesChannel":"stable"}')
    expect((await CLAUDE_UPDATES.check('2.1.226')).command).toBe('claude update')
    expect(latestNpmVersion).toHaveBeenCalledWith('@anthropic-ai/claude-code', 'stable')
  })

  it('uses the latest channel when settings have not been created', async () => {
    vi.mocked(readFile).mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }))
    await CLAUDE_UPDATES.check('2.1.226')
    expect(latestNpmVersion).toHaveBeenCalledWith('@anthropic-ai/claude-code', 'latest')
  })

  it.each(['claude-code', 'claude-code@latest'])('keeps %s in Homebrew', async (cask) => {
    vi.mocked(cliPath).mockResolvedValue(path.join('prefix', 'Caskroom', cask, '2.1.226', 'claude'))
    expect((await CLAUDE_UPDATES.check('2.1.226')).command).toBe(`brew upgrade --cask ${cask}`)
    expect(latestBrewVersion).toHaveBeenCalledWith(cask)
    expect(latestNpmVersion).not.toHaveBeenCalled()
    expect(readFile).not.toHaveBeenCalled()
  })

  it('does not assume an unknown launcher can update itself', async () => {
    vi.mocked(cliPath).mockResolvedValue(path.join('custom', 'claude'))
    expect((await CLAUDE_UPDATES.check('2.1.226')).command).toBeUndefined()
  })
})
