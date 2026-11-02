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
    ).toEqual(['Glow', 'Grain', 'Aurora'])
    fireEvent.click(choice('Aurora'))
    expect(readAppBackground().effect).toBe('aurora')
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
    expect(prepare).toHaveBeenCalledWith(file)
    expect(images.save).toHaveBeenCalledWith(prepared)
    expect(screen.getByRole('button', { name: 'Change image…' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(readAppBackground().image).toBeUndefined())
    expect(images.clear).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Choose image…' })).toBeTruthy()
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
