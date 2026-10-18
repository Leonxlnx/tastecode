import { describe, expect, it } from 'vitest'
import { accountRead } from './account-identity.js'

describe('accountRead', () => {
  const named = { signedIn: true, email: 'first@example.test', plan: 'pro' }

  it('takes the first read as it is', () => {
    expect(accountRead(undefined, named)).toEqual({ identity: named, switched: false })
  })

  it('counts a sign-in change, another email or another plan as a switch', () => {
    expect(accountRead(named, { signedIn: false })).toEqual({
      identity: { signedIn: false },
      switched: true,
    })
    expect(accountRead({ signedIn: false }, named).switched).toBe(true)
    expect(accountRead(named, { ...named, email: 'second@example.test' }).switched).toBe(true)
    expect(accountRead(named, { ...named, plan: 'max' }).switched).toBe(true)
  })

  it('keeps the details a read leaves out', () => {
    expect(accountRead(named, { signedIn: true })).toEqual({ identity: named, switched: false })
    expect(accountRead(named, { signedIn: true, plan: 'pro' })).toEqual({
      identity: named,
      switched: false,
    })
    // A detail named for the first time adds to the identity.
    expect(accountRead({ signedIn: true }, named)).toEqual({ identity: named, switched: false })
  })

  it('compares a later read with the details kept from before', () => {
    const { identity } = accountRead(named, { signedIn: true })
    expect(accountRead(identity, { signedIn: true, email: 'second@example.test' })).toEqual({
      identity: { signedIn: true, email: 'second@example.test' },
      switched: true,
    })
  })
})
