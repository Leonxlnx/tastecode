import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { GROK_ACCOUNT_HOME, grokAccountEnvironment } from './account-home.js'

describe('Grok account folders', () => {
  it('finds the default folder where the CLI looks for it', () => {
    expect(GROK_ACCOUNT_HOME.defaultHome({})).toBe(path.join(os.homedir(), '.grok'))
    expect(GROK_ACCOUNT_HOME.defaultHome({ GROK_HOME: '/srv/grok' })).toBe('/srv/grok')
  })

  it("points a further account's processes at its folder, and the default at none", () => {
    expect(grokAccountEnvironment('/data/accounts/grok/work')).toEqual({
      GROK_HOME: '/data/accounts/grok/work',
    })
    expect(grokAccountEnvironment(undefined)).toEqual({})
    // A new folder starts empty: the default config.toml can hold an API key.
    expect(GROK_ACCOUNT_HOME.seedFiles).toEqual([])
  })
})
