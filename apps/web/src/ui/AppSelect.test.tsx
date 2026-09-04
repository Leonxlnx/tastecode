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

function SearchableSelectHarness(props: { onChange?: (value: string) => void }) {
  const [value, setValue] = useState('alpha')
  return (
    <AppSelect
      ariaLabel="Font"
      value={value}
      onChange={(next) => {
        setValue(next)
        props.onChange?.(next)
      }}
      search={{
        label: 'Search fonts',
        placeholder: 'Search fonts…',
        emptyMessage: 'No matching fonts',
      }}
      options={[
        { value: 'alpha', label: 'Alpha Sans' },
        { value: 'beta', label: 'Beta Serif' },
        { value: 'brush', label: 'Brush Script' },
        { value: 'delta', label: 'Delta Mono' },
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

  it('filters a searchable picker by typing on its trigger and selects the result', () => {
    const onChange = vi.fn()
    render(<SearchableSelectHarness onChange={onChange} />)
    const trigger = screen.getByRole('combobox', { name: 'Font' })

    fireEvent.click(trigger)
    const search = screen.getByRole('searchbox', { name: 'Search fonts' }) as HTMLInputElement
    expect(document.activeElement).toBe(search)
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Alpha Sans',
      'Beta Serif',
      'Brush Script',
      'Delta Mono',
    ])

    fireEvent.keyDown(trigger, { key: 'b' })
    fireEvent.keyDown(trigger, { key: 'r' })

    expect(search.value).toBe('br')
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Brush Script',
    ])
    fireEvent.keyDown(trigger, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith('brush')
    expect(trigger.textContent).toContain('Brush Script')

    fireEvent.click(trigger)
    fireEvent.keyDown(trigger, { key: 'd' })
    fireEvent.keyDown(trigger, { key: 'e' })
    fireEvent.keyDown(trigger, { key: 'l' })
    fireEvent.keyDown(trigger, { key: 't' })
    fireEvent.keyDown(trigger, { key: 'a' })
    fireEvent.keyDown(trigger, { key: ' ' })
    fireEvent.keyDown(trigger, { key: 'm' })
    expect(
      (screen.getByRole('searchbox', { name: 'Search fonts' }) as HTMLInputElement).value,
    ).toBe('delta m')
    expect(screen.getByRole('option', { name: 'Delta Mono' })).toBeTruthy()
  })

  it('filters from the search field and reports an empty result', () => {
    render(<SearchableSelectHarness />)
    fireEvent.click(screen.getByRole('combobox', { name: 'Font' }))
    const search = screen.getByRole('searchbox', { name: 'Search fonts' })

    fireEvent.change(search, { target: { value: 'serif' } })
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Beta Serif',
    ])

    fireEvent.change(search, { target: { value: 'missing' } })
    expect(screen.queryAllByRole('option')).toHaveLength(0)
    expect(screen.getByRole('status').textContent).toBe('No matching fonts')

    fireEvent.change(search, { target: { value: '' } })
    expect(search.getAttribute('aria-activedescendant')).toContain('option-0')

    fireEvent.keyDown(search, { key: 'Tab' })
    expect(screen.queryByRole('listbox', { name: 'Font' })).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('combobox', { name: 'Font' }))
  })
})
