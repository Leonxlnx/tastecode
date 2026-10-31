// @vitest-environment happy-dom
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DISPLAY_IMAGE_VERSION, type BackgroundImageStore } from '../app-background-image.js'

afterEach(async () => {
  cleanup()
  localStorage.clear()
  delete window.harness
  const { resetAppBackgroundForTests } = await import('../app-background.js')
  resetAppBackgroundForTests()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.resetModules()
})

function root() {
  return document.documentElement.dataset
}

describe('AppBackground in the browser shell', () => {
  it('adds nothing to the page with None', async () => {
    const { AppBackground } = await import('./AppBackground.js')
    const { container } = render(<AppBackground />)
    expect(container.innerHTML).toBe('')
    expect(root()['appBg']).toBeUndefined()
  })

  it('paints the chosen effect behind the window and removes it again', async () => {
    const { AppBackground } = await import('./AppBackground.js')
    const { writeAppBackground } = await import('../app-background.js')
    const { container } = render(<AppBackground />)

    act(() => writeAppBackground({ mode: 'effect', effect: 'aurora' }))
    const layer = await waitFor(() => {
      const element = container.querySelector<HTMLElement>('.app-bg')
      expect(element).not.toBeNull()
      return element!
    })
    expect(layer.dataset['mode']).toBe('effect')
    expect(layer.dataset['effect']).toBe('aurora')
    expect(layer.getAttribute('aria-hidden')).toBe('true')
    expect(root()['appBg']).toBe('effect')
    expect(root()['appBgEffect']).toBe('aurora')

    act(() => writeAppBackground({ effect: 'grain' }))
    expect(layer.dataset['effect']).toBe('grain')
    expect(root()['appBgEffect']).toBe('grain')

    act(() => writeAppBackground({ mode: 'none' }))
    expect(container.querySelector('.app-bg')).toBeNull()
    expect(root()['appBg']).toBeUndefined()
    expect(root()['appBgEffect']).toBeUndefined()
  })

  it('leaves the look unchanged for Transparent, which a browser cannot draw', async () => {
    const { AppBackground } = await import('./AppBackground.js')
    const { writeAppBackground } = await import('../app-background.js')
    const { container } = render(<AppBackground />)
    act(() => writeAppBackground({ mode: 'transparent' }))
    await act(async () => {})
    expect(container.innerHTML).toBe('')
    expect(root()['appBg']).toBeUndefined()
  })
})

describe('AppBackground in the desktop shell', () => {
  async function desktop(support: 'material' | 'vibrancy' | 'none') {
    const getWindowMaterialSupport = vi.fn(async () => support)
    const setWindowMaterial = vi.fn(async () => undefined)
    window.harness = {
      isDesktop: true,
      getWindowMaterialSupport,
      setWindowMaterial,
    } as unknown as NonNullable<Window['harness']>
    const { AppBackground } = await import('./AppBackground.js')
    const store = await import('../app-background.js')
    return { AppBackground, store, getWindowMaterialSupport, setWindowMaterial }
  }

  it('asks the shell nothing while the choice is None', async () => {
    const { AppBackground, getWindowMaterialSupport, setWindowMaterial } = await desktop('material')
    render(<AppBackground />)
    await act(async () => {})
    expect(getWindowMaterialSupport).not.toHaveBeenCalled()
    expect(setWindowMaterial).not.toHaveBeenCalled()
  })

  it('lets the Windows 11 backdrop through and switches the material', async () => {
    const { AppBackground, store, setWindowMaterial } = await desktop('material')
    const { container } = render(<AppBackground />)

    act(() => store.writeAppBackground({ mode: 'transparent' }))
    await waitFor(() => expect(root()['appBg']).toBe('transparent'))
    // Transparent paints no layer: the OS backdrop is the background.
    expect(container.querySelector('.app-bg')).toBeNull()
    expect(setWindowMaterial).toHaveBeenLastCalledWith('acrylic')

    act(() => store.writeAppBackground({ material: 'mica' }))
    await waitFor(() => expect(setWindowMaterial).toHaveBeenLastCalledWith('mica'))

    // Leaving Transparent puts back Acrylic for the sidebar glass.
    act(() => store.writeAppBackground({ mode: 'none' }))
    await waitFor(() => expect(setWindowMaterial).toHaveBeenLastCalledWith('acrylic'))
    expect(setWindowMaterial).toHaveBeenCalledTimes(3)
    expect(root()['appBg']).toBeUndefined()
  })

  it('applies Transparent on macOS without choosing a Windows material', async () => {
    const { AppBackground, store, setWindowMaterial } = await desktop('vibrancy')
    render(<AppBackground />)
    act(() => store.writeAppBackground({ mode: 'transparent' }))
    await waitFor(() => expect(root()['appBg']).toBe('transparent'))
    expect(setWindowMaterial).not.toHaveBeenCalled()
  })

  it('keeps the current look where the OS cannot draw behind the window', async () => {
    const { AppBackground, store, getWindowMaterialSupport, setWindowMaterial } =
      await desktop('none')
    const { container } = render(<AppBackground />)
    act(() => store.writeAppBackground({ mode: 'transparent' }))
    await waitFor(() => expect(getWindowMaterialSupport).toHaveBeenCalledTimes(1))
    await act(async () => {})
    expect(container.innerHTML).toBe('')
    expect(root()['appBg']).toBeUndefined()
    expect(setWindowMaterial).not.toHaveBeenCalled()
  })
})

describe('AppBackgroundLayer', () => {
  it('shows the stored display copy through a blob: URL and revokes it', async () => {
    const display = new Blob(['display'], { type: 'image/webp' })
    const images: BackgroundImageStore = {
      load: vi.fn(async () => ({
        original: new Blob(['original'], { type: 'image/webp' }),
        display,
        displayVersion: DISPLAY_IMAGE_VERSION,
      })),
      save: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined),
    }
    const createObjectURL = vi.fn(() => 'blob:tastecode/one')
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL }))
    const { AppBackgroundLayer } = await import('./AppBackgroundLayer.js')

    const { container, unmount } = render(
      <AppBackgroundLayer
        background={{ mode: 'image', effect: 'glow', material: 'acrylic', image: 'rev-1' }}
        images={images}
      />,
    )
    const layer = container.querySelector<HTMLElement>('.app-bg')!
    expect(layer.dataset['mode']).toBe('image')
    expect(layer.dataset['ready']).toBeUndefined()

    await waitFor(() => expect(layer.dataset['ready']).toBe(''))
    expect(createObjectURL).toHaveBeenCalledWith(display)
    expect(layer.style.getPropertyValue('--app-bg-image')).toBe('url("blob:tastecode/one")')
    expect(images.save).not.toHaveBeenCalled()
    expect(root()['appBg']).toBe('image')

    unmount()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:tastecode/one')
    expect(root()['appBg']).toBeUndefined()
  })

  it('shows the plain background when no image is stored yet', async () => {
    const images: BackgroundImageStore = {
      load: vi.fn(async () => undefined),
      save: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined),
    }
    const { AppBackgroundLayer } = await import('./AppBackgroundLayer.js')
    const { container } = render(
      <AppBackgroundLayer
        background={{ mode: 'image', effect: 'glow', material: 'acrylic', image: undefined }}
        images={images}
      />,
    )
    await act(async () => {})
    expect(images.load).not.toHaveBeenCalled()
    const layer = container.querySelector<HTMLElement>('.app-bg')!
    expect(layer.dataset['ready']).toBeUndefined()
    expect(layer.style.getPropertyValue('--app-bg-image')).toBe('')
  })
})
