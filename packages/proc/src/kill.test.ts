import { ChildProcess, spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { killTree, spawnCli, spawnOwned } from './index.js'
import {
  setTaskkillLauncherForTests,
  stopUnfinishedTrees,
  unfinishedChildrenForTests,
} from './kill.js'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitForFile(file: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!existsSync(file)) {
    if (Date.now() >= deadline) throw new Error('test child did not start')
    await sleep(20)
  }
}

function heartbeat(file: string, ignoreTerm = false): string {
  return `const fs = require('node:fs'); ${ignoreTerm ? "process.on('SIGTERM', () => {});" : ''}
    const beat = () => fs.writeFileSync(${JSON.stringify(file)}, String(Date.now())); beat(); setInterval(beat, 30);`
}

async function waitUntilStill(file: string): Promise<void> {
  const deadline = Date.now() + 15_000
  let last = readFileSync(file, 'utf8')
  while (Date.now() < deadline) {
    await sleep(300)
    const now = readFileSync(file, 'utf8')
    if (now === last) return
    last = now
  }
  throw new Error('the process kept running')
}

describe('owned trees when their owner exits', () => {
  it.runIf(process.platform === 'win32')(
    'stops the CLI behind a running shim, which Node itself leaves alive',
    async () => {
      const directory = mkdtempSync(path.join(tmpdir(), 'harness-exit-tree-'))
      const file = path.join(directory, 'leaf')
      writeFileSync(path.join(directory, 'serve.cjs'), heartbeat(file))
      const shimFile = path.join(directory, 'fake-serve.cmd')
      writeFileSync(shimFile, `@echo off\r\n"${process.execPath}" "%~dp0serve.cjs" %*\r\n`)
      const child = spawnCli(shimFile, ['serve'])
      try {
        await waitForFile(file)
        stopUnfinishedTrees()
        await waitUntilStill(file)
      } finally {
        await killTree(child)
        rmSync(directory, { recursive: true, force: true })
      }
    },
    30_000,
  )

  it.runIf(process.platform === 'win32')(
    'stops the CLI behind a shim when the owning process exits while it runs',
    async () => {
      const directory = mkdtempSync(path.join(tmpdir(), 'harness-exit-owner-'))
      const file = path.join(directory, 'leaf')
      // Ends by itself after 20 s, so a failing run leaves nothing behind for long.
      writeFileSync(
        path.join(directory, 'serve.cjs'),
        `${heartbeat(file)} setTimeout(() => process.exit(0), 20_000);`,
      )
      const shimFile = path.join(directory, 'fake-serve.cmd')
      writeFileSync(shimFile, `@echo off\r\n"${process.execPath}" "%~dp0serve.cjs" %*\r\n`)
      // The owner exits as soon as the CLI runs, without stopping it first.
      const owner = path.join(directory, 'owner.mjs')
      writeFileSync(
        owner,
        `import { existsSync } from 'node:fs'
import { spawnOwned } from ${JSON.stringify(pathToFileURL(path.join(import.meta.dirname, 'kill.ts')).href)}
spawnOwned('cmd.exe', ['/d', '/s', '/c', ${JSON.stringify(`""${shimFile}""`)}], { stdio: 'pipe', windowsHide: true, windowsVerbatimArguments: true })
const wait = setInterval(() => { if (existsSync(${JSON.stringify(file)})) { clearInterval(wait); process.exit(0) } }, 20)
`,
      )
      try {
        const run = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', owner], {
          stdio: 'ignore',
          windowsHide: true,
        })
        expect((await once(run, 'exit'))[0]).toBe(0)
        await waitUntilStill(file)
      } finally {
        rmSync(directory, { recursive: true, force: true, maxRetries: 10 })
      }
    },
    40_000,
  )

  it.skipIf(process.platform === 'win32')('stops the groups it still owns', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'harness-exit-group-'))
    const file = path.join(directory, 'leaf')
    const child = spawnOwned(process.execPath, ['-e', heartbeat(file, true)], { stdio: 'pipe' })
    try {
      await waitForFile(file)
      stopUnfinishedTrees()
      await waitUntilStill(file)
    } finally {
      await killTree(child)
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('names only the children whose exit it has not seen', async () => {
    const done = spawnOwned(process.execPath, ['-e', ''], { stdio: 'pipe' })
    const running = spawnOwned(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'pipe',
    })
    try {
      await once(done, 'exit')
      expect(unfinishedChildrenForTests().has(done)).toBe(false)
      expect(unfinishedChildrenForTests().has(running)).toBe(true)
      const launches: string[][] = []
      if (process.platform === 'win32') {
        stopUnfinishedTrees((args) => launches.push(args))
        const pids = launches.flatMap((args) =>
          args.flatMap((arg, at) => (args[at - 1] === '/pid' ? [Number(arg)] : [])),
        )
        expect(pids).toContain(running.pid)
        expect(pids).not.toContain(done.pid)
        expect(launches.every((args) => args.at(-2) === '/T' && args.at(-1) === '/F')).toBe(true)
      }
    } finally {
      await killTree(running)
    }
    expect(unfinishedChildrenForTests().has(running)).toBe(false)
  })
})

describe('owned process tree termination', () => {
  it.runIf(process.platform === 'win32')(
    'keeps the event loop responsive while taskkill stops a tree',
    async () => {
      const directory = mkdtempSync(path.join(tmpdir(), 'harness-async-taskkill-'))
      const file = path.join(directory, 'leaf')
      const parent = `const { spawn } = require('node:child_process'); spawn(process.execPath, ['-e', ${JSON.stringify(heartbeat(file))}], { stdio: 'ignore' }); setInterval(() => {}, 1000);`
      const child = spawnCli(process.execPath, ['-e', parent])
      try {
        await waitForFile(file)
        // A synchronous taskkill blocks the loop for its whole run (about
        // 500 ms on Windows), which froze every stream on the server.
        let last = performance.now()
        let worstGap = 0
        const ticker = setInterval(() => {
          const now = performance.now()
          worstGap = Math.max(worstGap, now - last)
          last = now
        }, 5)
        const started = performance.now()
        await killTree(child)
        const elapsed = performance.now() - started
        clearInterval(ticker)
        expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
        expect(worstGap).toBeLessThan(Math.max(150, elapsed / 2))
      } finally {
        await killTree(child)
        rmSync(directory, { recursive: true, force: true })
      }
    },
  )

  it.runIf(process.platform === 'win32')(
    'stops the CLI behind a cmd shim, not only the shim',
    async () => {
      const directory = mkdtempSync(path.join(tmpdir(), 'harness-shim-tree-'))
      const file = path.join(directory, 'leaf')
      writeFileSync(path.join(directory, 'serve.cjs'), heartbeat(file))
      const shimFile = path.join(directory, 'fake-serve.cmd')
      writeFileSync(shimFile, `@echo off\r\n"${process.execPath}" "%~dp0serve.cjs" %*\r\n`)
      const child = spawnCli(shimFile, ['serve'])
      try {
        await waitForFile(file)
        await killTree(child)
        const stopped = readFileSync(file, 'utf8')
        await sleep(300)
        expect(readFileSync(file, 'utf8')).toBe(stopped)
      } finally {
        await killTree(child)
        rmSync(directory, { recursive: true, force: true })
      }
    },
  )

  it.skipIf(process.platform === 'win32')(
    'stops grandchildren after their leader exits and leaves another group alive',
    async () => {
      const directory = mkdtempSync(path.join(tmpdir(), 'harness-owned-tree-'))
      const leafFile = path.join(directory, 'leaf')
      const otherFile = path.join(directory, 'other')
      const leaf = heartbeat(leafFile, true)
      const middle = `const { spawn } = require('node:child_process'); spawn(process.execPath, ['-e', ${JSON.stringify(leaf)}], { stdio: 'ignore' }); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);`
      const parent = `const { spawn } = require('node:child_process'); const fs = require('node:fs'); const child = spawn(process.execPath, ['-e', ${JSON.stringify(middle)}], { stdio: 'ignore' }); child.unref(); const ready = setInterval(() => { if (fs.existsSync(${JSON.stringify(leafFile)})) clearInterval(ready) }, 10);`
      const child = spawnCli(process.execPath, ['-e', parent])
      const other = spawnOwned(process.execPath, ['-e', heartbeat(otherFile)], { stdio: 'pipe' })
      try {
        await once(child, 'exit')
        await Promise.all([waitForFile(leafFile), waitForFile(otherFile)])
        await killTree(child)
        const stopped = readFileSync(leafFile, 'utf8')
        const unrelated = readFileSync(otherFile, 'utf8')
        await sleep(150)
        expect(readFileSync(leafFile, 'utf8')).toBe(stopped)
        expect(readFileSync(otherFile, 'utf8')).not.toBe(unrelated)
      } finally {
        await Promise.all([killTree(child), killTree(other)])
        rmSync(directory, { recursive: true, force: true })
      }
    },
  )

  it('stops a live parent and its child before completion', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'harness-live-tree-'))
    const file = path.join(directory, 'leaf')
    const parent = `const { spawn } = require('node:child_process'); spawn(process.execPath, ['-e', ${JSON.stringify(heartbeat(file))}], { stdio: 'ignore' }); setInterval(() => {}, 1000);`
    const child = spawnCli(process.execPath, ['-e', parent])
    try {
      await waitForFile(file)
      await killTree(child)
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
      const stopped = readFileSync(file, 'utf8')
      await sleep(150)
      expect(readFileSync(file, 'utf8')).toBe(stopped)
    } finally {
      await killTree(child)
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')(
    'rejects a surviving owned group and permits a cleanup retry',
    async () => {
      const child = spawnOwned(process.execPath, ['-e', 'setInterval(() => {}, 1000)'])
      const realKill = process.kill.bind(process)
      const signal = vi.spyOn(process, 'kill').mockImplementation((pid, value) => {
        if (pid === -child.pid! && value !== 0) return true
        return realKill(pid, value)
      })
      try {
        await expect(killTree(child)).rejects.toThrow('did not stop')
        expect(child.exitCode).toBeNull()
      } finally {
        signal.mockRestore()
        await killTree(child)
      }
      expect(child.signalCode).not.toBeNull()
    },
  )

  it.skipIf(process.platform === 'win32')(
    'does not treat permission-denied probes as a stopped group',
    async () => {
      const child = spawnOwned(process.execPath, ['-e', 'setInterval(() => {}, 1000)'])
      const realKill = process.kill.bind(process)
      const signal = vi.spyOn(process, 'kill').mockImplementation((pid, value) => {
        if (pid === -child.pid!) throw Object.assign(new Error('denied'), { code: 'EPERM' })
        return realKill(pid, value)
      })
      try {
        await expect(killTree(child)).rejects.toMatchObject({ code: 'EPERM' })
      } finally {
        signal.mockRestore()
        await killTree(child)
      }
    },
  )

  it('rejects an unregistered child that never confirms exit', async () => {
    vi.useFakeTimers()
    // On Windows both taskkill runs fail before the child itself is signalled.
    setTaskkillLauncherForTests(() => ({ exit: Promise.resolve(128), release: () => undefined }))
    const kill = vi.fn(() => true)
    const child = { pid: 1, exitCode: null as number | null, signalCode: null, kill }
    try {
      const stopped = expect(killTree(child)).rejects.toThrow('did not exit')
      await vi.advanceTimersByTimeAsync(3100)
      await stopped
      expect(kill.mock.calls).toHaveLength(2)
      child.exitCode = 0
      await expect(killTree(child)).resolves.toBeUndefined()
    } finally {
      setTaskkillLauncherForTests()
      vi.useRealTimers()
    }
  })

  it('does not signal an unspawned native handle with no pid', async () => {
    const child = new ChildProcess()
    expect(child.pid).toBeUndefined()
    await expect(killTree(child)).resolves.toBeUndefined()
  })

  it('does not infer a process group from an unregistered child pid', async () => {
    const kill = vi.fn(() => true)
    const child = { pid: undefined, exitCode: null, signalCode: null, kill }
    await killTree(child)
    expect(kill).toHaveBeenCalledTimes(1)
  })
})

describe('Windows tree termination', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
    vi.useFakeTimers()
  })

  afterEach(() => {
    setTaskkillLauncherForTests()
    vi.useRealTimers()
    Object.defineProperty(process, 'platform', platform)
  })

  /** A cmd.exe shim that only exits when taskkill, or its own kill(), stops it. */
  function shim() {
    const child = {
      pid: 4242,
      exitCode: null as number | null,
      signalCode: null,
      kill: vi.fn((): boolean => {
        child.exitCode = 1
        return true
      }),
    }
    return child
  }

  /** taskkill runs that exit after the given delay with the given code, or never. */
  function taskkill(child: ReturnType<typeof shim>, plan: Array<[number, number] | 'never'>) {
    const released: boolean[] = []
    const launch = vi.fn((_pid: number) => {
      const index = launch.mock.calls.length - 1
      const step = plan[index] ?? 'never'
      released[index] = false
      const exit =
        step === 'never'
          ? new Promise<number | null>(() => undefined)
          : new Promise<number | null>((resolve) =>
              setTimeout(() => {
                if (step[1] === 0) child.exitCode = 1
                resolve(step[1])
              }, step[0]),
            )
      return { exit, release: () => (released[index] = true) }
    })
    setTaskkillLauncherForTests(launch)
    return { launch, released }
  }

  it('stops the tree with one taskkill when it answers in time', async () => {
    const child = shim()
    const { launch } = taskkill(child, [[400, 0]])
    const stopped = killTree(child)
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(stopped).resolves.toBeUndefined()
    expect(launch).toHaveBeenCalledTimes(1)
    expect(launch).toHaveBeenCalledWith(4242)
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('never kills the shim while a slow taskkill still walks the tree', async () => {
    const child = shim()
    const { launch, released } = taskkill(child, [[8_000, 0], 'never'])
    const stopped = killTree(child)
    await vi.advanceTimersByTimeAsync(4_999)
    expect(launch).toHaveBeenCalledTimes(1)
    // The first run is slow, not dead: a second one joins it instead of replacing it.
    await vi.advanceTimersByTimeAsync(1)
    expect(launch).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(3_000)
    await expect(stopped).resolves.toBeUndefined()
    expect(child.kill).not.toHaveBeenCalled()
    expect(released).toEqual([false, false])
  })

  it('kills the shim itself only after every taskkill run failed', async () => {
    const child = shim()
    const { launch } = taskkill(child, [
      [100, 1],
      [100, 128],
    ])
    const stopped = killTree(child)
    await vi.advanceTimersByTimeAsync(150)
    expect(launch).toHaveBeenCalledTimes(2)
    expect(child.kill).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(100)
    await expect(stopped).resolves.toBeUndefined()
    expect(child.kill).toHaveBeenCalledTimes(1)
  })

  it('leaves a stuck taskkill to finish instead of orphaning the tree', async () => {
    const child = shim()
    const { released } = taskkill(child, ['never', 'never'])
    const stopped = killTree(child)
    await vi.advanceTimersByTimeAsync(15_000)
    await expect(stopped).resolves.toBeUndefined()
    expect(child.kill).not.toHaveBeenCalled()
    expect(released).toEqual([true, true])
  })

  it('kills the shim once runs that outlived the budget have all failed', async () => {
    const child = shim()
    taskkill(child, [
      [20_000, 1],
      [21_000, 1],
    ])
    const stopped = killTree(child)
    await vi.advanceTimersByTimeAsync(15_000)
    await expect(stopped).resolves.toBeUndefined()
    expect(child.kill).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(child.kill).toHaveBeenCalledTimes(1)
  })
})
