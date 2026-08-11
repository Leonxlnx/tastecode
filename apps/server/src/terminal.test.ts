import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { IPty } from 'node-pty'
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

  it('bounds shutdown when a PTY never reports its exit', async () => {
    const pty = controlledPty()
    const manager = new TerminalManager(
      { onOutput: () => {}, onExit: () => {} },
      { spawnPty: () => pty, closeTimeoutMs: 10 },
    )
    const terminalId = manager.open('thread-1', os.tmpdir(), 80, 24)
    const closing = manager.close(terminalId)

    await expect(closing).rejects.toThrow(/shutdown timed out/i)
    expect(manager.close(terminalId)).toBe(closing)
    await expect(manager.closeThread('thread-1')).rejects.toThrow(/terminal shutdown failed/i)
  })

  it('keeps a terminal attached when node-pty rejects the kill request', async () => {
    let rejectKill = true
    const pty = controlledPty({
      kill: () => {
        if (rejectKill) throw new Error('kill failed')
      },
    })
    const manager = new TerminalManager(
      { onOutput: () => {}, onExit: () => {} },
      { spawnPty: () => pty },
    )
    const terminalId = manager.open('thread-1', os.tmpdir(), 80, 24)

    expect(() => manager.close(terminalId)).toThrow('kill failed')
    expect(manager.open('thread-1', os.tmpdir(), 100, 30)).toBe(terminalId)

    rejectKill = false
    const closed = manager.close(terminalId)
    pty.emitExit(0)
    await expect(closed).resolves.toBeUndefined()
  })

  it('attempts every PTY close when one kill request fails', async () => {
    let secondKilled = false
    const first = controlledPty({
      kill: () => {
        throw new Error('first kill failed')
      },
    })
    const second = controlledPty({
      kill: () => {
        secondKilled = true
        queueMicrotask(() => second.emitExit(0))
      },
    })
    const ptys = [first, second]
    const manager = new TerminalManager(
      { onOutput: () => {}, onExit: () => {} },
      { spawnPty: () => ptys.shift()! },
    )
    manager.open('thread-1', os.tmpdir(), 80, 24)
    manager.open('thread-2', os.tmpdir(), 80, 24)

    await expect(manager.closeAll()).rejects.toThrow(/terminal shutdown failed/i)
    expect(secondKilled).toBe(true)
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
      await manager.closeAll()
      removeTemporaryDirectory(cwd)
    }
  }, 15_000)

  it('runs a one-shot command, reattaches while running, and reports its exit', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'harness-terminal-run-'))
    let output = ''
    let finished: (result: { terminalId: string; exitCode: number | null }) => void = () => {}
    const exited = new Promise<{ terminalId: string; exitCode: number | null }>((resolve) => {
      finished = resolve
    })
    const manager = new TerminalManager({
      onOutput: (_terminalId, data) => (output += data),
      onExit: (terminalId, exitCode) => finished({ terminalId, exitCode }),
    })

    try {
      // Linger briefly after the echo so the reattach below happens while the
      // command is verifiably still alive.
      const command =
        process.platform === 'win32'
          ? 'echo harness-run-done && ping -n 2 127.0.0.1 > NUL'
          : 'echo harness-run-done && sleep 1'
      const terminalId = manager.run('install:probe', command, cwd, 80, 24)
      // A second click while the command runs must attach, not run it again.
      expect(manager.run('install:probe', 'echo something-else', cwd, 100, 30)).toBe(terminalId)

      await expect(within(exited)).resolves.toEqual({ terminalId, exitCode: 0 })
      expect(output).toContain('harness-run-done')
      expect(output).not.toContain('something-else')
    } finally {
      await manager.closeAll()
      removeTemporaryDirectory(cwd)
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
      await manager.closeAll()
      removeTemporaryDirectory(cwd)
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

it('closing a stale terminal id does not unmap a newer pty under the same key', async () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'harness-terminal-stale-'))
  const exited = new Set<string>()
  const manager = new TerminalManager({
    onOutput: () => {},
    onExit: (terminalId) => exited.add(terminalId),
  })

  try {
    const first = manager.open('thread-1', cwd, 80, 24)
    // Simulate the respawn race: the first pty is closed directly, a new
    // one is opened under the same key, and then someone closes the stale
    // first id again (a late client, a double-click).
    const firstClosing = manager.close(first)
    const second = manager.open('thread-1', cwd, 80, 24)
    expect(manager.close(first)).toBe(firstClosing)

    // The newer pty must still be mapped: asking for the thread's terminal
    // reattaches instead of spawning a third.
    expect(manager.open('thread-1', cwd, 80, 24)).toBe(second)
    await manager.closeThread('thread-1')
    expect(exited).toEqual(new Set([first, second]))
  } finally {
    await manager.closeAll()
    expect(exited.size).toBe(2)
    removeTemporaryDirectory(cwd)
  }
}, 15_000)

function removeTemporaryDirectory(directory: string): void {
  rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
}

function controlledPty(options: { kill?: () => void } = {}): IPty & {
  emitExit(exitCode: number): void
} {
  let onExit: (event: { exitCode: number; signal?: number }) => void = () => {}
  return {
    pid: 1,
    cols: 80,
    rows: 24,
    process: 'fake',
    handleFlowControl: false,
    onData: () => ({ dispose: () => {} }),
    onExit: (listener) => {
      onExit = listener
      return { dispose: () => {} }
    },
    write: () => {},
    resize: () => {},
    clear: () => {},
    kill: () => options.kill?.(),
    pause: () => {},
    resume: () => {},
    emitExit: (exitCode) => onExit({ exitCode }),
  }
}
