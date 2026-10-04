import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { claudeSdkSpawner } from './sdk-runtime.js'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('Claude SDK process ownership', () => {
  it('stops descendants when the SDK calls the returned process kill method', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'harness-sdk-tree-'))
    const marker = path.join(directory, 'heartbeat')
    const leaf = `const fs = require('node:fs'); process.on('SIGTERM', () => {}); const beat = () => fs.writeFileSync(${JSON.stringify(marker)}, String(Date.now())); beat(); setInterval(beat, 30);`
    const script = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(leaf)}], { stdio: 'ignore' }); setInterval(() => {}, 1000);`
    const stopped: Promise<void>[] = []
    const child = claudeSdkSpawner(undefined, undefined, (done) => stopped.push(done))({
      command: process.execPath,
      args: ['-e', script],
      cwd: directory,
      env: process.env,
      signal: new AbortController().signal,
    })
    child.stdout.resume()
    try {
      const deadline = Date.now() + 5000
      while (!existsSync(marker)) {
        if (Date.now() >= deadline) throw new Error('SDK test child did not start')
        await sleep(20)
      }
      child.kill('SIGTERM')
      await Promise.all(stopped)
      const last = readFileSync(marker, 'utf8')
      await sleep(150)
      expect(readFileSync(marker, 'utf8')).toBe(last)
    } finally {
      child.kill('SIGKILL')
      await Promise.all(stopped)
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
