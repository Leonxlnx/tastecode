import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  gpuFallbackRequested,
  isGpuProcessFailure,
  shouldFallbackToSoftware,
  writeGpuFallbackFlag,
} from './gpu-fallback.js'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function tempUserData(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'gpu-fallback-'))
  dirs.push(dir)
  return dir
}

describe('isGpuProcessFailure', () => {
  it('counts real GPU failures', () => {
    for (const reason of ['crashed', 'abnormal-exit', 'launch-failed', 'oom']) {
      expect(isGpuProcessFailure({ type: 'GPU', reason })).toBe(true)
    }
  })

  it('ignores clean exits, kills and other process types', () => {
    expect(isGpuProcessFailure({ type: 'GPU', reason: 'clean-exit' })).toBe(false)
    expect(isGpuProcessFailure({ type: 'GPU', reason: 'killed' })).toBe(false)
    expect(isGpuProcessFailure({ type: 'Renderer', reason: 'crashed' })).toBe(false)
    expect(isGpuProcessFailure({ type: 'GPU' })).toBe(false)
  })
})

describe('shouldFallbackToSoftware', () => {
  const now = 1_000_000

  it('returns true at the limit inside the window', () => {
    expect(shouldFallbackToSoftware([now - 10_000, now - 5_000], now)).toBe(true)
  })

  it('returns false below the limit', () => {
    expect(shouldFallbackToSoftware([now - 5_000], now)).toBe(false)
    expect(shouldFallbackToSoftware([], now)).toBe(false)
  })

  it('expires failures outside the window', () => {
    expect(shouldFallbackToSoftware([now - 120_000, now - 5_000], now)).toBe(false)
  })

  it('supports a third strike after old failures expire', () => {
    const failures = [now - 90_000, now - 30_000, now - 1_000]
    expect(shouldFallbackToSoftware(failures, now)).toBe(true)
  })
})

describe('gpuFallbackRequested', () => {
  it('returns false when no flag exists', async () => {
    expect(gpuFallbackRequested(await tempUserData())).toBe(false)
  })

  it('round-trips the written flag', async () => {
    const dir = await tempUserData()
    await writeGpuFallbackFlag(dir)
    expect(gpuFallbackRequested(dir)).toBe(true)
    const raw = JSON.parse(await readFile(path.join(dir, 'gpu-fallback.json'), 'utf8'))
    expect(raw).toEqual({ softwareRendering: true })
  })

  it('returns false on corrupt content instead of throwing', async () => {
    const dir = await tempUserData()
    const { writeFile: write } = await import('node:fs/promises')
    await write(path.join(dir, 'gpu-fallback.json'), '{not json', 'utf8')
    expect(gpuFallbackRequested(dir)).toBe(false)
  })
})
