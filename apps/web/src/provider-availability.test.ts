import type { ProviderStatus } from '@harness/contracts'
import { describe, expect, it } from 'vitest'
import { knownSignIn, providerCanRun } from './provider-availability.js'

const installed: ProviderStatus = {
  id: 'claude-code',
  displayName: 'Claude Code',
  installed: true,
  auth: 'unknown',
  capabilities: {
    steer: true,
    fork: false,
    interrupt: true,
    reasoningItems: true,
    approvals: true,
    images: true,
  },
}

describe('provider availability', () => {
  it('does not rule out a provider nothing has answered for', () => {
    expect(providerCanRun(undefined, undefined)).toBe(true)
    expect(providerCanRun(installed, undefined)).toBe(true)
    expect(knownSignIn(installed, undefined)).toBeUndefined()
  })

  it('rules out a provider that is not installed or declares nothing', () => {
    expect(providerCanRun({ ...installed, installed: false }, true)).toBe(false)
    const { capabilities: _, ...undeclared } = installed
    expect(providerCanRun(undeclared, true)).toBe(false)
  })

  it('rules out a provider whose last read said signed out', () => {
    expect(providerCanRun(installed, false)).toBe(false)
    expect(providerCanRun(installed, true)).toBe(true)
  })

  it('takes the install-time check when no read was kept, and a kept read over it', () => {
    expect(providerCanRun({ ...installed, auth: 'unauthenticated' }, undefined)).toBe(false)
    expect(providerCanRun({ ...installed, auth: 'authenticated' }, undefined)).toBe(true)
    expect(knownSignIn({ ...installed, auth: 'unauthenticated' }, true)).toBe(true)
    expect(knownSignIn({ ...installed, auth: 'authenticated' }, false)).toBe(false)
  })
})
