import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawnCli } from '@harness/proc/cli'
import { killTree } from '@harness/proc/kill'
import { runGh } from './pull-requests.js'

vi.mock('@harness/proc/cli', () => ({ spawnCli: vi.fn(), isInstalled: vi.fn() }))
vi.mock('@harness/proc/kill', () => ({ killTree: vi.fn(async () => {}) }))
afterEach(() => {
  vi.clearAllMocks()
  vi.useRealTimers()
})

function processFixture() {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new PassThrough(),
  })
  vi.mocked(spawnCli).mockReturnValue(child as ReturnType<typeof spawnCli>)
  return child
}

describe('GitHub CLI binary image output', () => {
  it('preserves non-UTF8 and split binary bytes', async () => {
    const child = processFixture()
    const output = runGh(['api', 'https://github.com/user-attachments/assets/example'], {
      encoding: 'base64',
    })
    const bytes = Buffer.from([0, 255, 137, 80, 78, 71, 13, 10, 128])
    child.stdout.write(bytes.subarray(0, 3))
    child.stdout.write(bytes.subarray(3))
    child.emit('close', 0)
    expect(Buffer.from(await output, 'base64')).toEqual(bytes)
    expect(killTree).toHaveBeenCalledOnce()
  })

  it('keeps the existing UTF8 output behavior', async () => {
    const child = processFixture()
    const output = runGh(['api', 'user'])
    const bytes = Buffer.from('{"name":"é"}')
    child.stdout.write(bytes.subarray(0, 10))
    child.stdout.write(bytes.subarray(10))
    child.emit('close', 0)
    expect(await output).toBe('{"name":"é"}')
  })

  it('kills oversized and timed-out binary reads', async () => {
    vi.useFakeTimers()
    const child = processFixture()
    const output = runGh(['api', 'image'], { encoding: 'base64', maxBytes: 8 })
    child.stdout.write(Buffer.alloc(9))
    await expect(output).rejects.toThrow('too large')
    processFixture()
    const pending = runGh(['api', 'image'], { encoding: 'base64', timeoutMs: 5 })
    const rejection = expect(pending).rejects.toThrow('did not respond')
    await vi.advanceTimersByTimeAsync(6)
    await rejection
    expect(killTree).toHaveBeenCalledTimes(2)
  })
})
