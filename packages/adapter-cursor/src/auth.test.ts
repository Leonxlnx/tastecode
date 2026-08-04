import { describe, expect, it } from 'vitest'
import { isCursorSignedIn } from './auth.js'

describe('Cursor authentication', () => {
  it('does not mistake a negative status for a signed-in account', () => {
    expect(isCursorSignedIn('Not authenticated. Run cursor-agent login.')).toBe(false)
    expect(isCursorSignedIn('Authenticated as developer')).toBe(true)
  })
})
