import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HarnessBridge } from './preload.js'

const { exposeInMainWorld, getPathForFile, invoke, on, send, sendSync, serverListens } = vi.hoisted(
  () => {
    let serverListens!: () => void
    const listening = new Promise<void>((resolve) => {
      serverListens = resolve
    })
    return {
      exposeInMainWorld: vi.fn(),
      getPathForFile: vi.fn(),
      invoke: vi.fn((channel: string) =>
        channel === 'harness:ownServerListening'
          ? listening
          : channel === 'harness:getAccessibilitySupport'
            ? Promise.resolve(false)
            : undefined,
      ),
      on: vi.fn(),
      send: vi.fn(),
      sendSync: vi.fn((channel: string) =>
        channel === 'harness:ownServerToken' ? 'dGhpcy1pcy1hLXRva2VuLWZvci10ZXN0cw' : undefined,
      ),
      serverListens,
    }
  },
)
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld },
  ipcRenderer: { invoke, send, sendSync, on, removeListener: vi.fn() },
  webUtils: { getPathForFile },
}))

await import('./preload.js')
const api = exposeInMainWorld.mock.calls[0]![1] as HarnessBridge

describe('preload own-server token', () => {
  it('asks main once, before the page connects, and exposes the answer', () => {
    expect(sendSync).toHaveBeenCalledExactlyOnceWith('harness:ownServerToken')
    expect(api.ownServerToken).toBe('dGhpcy1pcy1hLXRva2VuLWZvci10ZXN0cw')
  })
})

const listeningCalls = () =>
  invoke.mock.calls.filter(([channel]) => channel === 'harness:ownServerListening')

describe('preload accessibility support', () => {
  it('takes the answer from main at load, then follows its changes', async () => {
    const changed = on.mock.calls.find(
      ([channel]) => channel === 'harness:accessibilitySupportChanged',
    )?.[1] as (event: unknown, enabled: unknown) => void
    const seen: boolean[] = []
    const off = api.onAccessibilitySupportChange((enabled) => seen.push(enabled))

    expect(invoke).toHaveBeenCalledWith('harness:getAccessibilitySupport')
    await vi.waitFor(() => expect(api.accessibilitySupportEnabled()).toBe(false))
    changed({}, true)
    changed({}, 'yes')
    expect(api.accessibilitySupportEnabled()).toBe(true)
    off()
    changed({}, false)

    expect(seen).toEqual([true])
    expect(api.accessibilitySupportEnabled()).toBe(false)
  })
})

describe('preload own-server listening', () => {
  it('asks main once, at load, and settles for the page only when main answers', async () => {
    expect(listeningCalls()).toHaveLength(1)
    let settled = false
    const listening = api.ownServerListening!().then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    serverListens()
    await listening
    expect(settled).toBe(true)
    expect(listeningCalls()).toHaveLength(1)
  })
})

describe('preload dropped files', () => {
  beforeEach(() => {
    getPathForFile.mockReset()
    invoke.mockReset()
    send.mockReset()
  })

  it('asks main to preview the native path of a dropped File', () => {
    const dropped = new File(['png'], 'photo.png')
    getPathForFile.mockImplementation((file: File) =>
      file === dropped ? 'C:\\Users\\Test\\photo.png' : '',
    )
    expect(api.droppedFilePath(dropped)).toBe('C:\\Users\\Test\\photo.png')
    expect(send).toHaveBeenCalledExactlyOnceWith(
      'harness:droppedFile',
      'C:\\Users\\Test\\photo.png',
    )
  })

  it('sends no grant for a File the page made or a path string it names', async () => {
    getPathForFile.mockReturnValue('')
    expect(api.droppedFilePath(new File(['png'], 'C:\\Users\\Test\\private.png'))).toBeUndefined()
    await api.previewViewedImage('C:\\Users\\Test\\private.png')
    expect(send).not.toHaveBeenCalled()
    expect(invoke).toHaveBeenCalledExactlyOnceWith(
      'harness:previewViewedImage',
      'C:\\Users\\Test\\private.png',
    )
  })
})
