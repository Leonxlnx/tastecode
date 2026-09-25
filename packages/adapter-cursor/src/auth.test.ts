import { describe, expect, it } from 'vitest'
import { cursorLoginStatus, isCursorSignedIn } from './auth.js'

describe('Cursor authentication', () => {
  it('does not mistake a negative status for a signed-in account', () => {
    expect(isCursorSignedIn('Not authenticated. Run cursor-agent login.')).toBe(false)
    expect(isCursorSignedIn('Authenticated as developer')).toBe(true)
  })

  it('maps cursor-agent status onto the shared login states', async () => {
    await expect(
      cursorLoginStatus(async () => ({ code: 0, stdout: 'Authenticated as developer\n' })),
    ).resolves.toBe('authenticated')
    await expect(
      cursorLoginStatus(async () => ({ code: 1, stdout: 'Not logged in\n' })),
    ).resolves.toBe('unauthenticated')
    await expect(
      cursorLoginStatus(() => Promise.reject(new Error('cursor-agent is not installed'))),
    ).resolves.toBe('unknown')
  })
})
