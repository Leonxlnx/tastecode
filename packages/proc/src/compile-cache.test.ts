import { afterEach, describe, expect, it, vi } from 'vitest'
import { enableCompileCache } from './compile-cache.js'

const statuses = { FAILED: 0, ENABLED: 1, ALREADY_ENABLED: 2, DISABLED: 3 }

function runtime(status: number | (() => never)) {
  return {
    enableCompileCache: vi.fn((_directory: string) =>
      typeof status === 'function' ? status() : { status },
    ),
    flushCompileCache: vi.fn(),
    constants: { compileCacheStatus: statuses },
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('enableCompileCache', () => {
  it('turns the cache on in the folder and writes it once startup has settled', () => {
    vi.useFakeTimers()
    const node = runtime(statuses.ENABLED)
    expect(enableCompileCache('C:\\data\\node-compile-cache', node)).toBe(true)
    expect(node.enableCompileCache).toHaveBeenCalledWith('C:\\data\\node-compile-cache')
    vi.advanceTimersByTime(9_999)
    expect(node.flushCompileCache).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(node.flushCompileCache).toHaveBeenCalledOnce()
  })

  it('accepts a cache that NODE_COMPILE_CACHE already turned on', () => {
    expect(enableCompileCache('cache', runtime(statuses.ALREADY_ENABLED))).toBe(true)
  })

  it.each([
    ['a folder Node could not use', runtime(statuses.FAILED)],
    ['a cache switched off by NODE_DISABLE_COMPILE_CACHE', runtime(statuses.DISABLED)],
    [
      'a runtime that throws',
      runtime(() => {
        throw new Error('EACCES')
      }),
    ],
    ['a runtime without the API', {}],
  ])('leaves loading unchanged for %s', (_case, node) => {
    vi.useFakeTimers()
    expect(enableCompileCache('cache', node)).toBe(false)
    vi.runAllTimers()
    if ('flushCompileCache' in node) expect(node.flushCompileCache).not.toHaveBeenCalled()
  })

  it('never lets a failed write reach the process', () => {
    vi.useFakeTimers()
    const node = runtime(statuses.ENABLED)
    node.flushCompileCache.mockImplementation(() => {
      throw new Error('ENOSPC')
    })
    enableCompileCache('cache', node)
    expect(() => vi.runAllTimers()).not.toThrow()
  })
})
