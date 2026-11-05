import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { commandOverride, setCommandOverride } from '@harness/proc/cli'
import { afterEach, describe, expect, it } from 'vitest'
import { Store } from './store.js'
import {
  restoreProviderExecutablePaths,
  selectedProviderShellCommand,
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

  it.runIf(process.platform !== 'win32')(
    'quotes a selected path in terminal commands without interpreting shell characters',
    () => {
      const directory = mkdtempSync(path.join(os.tmpdir(), 'provider shell '))
      const executable = path.join(directory, "cli '$(touch injected)")
      try {
        writeFileSync(
          executable,
          `#!${process.execPath}\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)))\n`,
          { mode: 0o755 },
        )
        setCommandOverride('codex', executable)
        const command = selectedProviderShellCommand('codex', 'codex login')
        expect(execFileSync('/bin/sh', ['-c', command], { cwd: directory, encoding: 'utf8' })).toBe(
          '["login"]',
        )
        expect(() => selectedProviderShellCommand('codex', 'npm install -g codex')).toThrow(
          /installation instructions/,
        )
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    },
  )

  it('escapes a selected path for the Windows terminal shell', () => {
    const platform = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32' })
    try {
      setCommandOverride('codex', 'C:\\Program Files\\Tools & Co\\codex.cmd')
      expect(selectedProviderShellCommand('codex', 'codex login')).toBe(
        '"C:\\Program^ Files\\Tools^ ^&^ Co\\codex.cmd login"',
      )
    } finally {
      Object.defineProperty(process, 'platform', { value: platform })
    }
  })

  it('accepts a pasted path with stray spaces or the quotes of Copy as path', () => {
    const store = new Store(':memory:')
    try {
      const paths = updateProviderExecutablePath(store, 'codex', `  "${process.execPath}" `)
      expect(paths['codex']).toBe(process.execPath)
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
