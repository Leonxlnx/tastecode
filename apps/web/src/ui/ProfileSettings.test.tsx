// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CELL, generatedAvatar } from '../generated-avatar.js'
import { STRIKE_DELAY_MS } from './ProfileCoin.js'
import { ProfileSettings } from './ProfileSettings.js'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const PHOTO = 'data:image/png;base64,iVBORw0KGgo='

type Props = ComponentProps<typeof ProfileSettings>

function renderProfile(props: Partial<Props> = {}) {
  const base: Props = { account: undefined, providerName: 'Codex', ...props }
  const view = render(<ProfileSettings {...base} />)
  return {
    ...view,
    rerenderProfile: (next: Partial<Props>) =>
      view.rerender(<ProfileSettings {...base} {...next} />),
  }
}

/** A colour as happy-dom stores it in an inline style. */
function styled(color: string): string {
  const probe = document.createElement('div')
  probe.style.fill = color
  return probe.style.fill
}

/** What the coin should show for `name`: its ground and every painted tile's ink. */
function expectedFace(name: string) {
  const avatar = generatedAvatar(name)
  if (avatar.style !== 'mandala') throw new Error('expected the mandala style')
  return {
    ground: styled(avatar.ground),
    inks: [...avatar.rings.flat(), avatar.core]
      .filter((cell) => cell !== CELL.ground)
      .map((cell) => styled(cell === CELL.glint ? avatar.inks[1] : avatar.inks[0])),
  }
}

function renderedFace() {
  const svg = document.querySelector<SVGElement>('.profile-coin__mandala')!
  return {
    ground: svg.querySelector<SVGElement>('.profile-coin__ground')!.style.fill,
    inks: Array.from(
      svg.querySelectorAll<SVGElement>('.profile-coin__tile:not([data-ground])'),
    ).map((tile) => tile.style.fill),
  }
}

async function minted() {
  await waitFor(() => expect(document.querySelector('[data-minted]')).toBeTruthy())
}

function fileInput(): HTMLInputElement {
  return document.querySelector<HTMLInputElement>('input[type="file"]')!
}

function coin(): HTMLElement {
  return document.querySelector<HTMLElement>('.profile-coin')!
}

function action(name: string): HTMLElement {
  return screen.getByRole('button', { name })
}

describe('profile settings', () => {
  it('reserves the plan in the facts while the account loads and fills the same slot', () => {
    const view = renderProfile({ accountLoading: true })
    const loading = screen.getByRole('status')
    expect(loading.getAttribute('aria-busy')).toBe('true')
    expect(loading.classList.contains('profile__plan')).toBe(true)
    expect(screen.getByText('Loading account plan…').className).toBe('visually-hidden')
    expect(loading.querySelector('.skeleton')?.getAttribute('style')).toContain('height: 9px')
    const editor = screen.getByRole('textbox', { name: 'Display name' })

    view.rerenderProfile({ accountLoading: false, account: { signedIn: true, plan: 'Pro' } })
    expect(screen.queryByText('Loading account plan…')).toBeNull()
    expect(screen.getByText('Pro plan').classList.contains('profile__plan')).toBe(true)
    expect(screen.getByRole('textbox', { name: 'Display name' })).toBe(editor)
  })

  it('leaves the plan out without an account or a request for one', () => {
    const view = renderProfile()
    expect(view.container.querySelector('.profile__plan')).toBeNull()
    view.rerenderProfile({ account: { signedIn: false } })
    expect(view.container.querySelector('.profile__plan')).toBeNull()
  })

  it('keeps an already known plan visible during account refresh', () => {
    renderProfile({ account: { signedIn: true, plan: 'Pro' }, accountLoading: true })
    expect(screen.getByText('Pro plan')).toBeTruthy()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('shows the local identity without the account email or provider', async () => {
    renderProfile({
      account: { signedIn: true, email: 'blue.emi@example.com', plan: 'Pro' },
      providerName: 'Grok',
    })
    expect(screen.getByRole('heading', { name: 'Profile' })).toBeTruthy()
    const name = screen.getByRole('textbox', { name: 'Display name' })
    expect(name.getAttribute('placeholder')).toBe('Local profile')
    expect(screen.getByText('Struck from your name')).toBeTruthy()
    await minted()
    expect(renderedFace()).toEqual(expectedFace('Local profile'))
    expect(screen.queryByText(/blue\.emi/u)).toBeNull()
    expect(screen.queryByText('Grok')).toBeNull()
  })

  it('writes the name in place and strikes the seal again once typing pauses', async () => {
    const onIdentityChange = vi.fn()
    const view = renderProfile({ identity: { displayName: 'Leon' }, onIdentityChange })
    await minted()
    expect(renderedFace()).toEqual(expectedFace('Leon'))

    fireEvent.change(screen.getByRole('textbox', { name: 'Display name' }), {
      target: { value: 'Bluedev' },
    })
    expect(onIdentityChange).toHaveBeenLastCalledWith({ displayName: 'Bluedev' })

    vi.useFakeTimers()
    view.rerenderProfile({ identity: { displayName: 'Bluedev' }, onIdentityChange })
    act(() => vi.advanceTimersByTime(STRIKE_DELAY_MS - 1))
    expect(renderedFace()).toEqual(expectedFace('Leon'))
    act(() => vi.advanceTimersByTime(1))
    expect(renderedFace()).toEqual(expectedFace('Bluedev'))
  })

  it('turns over to the photo face, takes a photo and turns back to the seal', async () => {
    const onIdentityChange = vi.fn()
    const view = renderProfile({ identity: { displayName: 'Leon' }, onIdentityChange })
    const pick = vi.spyOn(fileInput(), 'click').mockImplementation(() => {})
    expect(coin().dataset.side).toBe('seal')
    expect(coin().getAttribute('title')).toBe('Turn over for a photo')

    fireEvent.click(action('Turn over for a photo'))
    expect(coin().dataset.side).toBe('photo')
    expect(pick).toHaveBeenCalledTimes(1)
    expect(screen.getByText('PNG, JPEG or WebP up to 1 MB')).toBeTruthy()
    expect(screen.getByText('Drop a photo')).toBeTruthy()

    fireEvent.change(fileInput(), {
      target: { files: [new File(['nope'], 'avatar.png', { type: 'image/png' })] },
    })
    expect((await screen.findByRole('alert')).textContent).toContain('not a valid image')
    fireEvent.change(fileInput(), {
      target: { files: [new File([PNG], 'avatar.png', { type: 'image/png' })] },
    })
    await waitFor(() =>
      expect(onIdentityChange).toHaveBeenLastCalledWith({
        avatarDataUrl: expect.stringMatching(/^data:image\/png;base64,/u),
      }),
    )

    view.rerenderProfile({
      identity: { displayName: 'Leon', avatarDataUrl: PHOTO },
      onIdentityChange,
    })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(document.querySelector('.profile-coin__picture img')?.getAttribute('src')).toBe(PHOTO)
    expect(screen.getByText('Your photo · PNG, 8 B')).toBeTruthy()
    fireEvent.click(action('Replace'))
    expect(pick).toHaveBeenCalledTimes(2)

    fireEvent.click(action('Turn back'))
    expect(onIdentityChange).toHaveBeenLastCalledWith({ avatarDataUrl: undefined })
    view.rerenderProfile({ identity: { displayName: 'Leon' }, onIdentityChange })
    expect(coin().dataset.side).toBe('seal')
    // The photo stays on the face turned away, ready to come back.
    expect(document.querySelector('.profile-coin__picture img')?.getAttribute('src')).toBe(PHOTO)

    fireEvent.click(action('Turn over to your photo'))
    expect(onIdentityChange).toHaveBeenLastCalledWith({ avatarDataUrl: PHOTO })
    expect(pick).toHaveBeenCalledTimes(2)
  })

  it('turns when the coin itself is clicked and back without a photo', () => {
    const onIdentityChange = vi.fn()
    renderProfile({ identity: { displayName: 'Leon' }, onIdentityChange })
    vi.spyOn(fileInput(), 'click').mockImplementation(() => {})

    fireEvent.click(coin())
    expect(coin().dataset.side).toBe('photo')
    expect(coin().getAttribute('title')).toBe('Turn back to the seal')
    fireEvent.click(coin())
    expect(coin().dataset.side).toBe('seal')
    expect(onIdentityChange).not.toHaveBeenCalled()
  })

  it('swings when the cursor brushes across it and comes back to rest', async () => {
    renderProfile({ identity: { displayName: 'Leon' } })
    const tilt = document.querySelector<HTMLElement>('.profile-coin__tilt')!
    const swing = () => Number(tilt.style.getPropertyValue('--nudge-y') || 0)

    // A still cursor, or a touch, does not move it.
    fireEvent.pointerMove(coin(), { clientX: 120, clientY: 80, pointerType: 'mouse' })
    fireEvent.pointerMove(coin(), { clientX: 120, clientY: 80, pointerType: 'mouse' })
    fireEvent.pointerMove(coin(), { clientX: 20, clientY: 80, pointerType: 'touch' })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(swing()).toBe(0)

    fireEvent.pointerLeave(coin())
    fireEvent.pointerMove(coin(), { clientX: 40, clientY: 80, pointerType: 'mouse' })
    fireEvent.pointerMove(coin(), { clientX: 120, clientY: 80, pointerType: 'mouse' })
    await waitFor(() => expect(swing()).toBeGreaterThan(4))
    await waitFor(() => expect(Math.abs(swing())).toBeLessThan(0.5), { timeout: 4000 })
  })

  it('strikes the seal from any word and keeps it only when asked', async () => {
    const onIdentityChange = vi.fn()
    renderProfile({ identity: { displayName: 'Leon' }, onIdentityChange })
    await minted()

    fireEvent.click(action('Strike from a word'))
    const word = screen.getByRole('textbox', { name: 'Struck from' })
    expect(document.activeElement).toBe(word)
    expect(word.getAttribute('placeholder')).toBe('Leon')

    fireEvent.change(word, { target: { value: 'harbor' } })
    await waitFor(() => expect(renderedFace()).toEqual(expectedFace('harbor')))
    expect(onIdentityChange).not.toHaveBeenCalled()

    fireEvent.click(action('Keep this seal'))
    expect(onIdentityChange).toHaveBeenLastCalledWith({ avatarSeed: 'harbor' })
    expect(screen.queryByRole('textbox', { name: 'Struck from' })).toBeNull()
  })

  it('leaves a tried word with Cancel or Escape, without closing Settings', async () => {
    const onIdentityChange = vi.fn()
    renderProfile({ identity: { displayName: 'Leon' }, onIdentityChange })
    await minted()

    fireEvent.click(action('Strike from a word'))
    fireEvent.change(screen.getByRole('textbox', { name: 'Struck from' }), {
      target: { value: 'ember' },
    })
    await waitFor(() => expect(renderedFace()).toEqual(expectedFace('ember')))
    fireEvent.click(action('Cancel'))
    await waitFor(() => expect(renderedFace()).toEqual(expectedFace('Leon')))

    fireEvent.click(action('Strike from a word'))
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    act(() => screen.getByRole('textbox', { name: 'Struck from' }).dispatchEvent(escape))
    expect(escape.defaultPrevented).toBe(true)
    expect(screen.queryByRole('textbox', { name: 'Struck from' })).toBeNull()
    expect(onIdentityChange).not.toHaveBeenCalled()
  })

  it('explains the tried word on the coin itself behind the "?", only while trying', async () => {
    renderProfile({ identity: { displayName: 'Leon' } })
    expect(screen.queryByRole('button', { name: 'How a seal is struck' })).toBeNull()

    fireEvent.click(action('Strike from a word'))
    fireEvent.change(screen.getByRole('textbox', { name: 'Struck from' }), {
      target: { value: 'harbor' },
    })
    await waitFor(() => expect(renderedFace()).toEqual(expectedFace('harbor')))
    const help = screen.getByRole('button', { name: 'How a seal is struck' })
    expect(help.getAttribute('aria-expanded')).toBe('false')
    expect(coin().hasAttribute('data-explaining')).toBe(false)

    fireEvent.pointerEnter(help)
    expect(help.getAttribute('aria-expanded')).toBe('true')
    const notes = document.getElementById(help.getAttribute('aria-controls')!)!
    expect(notes.textContent).toContain('h picks the colour')
    expect(notes.textContent).toContain('ends in r, so dark')
    expect(notes.textContent).toContain('6 letters, four slices')
    expect(screen.getByText('3, 6, 9: four slices').hasAttribute('data-current')).toBe(true)
    expect(coin().hasAttribute('data-explaining')).toBe(true)
    // The slice that repeats carries the letters that laid it: h, a, r on the outer ring.
    const letters = [...document.querySelectorAll('.profile-coin__letters text')].map(
      (text) => text.textContent,
    )
    expect(letters.slice(0, 3)).toEqual(['h', 'a', 'r'])

    fireEvent.pointerLeave(help)
    expect(help.getAttribute('aria-expanded')).toBe('false')
    expect(document.getElementById(help.getAttribute('aria-controls')!)).toBeNull()

    // A click pins the notes open; Escape closes them without closing Settings.
    fireEvent.click(help)
    fireEvent.pointerLeave(help)
    expect(help.getAttribute('aria-pressed')).toBe('true')
    expect(help.getAttribute('aria-expanded')).toBe('true')
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    act(() => help.dispatchEvent(escape))
    expect(escape.defaultPrevented).toBe(true)
    expect(help.getAttribute('aria-expanded')).toBe('false')
  })

  it('goes back to the name from a kept word in one step', async () => {
    const onIdentityChange = vi.fn()
    const view = renderProfile({
      identity: { displayName: 'Leon', avatarSeed: 'lantern' },
      onIdentityChange,
    })
    await minted()
    expect(renderedFace()).toEqual(expectedFace('lantern'))

    fireEvent.click(action('Back to your name'))
    expect(onIdentityChange).toHaveBeenLastCalledWith({ avatarSeed: undefined })

    view.rerenderProfile({ identity: { displayName: 'Leon' }, onIdentityChange })
    expect(screen.getByText('Struck from your name')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Back to your name' })).toBeNull()
    await waitFor(() => expect(renderedFace()).toEqual(expectedFace('Leon')))
  })

  it('rolls a word to try with the die', () => {
    renderProfile({ identity: { displayName: 'Leon' } })
    fireEvent.click(action('Strike from a word'))
    const word = screen.getByRole<HTMLInputElement>('textbox', { name: 'Struck from' })

    fireEvent.click(screen.getByRole('button', { name: 'Another word' }))
    const first = word.value
    expect(first).toMatch(/^[a-z]+$/u)
    fireEvent.click(screen.getByRole('button', { name: 'Another word' }))
    expect(word.value).not.toBe(first)
  })

  it('shows the kept word and goes back to the name when the word is cleared', async () => {
    const onIdentityChange = vi.fn()
    renderProfile({ identity: { displayName: 'Leon', avatarSeed: 'lantern' }, onIdentityChange })
    expect(screen.getByText('Struck from \u201clantern\u201d')).toBeTruthy()
    await minted()
    expect(renderedFace()).toEqual(expectedFace('lantern'))

    fireEvent.click(action('Strike from a word'))
    const word = screen.getByRole<HTMLInputElement>('textbox', { name: 'Struck from' })
    expect(word.value).toBe('lantern')
    fireEvent.change(word, { target: { value: '' } })
    onIdentityChange.mockClear()
    fireEvent.keyDown(word, { key: 'Enter', isComposing: true })
    expect(onIdentityChange).not.toHaveBeenCalled()
    fireEvent.keyDown(word, { key: 'Enter' })
    expect(onIdentityChange).toHaveBeenLastCalledWith({ avatarSeed: undefined })
  })

  it('turns to the photo face while a photo is dragged in and takes the drop', async () => {
    const onIdentityChange = vi.fn()
    renderProfile({ identity: { displayName: 'Leon' }, onIdentityChange })
    const page = document.querySelector<HTMLElement>('.profile')!
    const file = new File([PNG], 'me.png', { type: 'image/png' })

    fireEvent.dragEnter(page, { dataTransfer: { types: ['Files'], files: [file] } })
    expect(coin().dataset.side).toBe('photo')
    expect(coin().hasAttribute('data-dropping')).toBe(true)
    expect(screen.getByText('Drop to use this photo')).toBeTruthy()
    fireEvent.dragLeave(page, { dataTransfer: { types: ['Files'], files: [file] } })
    expect(coin().dataset.side).toBe('seal')

    fireEvent.dragEnter(page, { dataTransfer: { types: ['Files'], files: [file] } })
    fireEvent.drop(page, { dataTransfer: { types: ['Files'], files: [file] } })
    expect(coin().hasAttribute('data-dropping')).toBe(false)
    await waitFor(() =>
      expect(onIdentityChange).toHaveBeenLastCalledWith({
        avatarDataUrl: expect.stringMatching(/^data:image\/png;base64,/u),
      }),
    )
  })

  it('ignores an image read that finishes after the profile closes', async () => {
    let finishRead: (value: ArrayBuffer) => void = () => {}
    const file = new File(['avatar'], 'avatar.png', { type: 'image/png' })
    const slicedFile = new Blob()
    vi.spyOn(slicedFile, 'arrayBuffer').mockImplementation(
      () => new Promise((resolve) => (finishRead = resolve)),
    )
    vi.spyOn(file, 'slice').mockReturnValue(slicedFile)
    const onIdentityChange = vi.fn()
    const view = renderProfile({ identity: { displayName: 'Leon' }, onIdentityChange })
    fireEvent.change(fileInput(), { target: { files: [file] } })
    view.unmount()
    finishRead(PNG.buffer)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(onIdentityChange).not.toHaveBeenCalled()
  })
})
