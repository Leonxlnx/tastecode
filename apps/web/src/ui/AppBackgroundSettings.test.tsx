// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  APP_BACKGROUND_KEY,
  readAppBackground,
  resetAppBackgroundForTests,
  writeAppBackground,
} from '../app-background.js'
import {
  BackgroundImageError,
  DISPLAY_IMAGE_VERSION,
  type BackgroundImageStore,
} from '../app-background-image.js'
import { AppBackgroundSettings } from './AppBackgroundSettings.js'

afterEach(() => {
  cleanup()
  localStorage.clear()
  resetAppBackgroundForTests()
  vi.restoreAllMocks()
})

function fakeImages(): BackgroundImageStore {
  return {
    load: vi.fn(async () => undefined),
    save: vi.fn(async () => undefined),
    saveDisplay: vi.fn(async () => true),
    clear: vi.fn(async () => undefined),
  }
}

function choice(name: string) {
  return screen.getByRole('radio', { name })
}

describe('Window background settings', () => {
  it('offers None, Transparent, Image and Effect with None chosen', () => {
    render(<AppBackgroundSettings images={fakeImages()} />)
    const group = screen.getByRole('radiogroup', { name: 'Window background' })
    expect(
      Array.from(group.querySelectorAll('[role="radio"]')).map((option) => option.textContent),
    ).toEqual(['None', 'Transparent', 'Image', 'Effect'])
    expect(choice('None').getAttribute('aria-checked')).toBe('true')
    expect(screen.queryByRole('radiogroup', { name: 'Background effect' })).toBeNull()
  })

  it('saves the choice and shows the effect presets under Effect', () => {
    render(<AppBackgroundSettings images={fakeImages()} />)
    fireEvent.click(choice('Effect'))
    expect(localStorage.getItem(APP_BACKGROUND_KEY)).toBe('effect')
    const presets = screen.getByRole('radiogroup', { name: 'Background effect' })
    expect(
      Array.from(presets.querySelectorAll('[role="radio"]')).map((option) => option.textContent),
    ).toEqual(['Dither', 'Halftone'])
    expect(choice('Dither').getAttribute('aria-checked')).toBe('true')

    // The preview shows the whole window over the chosen pattern, which it
    // draws at the preview's scale, and follows Dim on every step.
    const preview = screen.getByRole('img', { name: 'Preview of the window background' })
    const layer = preview.querySelector<HTMLElement>(':scope > .app-bg')!
    expect(layer.dataset['mode']).toBe('effect')
    expect(layer.dataset['effect']).toBe('dither')
    expect(layer.querySelector('canvas.app-bg__motion')).not.toBeNull()
    expect(preview.style.getPropertyValue('--app-bg-pattern')).toMatch(/^url\("data:image\/svg/)
    expect(preview.style.getPropertyValue('--app-bg-pattern-size')).toBe(
      'calc(16 * 100cqw / 1120) calc(448 * 100cqw / 1120)',
    )
    const dither = preview.style.getPropertyValue('--app-bg-pattern')
    fireEvent.click(choice('Halftone'))
    expect(readAppBackground().effect).toBe('halftone')
    expect(layer.dataset['effect']).toBe('halftone')
    expect(preview.style.getPropertyValue('--app-bg-pattern')).not.toBe(dither)
    fireEvent.change(screen.getByRole('slider', { name: 'Dim' }), { target: { value: '20' } })
    expect(readAppBackground().dim).toBe(20)
    expect(preview.style.getPropertyValue('--app-bg-dim')).toBe('0.4')
    // Blur belongs to pictures only.
    expect(screen.queryByRole('slider', { name: 'Blur' })).toBeNull()
  })

  it('previews the sidebar, a chat and the prompt bar over the background', () => {
    act(() => writeAppBackground({ mode: 'effect', effect: 'halftone' }))
    render(<AppBackgroundSettings images={fakeImages()} />)
    const preview = screen.getByRole('img', { name: 'Preview of the window background' })
    const miniature = preview.querySelector<HTMLElement>('.app-bg-preview__window')!
    expect(miniature.getAttribute('aria-hidden')).toBe('true')
    for (const part of ['titlebar', 'rail', 'stage', 'chat', 'code', 'prompt']) {
      expect(miniature.querySelector(`.app-bg-preview__${part}`)).not.toBeNull()
    }
    // The background sits under the panes, not over them.
    expect(preview.firstElementChild?.classList.contains('app-bg')).toBe(true)
    expect(preview.lastElementChild).toBe(miniature)
    // Nothing in it is text a screen reader would read out.
    expect(preview.textContent).toBe('')
  })

  it('shows no preview for None or Transparent', () => {
    render(<AppBackgroundSettings images={fakeImages()} />)
    expect(screen.queryByRole('img', { name: /Preview/ })).toBeNull()
    fireEvent.click(choice('Transparent'))
    expect(screen.queryByRole('img', { name: /Preview/ })).toBeNull()
  })

  it('says so when Transparent cannot be drawn here', async () => {
    render(<AppBackgroundSettings images={fakeImages()} />)
    fireEvent.click(choice('Transparent'))
    expect(
      await screen.findByText(/Only the desktop app can show what is behind the window/),
    ).toBeTruthy()
    expect(screen.queryByRole('radiogroup', { name: 'Window material' })).toBeNull()
  })

  it('stores a picked image and points the background at it', async () => {
    const images = fakeImages()
    const prepared = {
      original: new Blob(['o'], { type: 'image/webp' }),
      display: new Blob(['d'], { type: 'image/webp' }),
      displayVersion: DISPLAY_IMAGE_VERSION,
    }
    const prepare = vi.fn(async () => prepared)
    act(() => writeAppBackground({ mode: 'image' }))
    const { container } = render(<AppBackgroundSettings images={images} prepare={prepare} />)
    expect(screen.getByText(/Kept inside the app/)).toBeTruthy()

    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!
    expect(input.accept).toContain('image/png')
    expect(input.accept).not.toContain('svg')
    const file = new File(['pixels'], 'sky.png', { type: 'image/png' })
    fireEvent.change(input, { target: { files: [file] } })

    await waitFor(() => expect(readAppBackground().image).toBeDefined())
    expect(prepare).toHaveBeenCalledWith(file, 14)
    expect(images.save).toHaveBeenCalledWith(prepared)
    expect(screen.getByRole('button', { name: 'Change image…' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(readAppBackground().image).toBeUndefined())
    expect(images.clear).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Choose image…' })).toBeTruthy()
  })

  it('sets Dim and Blur with sliders and previews them on every step', async () => {
    const images = fakeImages()
    vi.mocked(images.load).mockResolvedValue({
      original: new Blob(['o'], { type: 'image/webp' }),
      display: new Blob(['d'], { type: 'image/webp' }),
      displayVersion: DISPLAY_IMAGE_VERSION,
    })
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:preview')
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    act(() => writeAppBackground({ mode: 'image' }))
    const view = render(<AppBackgroundSettings images={images} />)
    // No picture yet: nothing to preview or tune.
    expect(screen.queryByRole('slider', { name: 'Dim' })).toBeNull()
    expect(screen.queryByRole('img', { name: /Preview/ })).toBeNull()

    act(() => writeAppBackground({ image: 'rev-1' }))
    const preview = screen.getByRole('img', { name: 'Preview of the window background' })
    await waitFor(() =>
      expect(preview.style.getPropertyValue('--app-bg-image')).toBe('url("blob:preview")'),
    )
    const layer = preview.querySelector<HTMLElement>(':scope > .app-bg')!
    expect(layer.dataset['mode']).toBe('image')
    expect(layer.dataset['ready']).toBe('')
    // A picture has nothing to move.
    expect(layer.querySelector('canvas')).toBeNull()
    expect(createObjectURL).toHaveBeenCalledTimes(1)
    expect(preview.style.getPropertyValue('--app-bg-dim')).toBe('1')
    // The display copy's blur, at the preview's width.
    expect(preview.style.getPropertyValue('--app-bg-preview-blur')).toBe('calc(14 * 100cqw / 1600)')

    const dim = screen.getByRole<HTMLInputElement>('slider', { name: 'Dim' })
    const blur = screen.getByRole<HTMLInputElement>('slider', { name: 'Blur' })
    expect([dim.value, dim.max, blur.value, blur.max]).toEqual(['50', '100', '14', '40'])
    fireEvent.change(dim, { target: { value: '80' } })
    expect(readAppBackground().dim).toBe(80)
    expect(preview.style.getPropertyValue('--app-bg-dim')).toBe('1.6')
    fireEvent.change(blur, { target: { value: '0' } })
    expect(readAppBackground().blur).toBe(0)
    expect(preview.style.getPropertyValue('--app-bg-preview-blur')).toBe('calc(0 * 100cqw / 1600)')

    view.unmount()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:preview')
  })

  it('explains an image it cannot use and keeps the old one', async () => {
    const images = fakeImages()
    const prepare = vi.fn(async () => {
      throw new BackgroundImageError('That image could not be opened.')
    })
    act(() => writeAppBackground({ mode: 'image', image: 'rev-old' }))
    const { container } = render(<AppBackgroundSettings images={images} prepare={prepare} />)
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!
    fireEvent.change(input, {
      target: { files: [new File(['?'], 'broken.png', { type: 'image/png' })] },
    })
    expect(await screen.findByText('That image could not be opened.')).toBeTruthy()
    expect(images.save).not.toHaveBeenCalled()
    expect(readAppBackground().image).toBe('rev-old')
  })
})
