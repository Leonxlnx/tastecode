// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { AppearanceColorPicker } from './AppearanceColorPicker.js'

afterEach(cleanup)

it('keeps dragging when pointer capture is lost and stops on pointer release', () => {
  const change = vi.fn()
  render(
    <AppearanceColorPicker
      label="Accent"
      value="#FF0000"
      color="#FF0000"
      options={[]}
      onChange={change}
    />,
  )
  const panel = screen.getByRole('dialog', { hidden: true })
  fireEvent(panel, Object.assign(new Event('toggle'), { newState: 'open' }))
  const field = screen.getByRole('slider', { name: 'Saturation and brightness', hidden: true })
  Object.defineProperty(field, 'setPointerCapture', { value: vi.fn() })
  vi.spyOn(field, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 200, 100))

  fireEvent.pointerDown(field, { button: 0, pointerId: 1, clientX: 150, clientY: 25 })
  fireEvent.pointerMove(field, { buttons: 1, pointerId: 1, clientX: 100, clientY: 50 })
  expect(change).toHaveBeenLastCalledWith('#804040')
  fireEvent.pointerUp(field, { button: 0, pointerId: 1, clientX: 0, clientY: 0 })
  expect(change).toHaveBeenLastCalledWith('#FFFFFF')

  change.mockClear()
  fireEvent.pointerMove(field, { buttons: 0, pointerId: 1, clientX: 200, clientY: 100 })
  expect(change).not.toHaveBeenCalled()
})
