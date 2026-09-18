import { describe, expect, it, vi } from 'vitest'
import { latestNpmVersion } from '@harness/proc/updates'
import { OPENCODE_UPDATES } from './updates.js'

vi.mock('@harness/proc/updates', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@harness/proc/updates')>()),
  latestNpmVersion: vi.fn(),
}))

describe('OpenCode update source', () => {
  it('defers to the CLI upgrade command against the npm release', async () => {
    vi.mocked(latestNpmVersion).mockResolvedValue('1.2.3')
    expect(await OPENCODE_UPDATES.check('1.0.0')).toEqual({
      latestVersion: '1.2.3',
      command: 'opencode upgrade',
    })
    expect(latestNpmVersion).toHaveBeenCalledWith('opencode-ai')
  })
})
