import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { platformShell, TerminalManager } from './terminal.js'

describe('TerminalManager', () => {
  it('selects a native shell without imposing a POSIX model', () => {
    expect(platformShell('win32', { ComSpec: 'C:\\Windows\\System32\\cmd.exe' })).toBe(
      'C:\\Windows\\System32\\cmd.exe',
    )
    expect(platformShell('darwin', { SHELL: '/bin/zsh' })).toBe('/bin/zsh')
    expect(platformShell('linux', {})).toBe('/bin/sh')
  })

  it('runs one real PTY in the session checkout and reports its exit', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'harness-terminal-'))
    let output = ''
    let sawCwd: () => void = () => {}
    let finished: (result: { terminalId: string; exitCode: number | null }) => void = () => {}
    const cwdSeen = new Promise<void>((resolve) => {
      sawCwd = resolve
    })
    const exited = new Promise<{ terminalId: string; exitCode: number | null }>((resolve) => {
      finished = resolve
    })
    const manager = new TerminalManager({
      onOutput: (_terminalId, data) => {
        output += data
        if (output.includes(cwd)) sawCwd()
      },
      onExit: (terminalId, exitCode) => finished({ terminalId, exitCode }),
    })

    try {
      const terminalId = manager.open('thread-1', cwd, 80, 24)
      expect(manager.open('thread-1', cwd, 100, 30)).toBe(terminalId)
      manager.write(terminalId, process.platform === 'win32' ? 'cd\r' : 'pwd\r')
      await within(cwdSeen)
      manager.write(terminalId, 'exit\r')

      await expect(within(exited)).resolves.toEqual({ terminalId, exitCode: 0 })
      expect(() => manager.write(terminalId, 'after exit')).toThrow(/no such terminal/i)
    } finally {
      manager.closeAll()
      rmSync(cwd, { recursive: true, force: true })
    }
  }, 15_000)

  it('closes the PTY when its session closes', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'harness-terminal-close-'))
    let finished: () => void = () => {}
    const exited = new Promise<void>((resolve) => {
      finished = resolve
    })
    const manager = new TerminalManager({ onOutput: () => {}, onExit: () => finished() })

    try {
      const terminalId = manager.open('thread-1', cwd, 80, 24)
      manager.closeThread('thread-1')
      expect(() => manager.resize(terminalId, 100, 30)).toThrow(/no such terminal/i)
      await within(exited)
    } finally {
      manager.closeAll()
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

async function within<T>(promise: Promise<T>): Promise<T> {
  let timeout: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('terminal test timed out')), 10_000)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}
