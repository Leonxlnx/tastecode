import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HarnessBridge } from './preload.js'

const { exposeInMainWorld, getPathForFile, invoke, send } = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  getPathForFile: vi.fn(),
  invoke: vi.fn(),
  send: vi.fn(),
}))
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld },
  ipcRenderer: { invoke, send, on: vi.fn(), removeListener: vi.fn() },
  webUtils: { getPathForFile },
}))

await import('./preload.js')
const api = exposeInMainWorld.mock.calls[0]![1] as HarnessBridge

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
