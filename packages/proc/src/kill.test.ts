import { ChildProcess, spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  cleanupExitedPtySession,
  killTree,
  ownPtySession,
  spawnCli,
  spawnOwned,
  terminatePtySession,
} from './index.js'

// One-shot stale /proc stat reads. A test arms a member pid and the very next
// read of its stat reports a different start time — the generation change a
// reused pid produces between the member scan and the signal recheck.
const staleProcStat = vi.hoisted(() => ({ pid: undefined as number | undefined }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const intercepted: typeof actual.readFileSync = ((target: unknown, options: unknown) => {
    const value = (actual.readFileSync as (file: unknown, options?: unknown) => unknown)(
      target,
      options,
    )
    if (
      staleProcStat.pid !== undefined &&
      target === `/proc/${staleProcStat.pid}/stat` &&
      typeof value === 'string'
    ) {
      staleProcStat.pid = undefined
      const commandEnd = value.lastIndexOf(')')
      const fields = value.slice(commandEnd + 2).split(' ')
      fields[19] = `${fields[19]}0`
      return value.slice(0, commandEnd + 2) + fields.join(' ')
    }
    return value
  }) as typeof actual.readFileSync
  return { ...actual, readFileSync: intercepted, default: { ...actual, readFileSync: intercepted } }
})

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

describe('owned process tree termination', () => {
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

  it.skipIf(process.platform === 'win32')(
    'does not signal an unregistered child that already exited',
    async () => {
      const kill = vi.fn(() => true)
      await killTree({ pid: 1, exitCode: 0, signalCode: null, kill })
      expect(kill).not.toHaveBeenCalled()
    },
  )

  it.runIf(process.platform === 'win32')(
    'taskkills a tree whose .cmd shim already exited',
    async () => {
      const directory = mkdtempSync(path.join(tmpdir(), 'harness-win-tree-'))
      const beatFile = path.join(directory, 'beat')
      const script = path.join(directory, 'grandchild.cjs')
      writeFileSync(
        script,
        `const fs = require('node:fs'); setInterval(() => fs.appendFileSync(${JSON.stringify(beatFile)}, 'x'), 30);`,
      )
      // The cmd.exe shim starts a background grandchild and exits on its own,
      // which used to orphan the whole tree on Windows.
      const child = spawnOwned('cmd.exe', [
        '/d',
        '/s',
        '/c',
        `start "" /b "${process.execPath}" "${script}"`,
      ])
      try {
        await once(child, 'exit')
        await waitForFile(beatFile)
        await killTree(child)
        const stopped = readFileSync(beatFile, 'utf8')
        await sleep(200)
        expect(readFileSync(beatFile, 'utf8')).toBe(stopped)
      } finally {
        await killTree(child)
        rmSync(directory, { recursive: true, force: true })
      }
    },
  )

  it('rejects an unregistered child that never confirms exit', async () => {
    vi.useFakeTimers()
    const kill = vi.fn(() => true)
    const child = { pid: 1, exitCode: null as number | null, signalCode: null, kill }
    try {
      const stopped = expect(killTree(child)).rejects.toThrow('did not exit')
      await vi.advanceTimersByTimeAsync(1600)
      await stopped
      expect(kill.mock.calls).toHaveLength(2)
      child.exitCode = 0
      await expect(killTree(child)).resolves.toBeUndefined()
    } finally {
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

  it.runIf(process.platform === 'linux')(
    'falls back to leader-only teardown when PTY session setup never completes',
    async () => {
      // A plain child stays in this process's group and session, so it can
      // never become the session leader ownPtySession waits for — the same
      // state forkpty() leaves behind when setsid() never finishes.
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'])
      const kill = vi.fn(() => child.kill('SIGKILL'))
      const pty = { pid: child.pid!, kill }
      try {
        ownPtySession(pty)
        await expect(terminatePtySession(pty)).resolves.toBeUndefined()
        expect(kill).toHaveBeenCalled()
        // The failed ownership entry is dropped instead of rethrowing
        // forever, so later cleanup and termination converge.
        await expect(cleanupExitedPtySession(pty)).resolves.toBeUndefined()
        await expect(terminatePtySession(pty)).resolves.toBeUndefined()
      } finally {
        child.kill('SIGKILL')
      }
    },
  )

  it.runIf(process.platform !== 'win32')(
    'escalates an unowned PTY leader that ignores SIGHUP to SIGKILL',
    async () => {
      const child = spawn(process.execPath, [
        '-e',
        "process.on('SIGHUP', () => {}); setInterval(() => {}, 1000)",
      ])
      // A no-op kill() stands in for node-pty's SIGHUP, which the leader
      // above ignores.
      const pty = { pid: child.pid!, kill: vi.fn() }
      const exited = once(child, 'exit')
      try {
        await terminatePtySession(pty)
        expect(pty.kill).toHaveBeenCalledOnce()
        await exited
        expect(child.signalCode).toBe('SIGKILL')
      } finally {
        child.kill('SIGKILL')
      }
    },
  )

  it.runIf(process.platform !== 'win32')(
    'does not escalate an unowned PTY leader that exits on its own',
    async () => {
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'])
      const pty = { pid: child.pid!, kill: vi.fn(() => void child.kill('SIGTERM')) }
      const signals = vi.spyOn(process, 'kill')
      try {
        await terminatePtySession(pty)
        const escalations = signals.mock.calls.filter(
          ([pid, signal]) => pid === child.pid && signal === 'SIGKILL',
        )
        expect(escalations).toHaveLength(0)
      } finally {
        signals.mockRestore()
        child.kill('SIGKILL')
      }
    },
  )

  it.runIf(process.platform === 'linux')(
    'proves a PTY session that finished setsid after the setup deadline',
    async () => {
      const directory = mkdtempSync(path.join(tmpdir(), 'harness-late-setsid-'))
      const memberFile = path.join(directory, 'member')
      const script = path.join(directory, 'member.cjs')
      writeFileSync(script, sessionMember(memberFile))
      try {
        // The shim stays a plain child past PTY_SESSION_SETUP_TIMEOUT_MS
        // (250ms) and only then execs setsid, so the first establishment
        // attempt fails and teardown must re-verify the live leader.
        const child = spawn('sh', [
          '-c',
          `sleep 0.4; exec setsid ${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`,
        ])
        const pty = { pid: child.pid!, kill: vi.fn() }
        const exited = once(child, 'exit')
        ownPtySession(pty)
        await waitForFile(memberFile)
        const memberPid = Number(readFileSync(memberFile, 'utf8'))
        await expect(terminatePtySession(pty)).resolves.toBeUndefined()
        // The late-proved session took the owned sweep path: the leader died
        // by signal and its session member was swept with it.
        expect(pty.kill).not.toHaveBeenCalled()
        await exited
        expect(child.signalCode).toBe('SIGKILL')
        expect(await waitForPidExit(memberPid)).toBe(true)
        // The upgraded entry keeps later cleanup on the owned path instead
        // of rethrowing the stale setup failure.
        await expect(cleanupExitedPtySession(pty)).resolves.toBeUndefined()
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    },
  )

  it.runIf(process.platform === 'linux')(
    'skips a session member replaced by a new generation mid-sweep',
    async () => {
      const directory = mkdtempSync(path.join(tmpdir(), 'harness-stale-member-'))
      const memberFile = path.join(directory, 'member')
      const member = sessionMember(memberFile)
      // setsid(1) execs the payload in a new session without changing pid,
      // giving ownPtySession an immediately provable session leader.
      const child = spawn('setsid', [process.execPath, '-e', member])
      const pty = { pid: child.pid!, kill: vi.fn() }
      const exited = once(child, 'exit')
      try {
        ownPtySession(pty)
        await waitForFile(memberFile)
        const memberPid = Number(readFileSync(memberFile, 'utf8'))
        // The member's next stat read reports a different generation, as if
        // its pid was reused between the scan and the signal. The sweep must
        // skip that entry, rescan, and still finish the session.
        staleProcStat.pid = memberPid
        await expect(terminatePtySession(pty)).resolves.toBeUndefined()
        expect(pty.kill).not.toHaveBeenCalled()
        await exited
        expect(child.signalCode).toBe('SIGKILL')
        expect(await waitForPidExit(memberPid)).toBe(true)
      } finally {
        staleProcStat.pid = undefined
        child.kill('SIGKILL')
        rmSync(directory, { recursive: true, force: true })
      }
    },
  )
})

/** A session leader that spawns one long-lived member and records its pid. */
function sessionMember(memberFile: string): string {
  return `const cp = require('node:child_process'); const fs = require('node:fs');
    const member = cp.spawn('sleep', ['30'], { stdio: 'ignore' });
    fs.writeFileSync(${JSON.stringify(memberFile)}, String(member.pid));
    setInterval(() => {}, 1000);`
}

/** Resolves true once a pid is gone or an unreaped zombie on Linux. */
async function waitForPidExit(pid: number): Promise<boolean> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      const state = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0]
      if (state === 'Z' || state === 'X') return true
    } catch {
      return true
    }
    await sleep(20)
  }
  return false
}
