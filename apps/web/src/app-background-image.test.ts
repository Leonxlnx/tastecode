// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  backgroundDisplayImage,
  displayImageVersion,
  prepareBackgroundImage,
  type BackgroundImageStore,
  type StoredBackgroundImage,
} from './app-background-image.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

/** An in-memory store whose saveDisplay keeps the contract of the IndexedDB one. */
function memoryStore(initial: StoredBackgroundImage | undefined) {
  let record = initial
  const store: BackgroundImageStore = {
    load: async () => record,
    save: async (image) => {
      record = image
    },
    saveDisplay: async (image) => {
      if (!record || record.id !== image.id) return false
      record = image
      return true
    },
    clear: async () => {
      record = undefined
    },
  }
  return { store, current: () => record }
}

/**
 * Canvas stand-ins: decoding always works, and every encode waits until the
 * test releases it, so a test can act while a rebuild is still encoding.
 */
function stubCanvas() {
  const pending: Array<() => void> = []
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => ({ width: 3200, height: 1800, close: () => undefined })),
  )
  vi.stubGlobal(
    'OffscreenCanvas',
    class {
      getContext() {
        return { filter: 'none', drawImage: () => undefined }
      }
      convertToBlob(options: { type: string }) {
        return new Promise<Blob>((resolve) =>
          pending.push(() => resolve(new Blob(['encoded'], { type: options.type }))),
        )
      }
    },
  )
  return {
    /** Lets every encode started so far finish. */
    async finishEncoding() {
      await vi.waitFor(() => expect(pending.length).toBeGreaterThan(0))
      for (const finish of pending.splice(0)) finish()
    },
  }
}

function picture(id: string | undefined, blur: number): StoredBackgroundImage {
  return {
    id,
    original: new Blob([`original ${id}`], { type: 'image/webp' }),
    display: new Blob([`display ${id}`], { type: 'image/webp' }),
    displayVersion: displayImageVersion(blur),
  }
}

describe('backgroundDisplayImage', () => {
  it('keeps the rebuilt display copy when the picture is unchanged', async () => {
    const canvas = stubCanvas()
    const old = picture('a', 14)
    const { store, current } = memoryStore(old)

    const rebuilt = backgroundDisplayImage(old, store, 30)
    await canvas.finishEncoding()
    const display = await rebuilt

    expect(current()).toEqual({ ...old, display, displayVersion: displayImageVersion(30) })
  })

  it('rebuilds a picture stored before pictures had an id', async () => {
    const canvas = stubCanvas()
    const legacy = picture(undefined, 14)
    const { store, current } = memoryStore(legacy)

    const rebuilt = backgroundDisplayImage(legacy, store, 30)
    await canvas.finishEncoding()
    await rebuilt

    expect(current()?.displayVersion).toBe(displayImageVersion(30))
    expect(current()?.original).toBe(legacy.original)
  })

  it('never writes the old picture over one chosen during the rebuild', async () => {
    const canvas = stubCanvas()
    const old = picture('a', 14)
    const { store, current } = memoryStore(old)

    const rebuilt = backgroundDisplayImage(old, store, 30)
    const chosen = picture('b', 30)
    await store.save(chosen)
    await canvas.finishEncoding()
    await rebuilt

    expect(current()).toBe(chosen)
  })

  it('never brings back a picture removed during the rebuild', async () => {
    const canvas = stubCanvas()
    const old = picture('a', 14)
    const { store, current } = memoryStore(old)

    const rebuilt = backgroundDisplayImage(old, store, 30)
    await store.clear()
    await canvas.finishEncoding()
    await rebuilt

    expect(current()).toBeUndefined()
  })

  it('returns the stored display copy without a rebuild when it is current', async () => {
    const old = picture('a', 30)
    const { store } = memoryStore(old)
    const saveDisplay = vi.spyOn(store, 'saveDisplay')

    await expect(backgroundDisplayImage(old, store, 30)).resolves.toBe(old.display)
    expect(saveDisplay).not.toHaveBeenCalled()
  })
})

describe('prepareBackgroundImage', () => {
  it('names every prepared picture differently', async () => {
    const canvas = stubCanvas()
    const file = new File(['pixels'], 'photo.png', { type: 'image/png' })

    const first = prepareBackgroundImage(file)
    await canvas.finishEncoding()
    await canvas.finishEncoding()
    const second = prepareBackgroundImage(file)
    await canvas.finishEncoding()
    await canvas.finishEncoding()

    const ids = [(await first).id, (await second).id]
    expect(ids[0]).toEqual(expect.any(String))
    expect(ids[1]).toEqual(expect.any(String))
    expect(ids[0]).not.toBe(ids[1])
  })
})
