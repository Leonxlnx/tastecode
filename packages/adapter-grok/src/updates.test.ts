import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runCli } from '@harness/proc/cli'
import { GROK_UPDATES } from './updates.js'

vi.mock('@harness/proc/cli', () => ({ runCli: vi.fn() }))
beforeEach(() => vi.resetAllMocks())

describe('Grok update source', () => {
  it('reads the installed CLI update response without installing or changing channels', async () => {
    vi.mocked(runCli).mockResolvedValue({
      code: 0,
      stdout:
        '{"currentVersion":"1.0.13","latestVersion":"1.0.13","updateAvailable":false,"installer":"internal","channel":"stable","autoUpdate":true,"error":null}',
    })
    expect(await GROK_UPDATES.check('1.0.13')).toEqual({
      latestVersion: '1.0.13',
      command: 'grok update',
    })
    expect(runCli).toHaveBeenCalledWith('grok', ['update', '--check', '--json'], 10_000)
  })

  it('rejects failed checks and errors embedded in a successful response', async () => {
    vi.mocked(runCli)
      .mockResolvedValueOnce({ code: 1, stdout: '' })
      .mockResolvedValueOnce({ code: 0, stdout: '{"latestVersion":"1.1.0","error":"offline"}' })
    await expect(GROK_UPDATES.check('1.0.13')).rejects.toThrow('Could not check')
    await expect(GROK_UPDATES.check('1.0.13')).rejects.toThrow('did not return')
  })
})
