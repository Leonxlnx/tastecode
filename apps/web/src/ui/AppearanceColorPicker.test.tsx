// @vitest-environment happy-dom
import { useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { HexColor } from '../theme-colors.js'
import { AppearanceColorPicker } from './AppearanceColorPicker.js'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const PRESETS = [
  { value: 'neutral', label: 'Neutral', color: '#4C9DFF' },
  { value: 'ocean', label: 'Ocean', color: '#65B8FF' },
] as const

/** Feeds every change back in, the way Settings does. */
function Controlled(props: { initial: string; onChange?: (value: string) => void }) {
  const [value, setValue] = useState(props.initial)
  const preset = PRESETS.find((option) => option.value === value)
  return (
    <AppearanceColorPicker
      label="Accent"
      value={value}
      color={(preset?.color ?? value) as HexColor}
      options={PRESETS}
      onChange={(next) => {
        setValue(next)
        props.onChange?.(next)
      }}
    />
  )
}

function openPicker() {
  fireEvent.click(screen.getByRole('button', { name: /^Accent:/ }))
  return screen.getByRole('dialog', { name: 'Accent color picker', hidden: true })
}

function channel(name: string) {
  const slider = screen.getByRole('slider', { name, hidden: true })
  Object.defineProperty(slider, 'setPointerCapture', { value: vi.fn() })
  // 212px wide: the 12px thumb leaves 200px of travel starting 6px in.
  vi.spyOn(slider, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 212, 24))
  return slider
}

it('drags a channel while the button is held and stops on release', () => {
  const change = vi.fn()
  render(<Controlled initial="#FF0000" onChange={change} />)
  openPicker()
  const lightness = channel('Lightness')

  fireEvent.pointerDown(lightness, { button: 0, buttons: 1, pointerId: 1, clientX: 156 })
  expect(change).toHaveBeenLastCalledWith('#FF8080')
  fireEvent.pointerMove(lightness, { buttons: 1, pointerId: 1, clientX: 400 })
  expect(change).toHaveBeenLastCalledWith('#FFFFFF')
  fireEvent.pointerUp(lightness, { button: 0, pointerId: 1, clientX: 400 })

  change.mockClear()
  fireEvent.pointerMove(lightness, { buttons: 0, pointerId: 1, clientX: 6 })
  expect(change).not.toHaveBeenCalled()
})

it('ends a drag whose release happened outside the window', () => {
  const change = vi.fn()
  render(<Controlled initial="#FF0000" onChange={change} />)
  openPicker()
  const hue = channel('Hue')

  fireEvent.pointerDown(hue, { button: 0, buttons: 1, pointerId: 1, clientX: 6 })
  change.mockClear()
  fireEvent.pointerMove(hue, { buttons: 0, pointerId: 1, clientX: 106 })
  fireEvent.pointerMove(hue, { buttons: 0, pointerId: 1, clientX: 150 })
  expect(change).not.toHaveBeenCalled()
})

it('keeps the hue through black and back', () => {
  render(<Controlled initial="#3366CC" />)
  openPicker()
  const lightness = channel('Lightness')

  fireEvent.pointerDown(lightness, { button: 0, buttons: 1, pointerId: 1, clientX: 0 })
  expect((screen.getByRole('textbox', { hidden: true }) as HTMLInputElement).value).toBe('#000000')
  fireEvent.pointerMove(lightness, { buttons: 1, pointerId: 1, clientX: 106 })
  fireEvent.pointerUp(lightness, { button: 0, pointerId: 1, clientX: 106 })

  expect((screen.getByRole('textbox', { hidden: true }) as HTMLInputElement).value).toBe('#3366CC')
  expect(
    screen.getByRole('slider', { name: 'Hue', hidden: true }).getAttribute('aria-valuenow'),
  ).toBe('220')
})

it('shows preset names and marks the chosen one', () => {
  render(<Controlled initial="ocean" />)
  openPicker()

  const ocean = screen.getByRole('button', { name: 'Ocean', hidden: true })
  expect(ocean.getAttribute('aria-pressed')).toBe('true')
  expect(document.activeElement).toBe(ocean)
  expect(
    screen.getByRole('button', { name: 'Neutral', hidden: true }).getAttribute('aria-pressed'),
  ).toBe('false')

  fireEvent.keyDown(ocean, { key: 'ArrowUp' })
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Neutral', hidden: true }))
})

it('steps a channel from the keyboard', () => {
  const change = vi.fn()
  render(<Controlled initial="#FF0000" onChange={change} />)
  openPicker()

  const hue = screen.getByRole('slider', { name: 'Hue', hidden: true })
  fireEvent.keyDown(hue, { key: 'ArrowRight', shiftKey: true })
  expect(change).toHaveBeenLastCalledWith('#FF2B00')
  expect(hue.getAttribute('aria-valuenow')).toBe('10')
  fireEvent.keyDown(hue, { key: 'Home' })
  expect(change).toHaveBeenLastCalledWith('#FF0000')
})

it('applies a full hex at once and a short one on Enter', () => {
  const change = vi.fn()
  render(<Controlled initial="neutral" onChange={change} />)
  openPicker()
  const hex = screen.getByRole('textbox', { name: 'Accent hex color', hidden: true })

  fireEvent.change(hex, { target: { value: 'e11d48' } })
  expect(change).toHaveBeenLastCalledWith('#E11D48')

  change.mockClear()
  fireEvent.change(hex, { target: { value: '#abc' } })
  expect(change).not.toHaveBeenCalled()
  fireEvent.keyDown(hex, { key: 'Enter' })
  expect(change).toHaveBeenLastCalledWith('#AABBCC')

  fireEvent.change(hex, { target: { value: 'nope' } })
  fireEvent.keyDown(hex, { key: 'Enter' })
  expect(hex.getAttribute('aria-invalid')).toBe('true')
  expect(screen.getByText('Use a hex color, like #5E6AD2.')).toBeTruthy()
})

it('closes on Escape and on a press outside, and returns focus on Escape', () => {
  render(<Controlled initial="neutral" />)
  const trigger = screen.getByRole('button', { name: /^Accent:/ })

  openPicker()
  expect(trigger.getAttribute('aria-expanded')).toBe('true')
  fireEvent.keyDown(screen.getByRole('button', { name: 'Neutral', hidden: true }), {
    key: 'Escape',
  })
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
  expect(document.activeElement).toBe(trigger)

  openPicker()
  fireEvent.pointerDown(document.body)
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
})

it('applies a color sampled from the screen and stays open while sampling', async () => {
  const change = vi.fn()
  let pick: (value: { sRGBHex: string }) => void = () => {}
  vi.stubGlobal(
    'EyeDropper',
    class {
      open = () => new Promise<{ sRGBHex: string }>((resolve) => (pick = resolve))
    },
  )
  render(<Controlled initial="neutral" onChange={change} />)
  const trigger = screen.getByRole('button', { name: /^Accent:/ })
  openPicker()

  fireEvent.click(screen.getByRole('button', { name: 'Pick from screen', hidden: true }))
  // The sampler's click lands outside the panel.
  fireEvent.pointerDown(document.body)
  expect(trigger.getAttribute('aria-expanded')).toBe('true')
  pick({ sRGBHex: '#abc' })
  await waitFor(() => expect(change).toHaveBeenCalledWith('#AABBCC'))
})
