// @vitest-environment happy-dom
import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppSelect } from './AppSelect.js'

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON: () => ({}),
  }
}

function SelectHarness(props: { onChange?: (value: string) => void }) {
  const [value, setValue] = useState('alpha')
  return (
    <AppSelect
      ariaLabel="Project"
      value={value}
      onChange={(next) => {
        setValue(next)
        props.onChange?.(next)
      }}
      options={[
        { value: 'alpha', label: 'Alpha' },
        { value: 'beta', label: 'Beta' },
        { value: 'disabled', label: 'Disabled', disabled: true },
      ]}
    />
  )
}

beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 500 })
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 400 })
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (this.classList.contains('app-select__trigger')) return rect(20, 30, 140, 30)
    if (this.classList.contains('app-select__listbox')) return rect(0, 0, 180, 110)
    return rect(0, 0, 0, 0)
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('AppSelect', () => {
  it('renders its own portalled listbox and selects an option', () => {
    const onChange = vi.fn()
    const { container } = render(<SelectHarness onChange={onChange} />)
    const trigger = screen.getByRole('combobox', { name: 'Project' })

    expect(container.querySelector('select')).toBeNull()
    expect(trigger.textContent).toContain('Alpha')
    fireEvent.click(trigger)

    const listbox = screen.getByRole('listbox', { name: 'Project' })
    expect(container.contains(listbox)).toBe(false)
    expect(listbox.parentElement).toBe(document.body)
    expect(screen.getByRole('option', { name: 'Alpha' }).getAttribute('aria-selected')).toBe('true')

    fireEvent.click(screen.getByRole('option', { name: 'Beta' }))
    expect(onChange).toHaveBeenCalledWith('beta')
    expect(trigger.textContent).toContain('Beta')
    expect(screen.queryByRole('listbox', { name: 'Project' })).toBeNull()
  })

  it('supports arrow, enter, escape, and outside-click behavior', () => {
    const onChange = vi.fn()
    const onParentKeyDown = vi.fn()
    render(
      <div onKeyDown={onParentKeyDown}>
        <SelectHarness onChange={onChange} />
        <button>Outside</button>
      </div>,
    )
    const trigger = screen.getByRole('combobox', { name: 'Project' })

    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    expect(trigger.getAttribute('aria-activedescendant')).toContain('option-1')
    fireEvent.keyDown(trigger, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith('beta')

    fireEvent.click(trigger)
    fireEvent.keyDown(trigger, { key: 'Escape' })
    expect(screen.queryByRole('listbox', { name: 'Project' })).toBeNull()
    expect(onParentKeyDown).not.toHaveBeenCalledWith(expect.objectContaining({ key: 'Escape' }))

    fireEvent.click(trigger)
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Outside' }))
    expect(screen.queryByRole('listbox', { name: 'Project' })).toBeNull()
  })
})
