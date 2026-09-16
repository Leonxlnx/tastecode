import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { IPty } from 'node-pty'
import { describe, expect, it, vi } from 'vitest'
import {
  platformShell,
  terminalEnvironment,
  TerminalManager,
  TerminalOutputBuffer,
  TerminalOutputScheduler,
} from './terminal.js'

describe('TerminalManager', () => {
  it('retains bounded output and exit state for a reconnect without relaunching', () => {
    const pty = controlledPty()
    const spawn = vi.fn(() => pty)
    const chunks: number[] = []
    const manager = new TerminalManager(
      { onOutput: (_id, _data, offset) => chunks.push(offset), onExit: () => {} },
      { spawnPty: spawn },
    )
    const id = manager.run('install-test', 'test-command', os.tmpdir(), 80, 24)
    pty.emitData('a'.repeat(200_000))
    pty.emitData('last prompt')
    expect(manager.status(id)).toEqual({
      status: 'running',
      output: 'a'.repeat(199_989) + 'last prompt',
      outputOffset: 11,
      exitCode: null,
    })
    pty.emitExit(7)
    expect(manager.status(id)).toMatchObject({ status: 'exited', outputOffset: 11, exitCode: 7 })
    expect(chunks).toEqual([0, 200_000])
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(manager.status('missing').status).toBe('unknown')
  })

  it('expires old completed jobs without dropping a running terminal', () => {
    vi.useFakeTimers()
    try {
      const first = controlledPty()
      const second = controlledPty()
      const ptys = [first, second]
      const manager = new TerminalManager(
        { onOutput: () => {}, onExit: () => {} },
        { spawnPty: () => ptys.shift()! },
      )
      const done = manager.run('done', 'test', os.tmpdir(), 80, 24)
      first.emitExit(0)
      const running = manager.run('running', 'test', os.tmpdir(), 80, 24)
      vi.advanceTimersByTime(60 * 60 * 1000 + 1)
      expect(manager.status(done).status).toBe('unknown')
      expect(manager.status(running).status).toBe('running')
      second.emitExit(0)
    } finally {
      vi.useRealTimers()
    }
  })
  it('selects a native shell without imposing a POSIX model', () => {
    expect(platformShell('win32', { ComSpec: 'C:\\Windows\\System32\\cmd.exe' })).toBe(
      'C:\\Windows\\System32\\cmd.exe',
    )
    expect(platformShell('darwin', { SHELL: '/bin/zsh' })).toBe('/bin/zsh')
    expect(platformShell('linux', {})).toBe('/bin/sh')
  })

  it('advertises true color without dropping the native process environment', () => {
    const environment = terminalEnvironment({ PATH: '/system/bin', CUSTOM: 'kept' })
    expect(environment.CUSTOM).toBe('kept')
    expect(environment.TERM).toBe('xterm-256color')
    expect(environment.COLORTERM).toBe('truecolor')
    expect(environment.TERM_PROGRAM).toBe('TasteCode')
    expect(environment.PATH?.split(path.delimiter)[0]).toBe('/system/bin')
    expect(environment.PATH?.split(path.delimiter)).toContain(
      path.join(os.homedir(), '.local', 'bin'),
    )
  })

  it('batches high-volume PTY output without changing its byte order', () => {
    const emitted: string[] = []
    const buffer = new TerminalOutputBuffer((data) => emitted.push(data), 4, 64 * 1024)

    for (let index = 0; index < 1024; index += 1) buffer.push('x'.repeat(1024))

    expect(emitted).toHaveLength(16)
    expect(emitted.join('')).toBe('x'.repeat(1024 * 1024))
    buffer.dispose()
  })

  it('keeps interactive output latency bounded and flushes before exit', async () => {
    vi.useFakeTimers()
    try {
      const events: string[] = []
      const pty = controlledPty()
      const manager = new TerminalManager(
        {
          onOutput: (_terminalId, data) => events.push(`output:${data}`),
          onExit: (_terminalId, exitCode) => events.push(`exit:${String(exitCode)}`),
        },
        { spawnPty: () => pty },
      )
      manager.open('thread-buffered', os.tmpdir(), 80, 24)

      pty.emitData('prompt')
      expect(events).toEqual([])
      await vi.advanceTimersByTimeAsync(3)
      expect(events).toEqual([])
      await vi.advanceTimersByTimeAsync(1)
      expect(events).toEqual(['output:prompt'])

      pty.emitData('last line')
      pty.emitExit(0)
      expect(events).toEqual(['output:prompt', 'output:last line', 'exit:0'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('shares one short output timer across many active terminals', async () => {
    vi.useFakeTimers()
    try {
      const emitted: string[] = []
      const scheduler = new TerminalOutputScheduler(4)
      const buffers = Array.from(
        { length: 1_000 },
        (_, index) =>
          new TerminalOutputBuffer(
            (data) => emitted.push(`${index}:${data}`),
            4,
            64 * 1024,
            scheduler,
          ),
      )

      for (const buffer of buffers) {
        buffer.push('x')
        buffer.push('y')
      }
      expect(vi.getTimerCount()).toBe(1)
      await vi.advanceTimersByTimeAsync(4)
      expect(emitted).toHaveLength(1_000)
      expect(emitted[0]).toBe('0:xy')
      expect(emitted[999]).toBe('999:xy')
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not kill an already exited unowned PTY', async () => {
    const kill = vi.fn(() => {
      throw new Error('PTY already exited')
    })
    const first = controlledPty({ kill })
    const second = controlledPty()
    const ptys = [first, second]
    const manager = new TerminalManager(
      { onOutput: () => {}, onExit: () => {} },
      { spawnPty: () => ptys.shift()! },
    )

    const firstId = manager.open('thread-natural-exit', os.tmpdir(), 80, 24)
    first.emitExit(0)
    await manager.closeThread('thread-natural-exit')

    expect(manager.open('thread-natural-exit', os.tmpdir(), 80, 24)).not.toBe(firstId)
    expect(kill).not.toHaveBeenCalled()
    second.emitExit(0)
    await manager.closeAll()
  })

  it('keeps tab shells separate and closes every shell owned by a thread', async () => {
    const shells: ReturnType<typeof controlledPty>[] = []
    const manager = new TerminalManager(
      { onOutput: () => {}, onExit: () => {} },
      {
        spawnPty: () => {
          const shell = controlledPty()
          shells.push(shell)
          return shell
        },
      },
    )
    const bottom = manager.open('thread-tabs', os.tmpdir(), 80, 24, 'bottom-1')
    const right = manager.open('thread-tabs', os.tmpdir(), 80, 24, 'right-1')
    const second = manager.open('thread-tabs', os.tmpdir(), 80, 24, 'bottom-2')
    expect(new Set([bottom, right, second]).size).toBe(3)
    expect(manager.open('thread-tabs', os.tmpdir(), 80, 24, 'bottom-1')).toBe(bottom)
    const closing = manager.closeThread('thread-tabs')
    expect(() => manager.open('thread-tabs', os.tmpdir(), 80, 24, 'right-2')).toThrow(/closing/)
    for (const shell of shells) shell.emitExit(0)
    await closing
    for (const id of [bottom, right, second]) expect(manager.status(id).status).toBe('exited')
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
    const retry = manager.close(terminalId)
    expect(retry).not.toBe(closing)
    pty.emitExit(0)
    await expect(retry).resolves.toBeUndefined()
  })

  it('retries failed cleanup after a PTY has exited', async () => {
    const first = controlledPty()
    const second = controlledPty()
    const ptys = [first, second]
    const cleanupExitedPty = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('session cleanup failed'))
      .mockResolvedValue(undefined)
    const manager = new TerminalManager(
      { onOutput: () => {}, onExit: () => {} },
      { spawnPty: () => ptys.shift()!, cleanupExitedPty },
    )
    const terminalId = manager.open('thread-retry', os.tmpdir(), 80, 24)

    first.emitExit(0)
    await vi.waitFor(() => expect(cleanupExitedPty).toHaveBeenCalledOnce())
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(() => manager.open('thread-retry', os.tmpdir(), 80, 24)).toThrow(/cleanup is pending/i)

    await expect(manager.close(terminalId)).resolves.toBeUndefined()
    expect(cleanupExitedPty).toHaveBeenCalledTimes(2)
    const replacement = manager.open('thread-retry', os.tmpdir(), 80, 24)
    expect(replacement).not.toBe(terminalId)
    second.emitExit(0)
    await manager.closeAll()
  })

  it('retries server-wide shutdown after cleanup fails', async () => {
    const pty = controlledPty()
    const terminatePty = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('session cleanup failed'))
      .mockResolvedValue(undefined)
    const manager = new TerminalManager(
      { onOutput: () => {}, onExit: () => {} },
      { spawnPty: () => pty, terminatePty },
    )
    manager.open('thread-shutdown-retry', os.tmpdir(), 80, 24)

    const failed = manager.closeAll()
    await expect(failed).rejects.toThrow(/terminal shutdown failed/i)

    const retry = manager.closeAll()
    expect(retry).not.toBe(failed)
    pty.emitExit(0)
    await expect(retry).resolves.toBeUndefined()
    expect(terminatePty).toHaveBeenCalledTimes(2)
  })

  it('does not resolve close before owned session cleanup finishes', async () => {
    const pty = controlledPty()
    let rejectTermination: (error: Error) => void = () => {}
    const termination = new Promise<void>((_resolve, reject) => {
      rejectTermination = reject
    })
    const manager = new TerminalManager(
      { onOutput: () => {}, onExit: () => {} },
      { spawnPty: () => pty, terminatePty: () => termination },
    )
    const terminalId = manager.open('thread-1', os.tmpdir(), 80, 24)
    const closing = manager.close(terminalId)
    let settled = false
    void closing.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )

    pty.emitExit(0)
    await Promise.resolve()
    expect(settled).toBe(false)

    rejectTermination(new Error('session cleanup failed'))
    await expect(closing).rejects.toThrow('session cleanup failed')
  })

  it('keeps a terminal attached when node-pty rejects the kill request', async () => {
    let rejectKill = true
    const output: string[] = []
    const pty = controlledPty({
      kill: () => {
        if (rejectKill) throw new Error('kill failed')
      },
    })
    const manager = new TerminalManager(
      { onOutput: (_terminalId, data) => output.push(data), onExit: () => {} },
      { spawnPty: () => pty },
    )
    const terminalId = manager.open('thread-1', os.tmpdir(), 80, 24)

    await expect(manager.close(terminalId)).rejects.toThrow('kill failed')
    expect(manager.open('thread-1', os.tmpdir(), 100, 30)).toBe(terminalId)
    pty.emitData('still attached')
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(output).toEqual(['still attached'])

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
    const previousDisableAutoUpdate = process.env['DISABLE_AUTO_UPDATE']
    process.env['DISABLE_AUTO_UPDATE'] = 'true'
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
      if (previousDisableAutoUpdate === undefined) delete process.env['DISABLE_AUTO_UPDATE']
      else process.env['DISABLE_AUTO_UPDATE'] = previousDisableAutoUpdate
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
      expect(() => manager.resize(terminalId, 100, 30)).toThrow(/terminal is closing/i)
      await within(exited)
    } finally {
      await manager.closeAll()
      removeTemporaryDirectory(cwd)
    }
  })

  it.runIf(process.platform === 'linux')(
    'removes a PTY child and grandchild that ignore hangup',
    async () => {
      const cwd = mkdtempSync(path.join(os.tmpdir(), 'harness-terminal-tree-'))
      const fixture = path.join(cwd, 'tree.mjs')
      writeFileSync(
        fixture,
        `import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

process.on('SIGHUP', () => undefined)
process.on('SIGTERM', () => undefined)

if (process.argv[2] === 'grandchild') {
  process.send?.('ready')
  setInterval(() => undefined, 1_000)
} else {
  const grandchild = spawn(process.execPath, [fileURLToPath(import.meta.url), 'grandchild'], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  })
  grandchild.once('message', () => {
    console.log('TREE_READY ' + process.pid + ' ' + grandchild.pid)
  })
  setInterval(() => undefined, 1_000)
}
`,
      )
      let output = ''
      let sawTree: (pids: [number, number]) => void = () => {}
      const treeReady = new Promise<[number, number]>((resolve) => {
        sawTree = resolve
      })
      const manager = new TerminalManager({
        onOutput: (_terminalId, data) => {
          output += data
          const match = /TREE_READY\s+(\d+)\s+(\d+)/.exec(output)
          if (match) sawTree([Number(match[1]), Number(match[2])])
        },
        onExit: () => {},
      })
      let ownedProcesses: [ProcessIdentity, ProcessIdentity] | undefined

      try {
        const terminalId = manager.open('thread-tree', cwd, 80, 24)
        manager.write(terminalId, 'node ./tree.mjs\r')
        const ownedPids = await within(treeReady)
        ownedProcesses = ownedPids.map(processIdentity) as [ProcessIdentity, ProcessIdentity]
        expect(ownedProcesses.map(processExists)).toEqual([true, true])
        for (const identity of ownedProcesses) process.kill(identity.pid, 'SIGHUP')
        await Promise.resolve()
        expect(ownedProcesses.map(processExists)).toEqual([true, true])

        await manager.close(terminalId)

        expect(ownedProcesses.map(processExists)).toEqual([false, false])
      } finally {
        if (ownedProcesses) killExactProcesses(ownedProcesses)
        await manager.closeAll().catch(() => undefined)
        removeTemporaryDirectory(cwd)
      }
    },
    15_000,
  )

  it.runIf(process.platform === 'linux')(
    'prevents a PTY leader from spawning a late descendant during close',
    async () => {
      const cwd = mkdtempSync(path.join(os.tmpdir(), 'harness-terminal-hangup-'))
      const pidFile = path.join(cwd, 'late-child.pid')
      writeFileSync(
        path.join(cwd, 'late-child.mjs'),
        `process.on('SIGHUP', () => undefined)
process.on('SIGTERM', () => undefined)
setInterval(() => undefined, 1_000)
`,
      )
      let output = ''
      let sawReady: () => void = () => {}
      const ready = new Promise<void>((resolve) => {
        sawReady = resolve
      })
      const manager = new TerminalManager({
        onOutput: (_terminalId, data) => {
          output += data
          if (output.includes('TRAP_READY')) sawReady()
        },
        onExit: () => {},
      })

      try {
        const command =
          `trap 'trap "" HUP; node ./late-child.mjs & echo $! > late-child.pid' HUP; ` +
          `echo TRAP_READY; while :; do sleep 1; done`
        const terminalId = manager.run('hangup-trap', command, cwd, 80, 24)
        await within(ready)

        await manager.close(terminalId)

        expect(existsSync(pidFile)).toBe(false)
      } finally {
        if (existsSync(pidFile)) {
          const pid = Number(readFileSync(pidFile, 'utf8').trim())
          const startTime = processStartTime(pid)
          if (startTime) killExactProcesses([{ pid, startTime }])
        }
        await manager.closeAll().catch(() => undefined)
        removeTemporaryDirectory(cwd)
      }
    },
    15_000,
  )

  it.runIf(process.platform === 'linux')(
    'cleans a descendant after the PTY shell exits naturally',
    async () => {
      const cwd = mkdtempSync(path.join(os.tmpdir(), 'harness-terminal-natural-exit-'))
      const readyFile = path.join(cwd, 'child-ready')
      const captureFile = path.join(cwd, 'capture-complete')
      writeFileSync(
        path.join(cwd, 'natural-child.mjs'),
        `import { writeFileSync } from 'node:fs'
process.on('SIGHUP', () => undefined)
process.on('SIGTERM', () => undefined)
writeFileSync('./child-ready', String(process.pid))
setInterval(() => undefined, 1_000)
`,
      )
      let finish: () => void = () => {}
      const exited = new Promise<void>((resolve) => {
        finish = resolve
      })
      const manager = new TerminalManager({
        onOutput: () => {},
        onExit: () => finish(),
      })
      let child: ProcessIdentity | undefined

      try {
        manager.run(
          'natural-exit-descendant',
          'node ./natural-child.mjs & while [ ! -f child-ready ]; do sleep 0.01; done; while [ ! -f capture-complete ]; do sleep 0.01; done; exit',
          cwd,
          80,
          24,
        )
        await waitForFile(readyFile)
        const childPid = Number(readFileSync(readyFile, 'utf8').trim())
        child = processIdentity(childPid)
        expect(processExists(child)).toBe(true)
        writeFileSync(captureFile, '')

        await within(exited)
        expect(processExists(child)).toBe(true)

        await manager.closeAll()

        expect(processExists(child)).toBe(false)
      } finally {
        if (child) killExactProcesses([child])
        await manager.closeAll().catch(() => undefined)
        removeTemporaryDirectory(cwd)
      }
    },
    15_000,
  )

  it.runIf(process.platform === 'linux')(
    'closes short-lived PTYs without treating natural exit as an ownership failure',
    async () => {
      const manager = new TerminalManager({ onOutput: () => {}, onExit: () => {} })

      try {
        for (let index = 0; index < 500; index += 1) {
          const terminalId = manager.run(`fast-${index}`, ':', os.tmpdir(), 80, 24)
          await manager.close(terminalId)
        }
      } finally {
        await manager.closeAll()
      }
    },
    15_000,
  )
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

async function waitForFile(file: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!existsSync(file)) {
    if (Date.now() >= deadline) throw new Error(`file did not appear: ${file}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

it('does not replace a terminal until its close has finished', async () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'harness-terminal-stale-'))
  const exited = new Set<string>()
  const manager = new TerminalManager({
    onOutput: () => {},
    onExit: (terminalId) => exited.add(terminalId),
  })

  try {
    const first = manager.open('thread-1', cwd, 80, 24)
    const firstClosing = manager.close(first)
    const threadClosing = manager.closeThread('thread-1')
    expect(() => manager.open('thread-1', cwd, 80, 24)).toThrow(/terminal is closing/i)
    await Promise.all([firstClosing, threadClosing])

    const second = manager.open('thread-1', cwd, 80, 24)
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

type ProcessIdentity = { pid: number; startTime: string }

function processIdentity(pid: number): ProcessIdentity {
  const startTime = processStartTime(pid)
  if (!startTime) throw new Error(`process disappeared before identity capture: ${pid}`)
  return { pid, startTime }
}

function processExists(identity: ProcessIdentity): boolean {
  return processStartTime(identity.pid) === identity.startTime
}

function processStartTime(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const commandEnd = stat.lastIndexOf(')')
    return commandEnd < 0 ? undefined : stat.slice(commandEnd + 2).split(' ')[19]
  } catch (error) {
    const code = processErrorCode(error)
    if (code === 'ESRCH' || code === 'ENOENT') return undefined
    throw error
  }
}

function killExactProcesses(processes: ProcessIdentity[]): void {
  for (const identity of processes) {
    if (!processExists(identity)) continue
    try {
      process.kill(identity.pid, 'SIGKILL')
    } catch (error) {
      if (processErrorCode(error) !== 'ESRCH') throw error
    }
  }
}

function processErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  return typeof error.code === 'string' ? error.code : undefined
}

function controlledPty(options: { kill?: () => void } = {}): IPty & {
  emitData(data: string): void
  emitExit(exitCode: number): void
} {
  let onData: (data: string) => void = () => {}
  let onExit: (event: { exitCode: number; signal?: number }) => void = () => {}
  return {
    pid: 1,
    cols: 80,
    rows: 24,
    process: 'fake',
    handleFlowControl: false,
    onData: (listener) => {
      onData = listener
      return { dispose: () => {} }
    },
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
    emitData: (data) => onData(data),
    emitExit: (exitCode) => onExit({ exitCode }),
  }
}
