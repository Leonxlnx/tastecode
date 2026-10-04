import { ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { killTree, spawnCli, spawnOwned } from './index.js'

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
})
