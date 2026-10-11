import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { IPty } from 'node-pty'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
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

  it.skipIf(process.platform !== 'win32')(
    'retains a copied Windows Path in terminal sessions',
    () => {
      const env = terminalEnvironment({ Path: 'C:\\Windows\\System32', CUSTOM: 'kept' })
      expect(env.PATH?.split(';')[0]).toBe('C:\\Windows\\System32')
      expect(Object.keys(env).filter((key) => key.toLowerCase() === 'path')).toEqual(['PATH'])
      expect(env.CUSTOM).toBe('kept')
    },
  )

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

  it('refuses to start a shell in a folder that no longer exists', () => {
    const spawn = vi.fn(() => controlledPty())
    const manager = new TerminalManager(
      { onOutput: () => {}, onExit: () => {} },
      { spawnPty: spawn },
    )
    const missing = mkdtempSync(path.join(os.tmpdir(), 'harness-terminal-missing-'))
    removeTemporaryDirectory(missing)

    expect(() => manager.open('thread-gone', missing, 80, 24)).toThrow(
      'The folder for this terminal no longer exists.',
    )
    expect(spawn).not.toHaveBeenCalled()
  })

  it('reattaches to a running shell after its folder is removed', () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'harness-terminal-removed-'))
    const spawn = vi.fn(() => controlledPty())
    const manager = new TerminalManager(
      { onOutput: () => {}, onExit: () => {} },
      { spawnPty: spawn },
    )
    const terminalId = manager.open('thread-1', cwd, 80, 24)
    removeTemporaryDirectory(cwd)

    expect(manager.open('thread-1', cwd, 100, 30)).toBe(terminalId)
    expect(spawn).toHaveBeenCalledOnce()
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

  it('closes once the shell is gone and keeps only shutdown waiting for its job', async () => {
    vi.useFakeTimers()
    try {
      const pty = controlledPty({ pid: 4100 })
      let jobRunning = true
      const processes = fakeProcesses({
        list: vi.fn(() => Promise.resolve(jobRunning ? [jobMember] : [])),
        signal: vi.fn(),
      })
      const manager = new TerminalManager(
        { onOutput: () => {}, onExit: () => {} },
        { spawnPty: () => pty, processes },
      )
      const terminalId = manager.open('thread-job', os.tmpdir(), 80, 24)
      const closed = manager.close(terminalId)
      pty.emitExit(0)
      await closed
      await manager.closeThread('thread-job')
      expect(processes.list).toHaveBeenCalled()

      let shutDown = false
      const shutdown = manager.closeAll().then(() => (shutDown = true))
      await vi.advanceTimersByTimeAsync(150)
      expect(shutDown).toBe(false)

      // A job that shuts down on its own after the hangup is never signalled.
      jobRunning = false
      await vi.advanceTimersByTimeAsync(100)
      expect(shutDown).toBe(true)
      await shutdown
      expect(processes.signal).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('lets a chat open a new terminal while its old job still shuts down', async () => {
    const ptys = [controlledPty({ pid: 4100 }), controlledPty({ pid: 4200 })]
    const [first, second] = ptys as [
      ReturnType<typeof controlledPty>,
      ReturnType<typeof controlledPty>,
    ]
    let jobRunning = true
    const manager = new TerminalManager(
      { onOutput: () => {}, onExit: () => {} },
      {
        spawnPty: () => ptys.shift()!,
        processes: fakeProcesses({
          list: () => Promise.resolve(jobRunning ? [jobMember] : []),
        }),
      },
    )
    const old = manager.open('thread-reopen', os.tmpdir(), 80, 24)
    const closing = manager.closeThread('thread-reopen')
    first.emitExit(0)
    await closing

    const reopened = manager.open('thread-reopen', os.tmpdir(), 80, 24)
    expect(reopened).not.toBe(old)

    const shutdown = manager.closeAll()
    second.emitExit(0)
    jobRunning = false
    await shutdown
  })

  it('never signals a group named by a process this server did not fork', async () => {
    const reports = [
      { ...ownShell(4100), parent: process.pid + 1 },
      { ...ownShell(4100), group: 4101 },
      { ...ownShell(4100), leader: false },
      ownShell(4100, 1),
      ownShell(4100, -1),
    ]
    const list = vi.fn(() => Promise.resolve([jobMember]))
    const signal = vi.fn()
    for (const report of reports) {
      const pty = controlledPty({ pid: 4100 })
      const manager = new TerminalManager(
        { onOutput: () => {}, onExit: () => {} },
        {
          spawnPty: () => pty,
          processes: fakeProcesses({ inspect: () => [report], list, signal }),
        },
      )
      const closed = manager.close(manager.open('thread-foreign', os.tmpdir(), 80, 24))
      pty.emitExit(0)
      await closed
    }
    expect(list).not.toHaveBeenCalled()
    expect(signal).not.toHaveBeenCalled()
  })

  it.each([
    { closeWith: 'a pane close', steps: [3_000, 3_000] },
    { closeWith: 'server shutdown', steps: [200, 1_800] },
  ])('gives a job time to shut down before SIGTERM and SIGKILL on $closeWith', async (test) => {
    vi.useFakeTimers()
    try {
      const signals: string[] = []
      const pty = controlledPty({ pid: 4100, kill: () => queueMicrotask(() => pty.emitExit(0)) })
      const manager = new TerminalManager(
        { onOutput: () => {}, onExit: () => {} },
        {
          spawnPty: () => pty,
          processes: fakeProcesses({
            list: () => Promise.resolve(signals.includes('SIGKILL') ? [] : [jobMember]),
            signal: (group, signal) => signals.push(group === 4242 ? signal : `${group}:${signal}`),
          }),
        },
      )
      const terminalId = manager.open('thread-slow', os.tmpdir(), 80, 24)
      const closed =
        test.closeWith === 'server shutdown' ? manager.closeAll() : manager.close(terminalId)
      const [hangup, terminate] = test.steps as [number, number]

      await vi.advanceTimersByTimeAsync(hangup - 1)
      expect(signals).toEqual([])
      await vi.advanceTimersByTimeAsync(1)
      expect(signals).toEqual(['SIGTERM'])
      await vi.advanceTimersByTimeAsync(terminate - 1)
      expect(signals).toEqual(['SIGTERM'])
      await vi.advanceTimersByTimeAsync(1)
      expect(signals).toEqual(['SIGTERM', 'SIGKILL'])
      await closed
    } finally {
      vi.useRealTimers()
    }
  })

  it('sends SIGTERM on time at shutdown although node-pty reports the shell late', async () => {
    vi.useFakeTimers()
    try {
      const signals: string[] = []
      // The job holds the terminal open, so node-pty reports the exit 300 ms late.
      const pty = controlledPty({ pid: 4100, kill: () => setTimeout(() => pty.emitExit(0), 300) })
      const manager = new TerminalManager(
        { onOutput: () => {}, onExit: () => {} },
        {
          spawnPty: () => pty,
          processes: fakeProcesses({
            list: () => Promise.resolve(signals.includes('SIGKILL') ? [] : [jobMember]),
            signal: (_group, signal) => signals.push(signal),
          }),
        },
      )
      manager.open('thread-late', os.tmpdir(), 80, 24)
      const shutdown = manager.closeAll()

      await vi.advanceTimersByTimeAsync(199)
      expect(signals).toEqual([])
      await vi.advanceTimersByTimeAsync(1)
      expect(signals).toEqual(['SIGTERM'])
      await vi.advanceTimersByTimeAsync(1_800)
      expect(signals).toEqual(['SIGTERM', 'SIGKILL'])
      await shutdown
    } finally {
      vi.useRealTimers()
    }
  })

  it('sends SIGTERM on time at shutdown to the job of a pane still closing its shell', async () => {
    vi.useFakeTimers()
    try {
      const signals: string[] = []
      let shellKilled = false
      // The shell ignores SIGHUP, and node-pty reports its SIGKILL 300 ms late.
      const pty = controlledPty({
        pid: 4100,
        kill: (signal) => {
          if (signal !== 'SIGKILL') return
          shellKilled = true
          setTimeout(() => pty.emitExit(137), 300)
        },
      })
      const manager = new TerminalManager(
        { onOutput: () => {}, onExit: () => {} },
        {
          spawnPty: () => pty,
          processes: fakeProcesses({
            list: () =>
              Promise.resolve([
                ...(shellKilled ? [] : [ownShell(4100)]),
                ...(signals.includes('SIGKILL') ? [] : [jobMember]),
              ]),
            signal: (_group, signal) => signals.push(signal),
          }),
        },
      )
      const closed = manager.close(manager.open('thread-stuck', os.tmpdir(), 80, 24))
      await vi.advanceTimersByTimeAsync(1_000)
      expect(shellKilled).toBe(false)

      const shutdown = manager.closeAll()
      await vi.advanceTimersByTimeAsync(199)
      expect(signals).toEqual([])
      await vi.advanceTimersByTimeAsync(1)
      expect(shellKilled).toBe(true)
      expect(signals).toEqual(['SIGTERM'])
      await vi.advanceTimersByTimeAsync(1_799)
      expect(signals).toEqual(['SIGTERM'])
      await vi.advanceTimersByTimeAsync(1)
      expect(signals).toEqual(['SIGTERM', 'SIGKILL'])
      await Promise.all([closed, shutdown])
    } finally {
      vi.useRealTimers()
    }
  })

  it('shortens a pane close already waiting on its job when the server shuts down', async () => {
    vi.useFakeTimers()
    try {
      const signals: string[] = []
      const pty = controlledPty({ pid: 4100, kill: () => queueMicrotask(() => pty.emitExit(0)) })
      const manager = new TerminalManager(
        { onOutput: () => {}, onExit: () => {} },
        {
          spawnPty: () => pty,
          processes: fakeProcesses({
            list: () => Promise.resolve(signals.includes('SIGKILL') ? [] : [jobMember]),
            signal: (_group, signal) => signals.push(signal),
          }),
        },
      )
      const closed = manager.close(manager.open('thread-slow', os.tmpdir(), 80, 24))
      await vi.advanceTimersByTimeAsync(1_000)
      expect(signals).toEqual([])

      const shutdown = manager.closeAll()
      await vi.advanceTimersByTimeAsync(199)
      expect(signals).toEqual([])
      await vi.advanceTimersByTimeAsync(1)
      expect(signals).toEqual(['SIGTERM'])
      await vi.advanceTimersByTimeAsync(1_799)
      expect(signals).toEqual(['SIGTERM'])
      await vi.advanceTimersByTimeAsync(1)
      expect(signals).toEqual(['SIGTERM', 'SIGKILL'])
      await Promise.all([closed, shutdown])
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops every stubborn job by the shutdown deadline even when ps is slow', async () => {
    vi.useFakeTimers()
    try {
      const count = 6
      const jobKilledAt = new Map<number, number>()
      const shellKilledAt: number[] = []
      const killedShells = new Set<number>()
      let startedAt = 0
      let listing = 0
      let mostListings = 0
      let listings = 0
      const ptys = Array.from({ length: count }, (_, index) => {
        const pty = controlledPty({
          pid: 4100 + index,
          // Each shell ignores SIGHUP, and node-pty reports its SIGKILL 200 ms late.
          kill: (signal) => {
            if (signal !== 'SIGKILL') return
            shellKilledAt.push(Date.now() - startedAt)
            killedShells.add(4_100 + index)
            setTimeout(() => pty.emitExit(137), 200)
          },
        })
        return pty
      })
      const inspect = vi.fn((pids: number[]) => {
        // A ps that takes 60 ms blocks the event loop for as long, and no
        // timer is due yet that could run meanwhile...
        vi.advanceTimersByTime(60)
        return pids.map((pid) => ownShell(pid, pid + 1_000))
      })
      const spawned = [...ptys]
      const manager = new TerminalManager(
        { onOutput: () => {}, onExit: () => {} },
        {
          spawnPty: () => spawned.shift()!,
          processes: {
            inspect,
            // ...and lists every process 100 ms after it was asked.
            list: () =>
              new Promise((resolve) => {
                listing += 1
                listings += 1
                mostListings = Math.max(mostListings, listing)
                setTimeout(() => {
                  listing -= 1
                  resolve(
                    ptys.flatMap((_, index) => {
                      const shell = 4_100 + index
                      const group = shell + 1_000
                      const job = { ...jobMember, pid: group, group, session: String(shell) }
                      return [
                        ...(killedShells.has(shell) ? [] : [ownShell(shell, group)]),
                        ...(jobKilledAt.has(group) ? [] : [job]),
                      ]
                    }),
                  )
                }, 100)
              }),
            // Every job ignores SIGHUP and SIGTERM.
            signal: (group, signal) => {
              if (signal === 'SIGKILL') jobKilledAt.set(group, Date.now() - startedAt)
            },
          },
        },
      )
      for (let index = 0; index < count; index += 1) {
        manager.open(`thread-${index}`, os.tmpdir(), 80, 24)
      }
      startedAt = Date.now()
      let finished = false
      void manager.closeAll().then(() => (finished = true))

      await vi.advanceTimersByTimeAsync(2_500)
      expect(finished).toBe(true)
      expect(jobKilledAt.size).toBe(count)
      expect(Math.max(...jobKilledAt.values())).toBeLessThanOrEqual(2_200)
      // One ps for every shell. After that, each job's first poll after its
      // own SIGTERM or SIGKILL needs a listing begun after that signal, and
      // every other poll shares one. Listing on every poll would take nearly
      // three times as many.
      expect(inspect).toHaveBeenCalledOnce()
      expect(Math.max(...shellKilledAt)).toBeLessThanOrEqual(400)
      expect(mostListings).toBe(count)
      expect(listings).toBeLessThanOrEqual(30)
    } finally {
      vi.useRealTimers()
    }
  })

  it('never judges a signal by a listing begun before it in the same millisecond', async () => {
    vi.useFakeTimers()
    try {
      const killedAt = new Map<number, number>()
      const ptys = [4100, 4200].map((pid) => {
        const pty = controlledPty({ pid, kill: () => queueMicrotask(() => pty.emitExit(0)) })
        return pty
      })
      // Two jobs that only SIGKILL ends, read by a ps that takes 50 ms and
      // shows the processes as they were when it started.
      const jobs = ptys.map(({ pid }) => ({
        ...jobMember,
        pid: pid + 1_001,
        group: pid + 1_000,
        session: String(pid),
      }))
      const spawned = [...ptys]
      const manager = new TerminalManager(
        { onOutput: () => {}, onExit: () => {} },
        {
          spawnPty: () => spawned.shift()!,
          processes: fakeProcesses({
            inspect: (pids) => pids.map((pid) => ownShell(pid, pid + 1_000)),
            list: () => {
              const rows = jobs.filter((job) => !killedAt.has(job.group))
              return new Promise((resolve) => setTimeout(() => resolve(rows), 50))
            },
            signal: (group, signal) => {
              if (signal === 'SIGKILL') killedAt.set(group, Date.now())
            },
          }),
        },
      )
      manager.open('thread-a', os.tmpdir(), 80, 24)
      manager.open('thread-b', os.tmpdir(), 80, 24)
      let finishedAt: number | undefined
      void manager.closeAll().then(() => (finishedAt = Date.now()))

      await vi.advanceTimersByTimeAsync(2_500)
      // Both SIGKILLs go out in the same millisecond, the second after the
      // first job's listing began. That listing still shows the second job,
      // so judging by it would cost the second job another poll.
      expect(killedAt.size).toBe(2)
      expect(new Set(killedAt.values()).size).toBe(1)
      expect(finishedAt! - Math.max(...killedAt.values())).toBeLessThanOrEqual(50)
    } finally {
      vi.useRealTimers()
    }
  })

  it('retries a failed process listing on the next poll', async () => {
    vi.useFakeTimers()
    try {
      const logs: string[] = []
      const signals: string[] = []
      let listings = 0
      const pty = controlledPty({ pid: 4100, kill: () => queueMicrotask(() => pty.emitExit(0)) })
      const manager = new TerminalManager(
        { onOutput: () => {}, onExit: () => {}, onLog: (line) => logs.push(line) },
        {
          spawnPty: () => pty,
          processes: fakeProcesses({
            // ps fails once, right after the hangup.
            list: () =>
              Promise.resolve(
                (listings += 1) === 1 ? undefined : signals.includes('SIGKILL') ? [] : [jobMember],
              ),
            signal: (_group, signal) => signals.push(signal),
          }),
        },
      )
      await manager.close(manager.open('thread-flaky', os.tmpdir(), 80, 24))

      await vi.advanceTimersByTimeAsync(3_000)
      expect(signals).toEqual(['SIGTERM'])
      await vi.advanceTimersByTimeAsync(3_000)
      expect(signals).toEqual(['SIGTERM', 'SIGKILL'])
      await manager.closeAll()
      expect(logs).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  // Linux ps output: macOS prints 0 as every process's session, so there this
  // guard never fires.
  it('never signals a job group that now holds another Linux session', async () => {
    vi.useFakeTimers()
    try {
      const logs: string[] = []
      const pty = controlledPty({ pid: 4100, kill: () => queueMicrotask(() => pty.emitExit(0)) })
      const processes = fakeProcesses({
        // The job's group id was recycled: a stranger joined it.
        list: vi.fn(() =>
          Promise.resolve([jobMember, { ...jobMember, pid: 5000, session: '4900' }]),
        ),
        signal: vi.fn(),
      })
      const manager = new TerminalManager(
        { onOutput: () => {}, onExit: () => {}, onLog: (line) => logs.push(line) },
        { spawnPty: () => pty, processes },
      )
      const closed = manager.close(manager.open('thread-recycled', os.tmpdir(), 80, 24))

      await vi.advanceTimersByTimeAsync(10_000)
      await closed
      expect(processes.list).toHaveBeenCalled()
      expect(processes.signal).not.toHaveBeenCalled()
      expect(logs).toEqual([expect.stringMatching(/left job 4242 .*another session/)])
    } finally {
      vi.useRealTimers()
    }
  })

  it.each([
    {
      problem: 'a member it may not signal',
      processes: () =>
        fakeProcesses({
          list: () => Promise.resolve([jobMember]),
          signal: () => {
            throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' })
          },
        }),
      log: /could not stop job 4242 .*EPERM/,
    },
    {
      problem: 'a member that survives SIGKILL',
      processes: () => fakeProcesses({ list: () => Promise.resolve([jobMember]) }),
      log: /left job 4242 .*survived SIGKILL/,
    },
    {
      problem: 'members it cannot list',
      processes: () => fakeProcesses({ list: () => Promise.resolve(undefined) }),
      log: /left job 4242 .*could not be listed/,
    },
  ])('logs instead of failing a close whose job has $problem', async (test) => {
    vi.useFakeTimers()
    try {
      const logs: string[] = []
      const pty = controlledPty({ pid: 4100, kill: () => queueMicrotask(() => pty.emitExit(0)) })
      const manager = new TerminalManager(
        { onOutput: () => {}, onExit: () => {}, onLog: (line) => logs.push(line) },
        {
          spawnPty: () => pty,
          processes: test.processes(),
        },
      )
      const closed = manager.close(manager.open('thread-stuck', os.tmpdir(), 80, 24))
      const shutdown = manager.closeAll()

      await vi.advanceTimersByTimeAsync(10_000)
      await expect(closed).resolves.toBeUndefined()
      await expect(shutdown).resolves.toBeUndefined()
      expect(logs).toEqual([expect.stringMatching(test.log)])
    } finally {
      vi.useRealTimers()
    }
  })

  it('kills only an owned shell that is still running after the hangup grace', async () => {
    vi.useFakeTimers()
    try {
      const signals: Array<string | undefined> = []
      const ignoring = controlledPty({ pid: 4100, kill: (signal) => signals.push(signal) })
      const exiting = controlledPty({
        pid: 4200,
        kill: (signal) => {
          signals.push(`exiting:${String(signal)}`)
          queueMicrotask(() => exiting.emitExit(0))
        },
      })
      const foreign = controlledPty({
        pid: 4300,
        kill: (signal) => signals.push(`foreign:${String(signal)}`),
      })
      const ptys = [ignoring, exiting, foreign]
      const shells = (pids: number[]) =>
        pids.map((pid) => ({
          ...ownShell(pid, pid),
          parent: pid === 4300 ? process.pid + 1 : process.pid,
        }))
      const manager = new TerminalManager(
        { onOutput: () => {}, onExit: () => {} },
        {
          spawnPty: () => ptys.shift()!,
          processes: fakeProcesses({
            inspect: shells,
            list: () => Promise.resolve(shells([4100])),
          }),
        },
      )
      const ids = ['a', 'b', 'c'].map((key) => manager.open(`thread-${key}`, os.tmpdir(), 80, 24))
      const closing = Promise.all(ids.map((id) => manager.close(id)))

      await vi.advanceTimersByTimeAsync(2_999)
      expect(signals).toEqual([undefined, 'exiting:undefined', 'foreign:undefined'])
      await vi.advanceTimersByTimeAsync(1)
      expect(signals).toEqual([undefined, 'exiting:undefined', 'foreign:undefined', 'SIGKILL'])

      ignoring.emitExit(137)
      foreign.emitExit(0)
      await closing
    } finally {
      vi.useRealTimers()
    }
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
      expect(() => manager.resize(terminalId, 100, 30)).toThrow(/no such terminal/i)
      await within(exited)
    } finally {
      await manager.closeAll()
      removeTemporaryDirectory(cwd)
    }
  })

  describe.skipIf(process.platform === 'win32')('closing a POSIX shell', () => {
    const previousDisableAutoUpdate = process.env['DISABLE_AUTO_UPDATE']
    beforeAll(() => {
      process.env['DISABLE_AUTO_UPDATE'] = 'true'
    })
    afterAll(() => {
      if (previousDisableAutoUpdate === undefined) delete process.env['DISABLE_AUTO_UPDATE']
      else process.env['DISABLE_AUTO_UPDATE'] = previousDisableAutoUpdate
    })

    it('stops a foreground job that ignores hangup', async () => {
      const cwd = mkdtempSync(path.join(os.tmpdir(), 'harness-terminal-job-'))
      const shell = watchedShell(/JOB_READY (\d+)/)
      let job: number | undefined
      try {
        const terminalId = shell.manager.open('thread-job', cwd, 120, 24)
        shell.manager.write(
          terminalId,
          `'${process.execPath}' -e "process.on('SIGHUP', () => {}); ` +
            `console.log('JOB_READY ' + process.pid); setInterval(() => {}, 1000)"\r`,
        )
        job = await within(shell.match)

        await shell.manager.close(terminalId)

        // Only the escalation after the hangup grace can end it.
        await waitUntil(() => !isRunning(job!))
      } finally {
        if (job !== undefined && isRunning(job)) process.kill(job, 'SIGKILL')
        await shell.manager.closeAll()
        removeTemporaryDirectory(cwd)
      }
    }, 15_000)

    it('closes a pane while its foreground job finishes a clean shutdown', async () => {
      const cwd = mkdtempSync(path.join(os.tmpdir(), 'harness-terminal-clean-'))
      const marker = path.join(cwd, 'cleaned-up')
      // Shuts down on SIGHUP or SIGTERM like a dev server that flushes state,
      // taking a second and a half before it writes the marker and exits.
      writeFileSync(
        path.join(cwd, 'job.cjs'),
        [
          "const fs = require('node:fs')",
          'let stopping = false',
          'const stop = () => {',
          '  if (stopping) return',
          '  stopping = true',
          "  setTimeout(() => { fs.writeFileSync(process.argv[2], 'done'); process.exit(0) }, 1500)",
          '}',
          "process.on('SIGHUP', stop)",
          "process.on('SIGTERM', stop)",
          "console.log('JOB_READY ' + process.pid)",
          'setInterval(() => {}, 1000)',
        ].join('\n'),
      )
      const shell = watchedShell(/JOB_READY (\d+)/)
      let job: number | undefined
      try {
        const terminalId = shell.manager.open('thread-clean', cwd, 120, 24)
        shell.manager.write(terminalId, `'${process.execPath}' job.cjs '${marker}'\r`)
        job = await within(shell.match)

        await shell.manager.close(terminalId)
        expect(isRunning(job)).toBe(true)

        await waitUntil(() => !isRunning(job!))
        expect(existsSync(marker)).toBe(true)
      } finally {
        if (job !== undefined && isRunning(job)) process.kill(job, 'SIGKILL')
        await shell.manager.closeAll()
        removeTemporaryDirectory(cwd)
      }
    }, 15_000)

    it('keeps a shutting-down server alive until its foreground job is stopped', () => {
      const cwd = mkdtempSync(path.join(os.tmpdir(), 'harness-terminal-exit-'))
      // The job records its pid first, so it is killed below whatever happens
      // to the server process.
      const pidFile = path.join(cwd, 'job.pid')
      writeFileSync(
        path.join(cwd, 'job.cjs'),
        "require('node:fs').writeFileSync('job.pid', String(process.pid)); " +
          "process.on('SIGHUP', () => {}); console.log('JOB_READY ' + process.pid); " +
          'setInterval(() => {}, 1000)',
      )
      const terminalModule = new URL('./terminal.ts', import.meta.url).href
      const recordedJob = () =>
        existsSync(pidFile) ? Number(readFileSync(pidFile, 'utf8')) : undefined
      try {
        // A server process with nothing else left to do: only the close itself
        // can keep it running until the job is gone.
        const result = spawnSync(
          process.execPath,
          [
            '--import',
            'tsx',
            '--input-type=module',
            '-e',
            `
              const { TerminalManager } = await import(${JSON.stringify(terminalModule)})
              let output = ''
              const manager = new TerminalManager({
                onOutput: (_terminalId, data) => (output += data),
                onExit: () => {},
              })
              const terminalId = manager.open('thread-exit', ${JSON.stringify(cwd)}, 120, 24)
              manager.write(terminalId, ${JSON.stringify(`'${process.execPath}' job.cjs\r`)})
              const ready = setInterval(() => {
                const match = /JOB_READY (\\d+)/.exec(output)
                if (!match) return
                clearInterval(ready)
                console.log('JOB ' + match[1])
                void manager.closeAll().then(() => console.log('CLOSED'))
              }, 20)
            `,
          ],
          { encoding: 'utf8', timeout: 10_000 },
        )
        expect(result.stdout, result.stderr).toContain('CLOSED')
        const job = recordedJob()
        expect(job).toBeDefined()
        expect(isRunning(job!)).toBe(false)
      } finally {
        const job = recordedJob()
        if (job !== undefined && isRunning(job)) process.kill(job, 'SIGKILL')
        removeTemporaryDirectory(cwd)
      }
    }, 15_000)

    it('ends a shell that ignores hangup', async () => {
      const cwd = mkdtempSync(path.join(os.tmpdir(), 'harness-terminal-trap-'))
      const shell = watchedShell(/SHELL_READY (\d+)/, { closeTimeoutMs: 5_000 })
      let pid: number | undefined
      try {
        const terminalId = shell.manager.open('thread-trap', cwd, 120, 24)
        shell.manager.write(terminalId, "trap '' HUP; echo SHELL_READY $$\r")
        pid = await within(shell.match)

        await shell.manager.close(terminalId)

        expect(isRunning(pid)).toBe(false)
      } finally {
        if (pid !== undefined && isRunning(pid)) process.kill(pid, 'SIGKILL')
        await shell.manager.closeAll().catch(() => undefined)
        removeTemporaryDirectory(cwd)
      }
    }, 15_000)

    it('leaves a nohup background job to the shell', async () => {
      const cwd = mkdtempSync(path.join(os.tmpdir(), 'harness-terminal-nohup-'))
      const shell = watchedShell(/NOHUP_READY (\d+)/)
      let job: number | undefined
      try {
        const terminalId = shell.manager.open('thread-nohup', cwd, 120, 24)
        shell.manager.write(terminalId, 'nohup sleep 30 >/dev/null 2>&1 & echo NOHUP_READY $!\r')
        job = await within(shell.match)
        // nohup ignores SIGHUP before it execs sleep; close only after that.
        await waitUntil(() => processName(job!) === 'sleep')

        await shell.manager.close(terminalId)

        expect(isRunning(job)).toBe(true)
      } finally {
        if (job !== undefined && isRunning(job)) process.kill(job, 'SIGKILL')
        await shell.manager.closeAll()
        removeTemporaryDirectory(cwd)
      }
    }, 15_000)
  })
})

/** A manager whose PTY output resolves `match` with the first number captured. */
function watchedShell(pattern: RegExp, options: { closeTimeoutMs?: number } = {}) {
  let output = ''
  let found: (value: number) => void = () => {}
  const match = new Promise<number>((resolve) => {
    found = resolve
  })
  const manager = new TerminalManager(
    {
      onOutput: (_terminalId, data) => {
        output += data
        const result = pattern.exec(output)
        if (result) found(Number(result[1]))
      },
      onExit: () => {},
    },
    options,
  )
  return { manager, match }
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  // An exited process stays visible to kill(pid, 0) until its new parent reaps it.
  const state = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' })
  return state.stdout.trim() !== '' && !state.stdout.trim().startsWith('Z')
}

function processName(pid: number): string {
  const name = spawnSync('ps', ['-o', 'comm=', '-p', String(pid)], { encoding: 'utf8' })
  return path.basename(name.stdout.trim())
}

async function waitUntil(done: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!done()) {
    if (Date.now() >= deadline) throw new Error('terminal test timed out')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

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

type Processes = NonNullable<
  NonNullable<ConstructorParameters<typeof TerminalManager>[1]>['processes']
>
type ProcessRow = ReturnType<Processes['inspect']>[number]

/** A process table in which every inspected pid is a shell this server forked. */
function fakeProcesses(table: Partial<Processes> = {}): Processes {
  return {
    inspect: (pids) => pids.map((pid) => ownShell(pid)),
    list: () => Promise.resolve([]),
    signal: () => {},
    ...table,
  }
}

/** What ps reports for a shell this server forked, with `foreground` holding its terminal. */
function ownShell(pid: number, foreground = 4242): ProcessRow {
  return {
    pid,
    parent: process.pid,
    group: pid,
    foreground,
    session: String(pid),
    leader: true,
    zombie: false,
  }
}

/** A live process in the job that the fake shell with pid 4100 leaves behind. */
const jobMember: ProcessRow = {
  pid: 4243,
  parent: 1,
  group: 4242,
  foreground: -1,
  session: '4100',
  leader: false,
  zombie: false,
}

function removeTemporaryDirectory(directory: string): void {
  rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
}

function controlledPty(options: { kill?: (signal?: string) => void; pid?: number } = {}): IPty & {
  emitData(data: string): void
  emitExit(exitCode: number): void
} {
  let onData: (data: string) => void = () => {}
  let onExit: (event: { exitCode: number; signal?: number }) => void = () => {}
  return {
    pid: options.pid ?? 1,
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
    kill: (signal) => options.kill?.(signal),
    pause: () => {},
    resume: () => {},
    emitData: (data) => onData(data),
    emitExit: (exitCode) => onExit({ exitCode }),
  }
}
