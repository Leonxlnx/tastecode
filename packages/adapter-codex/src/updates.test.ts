import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runCli } from '@harness/proc/cli'
import { cliPath, latestBrewVersion, latestNpmVersion } from '@harness/proc/updates'
import { CODEX_UPDATES } from './updates.js'

vi.mock('@harness/proc/cli', () => ({ runCli: vi.fn() }))
vi.mock('@harness/proc/updates', () => ({
  cliPath: vi.fn(),
  latestBrewVersion: vi.fn(),
  latestNpmVersion: vi.fn(),
}))
beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(latestNpmVersion).mockResolvedValue('0.153.4')
  vi.mocked(latestBrewVersion).mockResolvedValue('0.153.3')
})

describe('Codex update source', () => {
  it('uses the native updater only when the installed binary advertises it', async () => {
    vi.mocked(cliPath).mockResolvedValue(path.join('local', 'standalone', 'codex'))
    vi.mocked(runCli)
      .mockResolvedValueOnce({ code: 0, stdout: 'Usage: codex update [OPTIONS]' })
      .mockResolvedValueOnce({ code: 2, stdout: '' })
    expect((await CODEX_UPDATES.check('0.152.0')).command).toBe('codex update')
    expect((await CODEX_UPDATES.check('0.100.0')).command).toBeUndefined()
    expect(runCli).toHaveBeenCalledWith('codex', ['update', '--help'])
  })

  it('keeps npm alpha installations on their release channel', async () => {
    vi.mocked(cliPath).mockResolvedValue(
      path.join('prefix', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'),
    )
    expect((await CODEX_UPDATES.check('0.154.0-alpha.1')).command).toBe(
      'npm install -g @openai/codex@alpha',
    )
    expect(latestNpmVersion).toHaveBeenCalledWith('@openai/codex', 'alpha')
    expect(runCli).not.toHaveBeenCalled()
  })

  it('updates the Homebrew cask through Homebrew', async () => {
    vi.mocked(cliPath).mockResolvedValue(
      path.join('prefix', 'Caskroom', 'codex', '0.152.0', 'codex'),
    )
    expect((await CODEX_UPDATES.check('0.152.0')).command).toBe('brew upgrade --cask codex')
    expect(latestBrewVersion).toHaveBeenCalledWith('codex')
    expect(latestNpmVersion).not.toHaveBeenCalled()
  })

  it.each([
    ['.pnpm', 'pnpm add -g'],
    ['.bun', 'bun add -g'],
    ['yarn', 'yarn global add'],
  ])('keeps %s installations in their package manager', async (manager, command) => {
    vi.mocked(cliPath).mockResolvedValue(
      path.join('prefix', manager, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'),
    )
    expect((await CODEX_UPDATES.check('0.152.0')).command).toBe(`${command} @openai/codex@latest`)
  })
})
