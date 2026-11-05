import { commandOverride, setCommandOverride } from '@harness/proc/cli'
import { afterEach, describe, expect, it } from 'vitest'
import { Store } from './store.js'
import {
  restoreProviderExecutablePaths,
  updateProviderExecutablePath,
} from './provider-executable-paths.js'

afterEach(() => {
  setCommandOverride('codex')
  setCommandOverride('devin')
})

describe('provider executable paths', () => {
  it('validates before saving, restores at startup, and resets discovery', () => {
    const store = new Store(':memory:')
    try {
      expect(updateProviderExecutablePath(store, 'codex', process.execPath)).toEqual({
        codex: process.execPath,
      })
      expect(commandOverride('codex')).toBe(process.execPath)
      expect(() => updateProviderExecutablePath(store, 'codex', '/missing/no-such-file')).toThrow()
      expect(store.providerExecutablePaths()).toEqual({ codex: process.execPath })
      setCommandOverride('codex')
      restoreProviderExecutablePaths(store)
      expect(commandOverride('codex')).toBe(process.execPath)
      expect(updateProviderExecutablePath(store, 'codex', '')).toEqual({})
      expect(commandOverride('codex')).toBeUndefined()
    } finally {
      store.close()
    }
  })

  it('accepts known ACP agents and rejects API and custom sources', () => {
    const store = new Store(':memory:')
    try {
      updateProviderExecutablePath(store, 'acp:devin', process.execPath)
      expect(commandOverride('devin')).toBe(process.execPath)
      expect(() => updateProviderExecutablePath(store, 'api', process.execPath)).toThrow(/Unknown/)
      expect(() => updateProviderExecutablePath(store, 'acp:unknown', process.execPath)).toThrow(
        /Unknown/,
      )
    } finally {
      store.close()
    }
  })
})
