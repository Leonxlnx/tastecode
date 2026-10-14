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

function mockSlider(name: string, rect: DOMRect) {
  const slider = screen.getByRole('slider', { name, hidden: true })
  Object.defineProperty(slider, 'setPointerCapture', { value: vi.fn() })
  vi.spyOn(slider, 'getBoundingClientRect').mockReturnValue(rect)
  return slider
}

it('drags the square while the button is held and stops on release', () => {
  const change = vi.fn()
  render(<Controlled initial="#FF0000" onChange={change} />)
  openPicker()
  // 218×118: the 18px thumb leaves 200×100 of travel starting 9px in.
  const field = mockSlider('Saturation and brightness', new DOMRect(0, 0, 218, 118))

  fireEvent.pointerDown(field, { button: 0, buttons: 1, pointerId: 1, clientX: 109, clientY: 59 })
  expect(change).toHaveBeenLastCalledWith('#804040')
  // Past the top-right corner clamps to full saturation and brightness: the pure hue.
  fireEvent.pointerMove(field, { buttons: 1, pointerId: 1, clientX: 400, clientY: -50 })
  expect(change).toHaveBeenLastCalledWith('#FF0000')
  fireEvent.pointerUp(field, { button: 0, pointerId: 1, clientX: 400, clientY: -50 })

  change.mockClear()
  fireEvent.pointerMove(field, { buttons: 0, pointerId: 1, clientX: 9, clientY: 9 })
  expect(change).not.toHaveBeenCalled()
})

it('ends a drag whose release happened outside the window', () => {
  const change = vi.fn()
  render(<Controlled initial="#FF0000" onChange={change} />)
  openPicker()
  const field = mockSlider('Saturation and brightness', new DOMRect(0, 0, 218, 118))

  fireEvent.pointerDown(field, { button: 0, buttons: 1, pointerId: 1, clientX: 109, clientY: 59 })
  change.mockClear()
  fireEvent.pointerMove(field, { buttons: 0, pointerId: 1, clientX: 209, clientY: 9 })
  fireEvent.pointerMove(field, { buttons: 0, pointerId: 1, clientX: 150, clientY: 40 })
  expect(change).not.toHaveBeenCalled()
})

it('keeps the hue through black and back', () => {
  render(<Controlled initial="#3366CC" />)
  openPicker()
  const field = mockSlider('Saturation and brightness', new DOMRect(0, 0, 218, 118))

  // Bottom of the travel: brightness 0, which is black whatever the hue.
  fireEvent.pointerDown(field, { button: 0, buttons: 1, pointerId: 1, clientX: 109, clientY: 109 })
  expect((screen.getByRole('textbox', { hidden: true }) as HTMLInputElement).value).toBe('#000000')
  // Back to s 0.75, v 0.8, the original colour, with the hue left at 220.
  fireEvent.pointerMove(field, { buttons: 1, pointerId: 1, clientX: 159, clientY: 29 })
  fireEvent.pointerUp(field, { button: 0, pointerId: 1, clientX: 159, clientY: 29 })

  expect((screen.getByRole('textbox', { hidden: true }) as HTMLInputElement).value).toBe('#3366CC')
  expect(
    screen.getByRole('slider', { name: 'Hue', hidden: true }).getAttribute('aria-valuenow'),
  ).toBe('220')
})

it('drags the hue bar', () => {
  const change = vi.fn()
  render(<Controlled initial="#FF0000" onChange={change} />)
  openPicker()
  // 226px wide: the 26px thumb leaves 200px of travel starting 13px in.
  const hue = mockSlider('Hue', new DOMRect(0, 0, 226, 24))

  fireEvent.pointerDown(hue, { button: 0, buttons: 1, pointerId: 1, clientX: 113 })
  expect(change).toHaveBeenLastCalledWith('#00FFFF')
  expect(hue.getAttribute('aria-valuenow')).toBe('180')
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

it('steps the square and the hue from the keyboard', () => {
  const change = vi.fn()
  render(<Controlled initial="#FF0000" onChange={change} />)
  openPicker()

  const hue = screen.getByRole('slider', { name: 'Hue', hidden: true })
  fireEvent.keyDown(hue, { key: 'ArrowRight', shiftKey: true })
  expect(hue.getAttribute('aria-valuenow')).toBe('10')
  expect(change).toHaveBeenLastCalledWith('#FF2A00')

  const field = screen.getByRole('slider', { name: 'Saturation and brightness', hidden: true })
  fireEvent.keyDown(field, { key: 'ArrowDown' })
  expect(field.getAttribute('aria-valuetext')).toBe('Saturation 100%, brightness 99%')
  expect(change).toHaveBeenLastCalledWith('#FC2A00')
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
