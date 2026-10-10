// @vitest-environment happy-dom
import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
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
  it('hides partial options while loading and keeps the search when the full list arrives', () => {
    const onOpen = vi.fn()
    const onChange = vi.fn()
    const props = {
      ariaLabel: 'Font',
      value: 'alpha',
      options: [{ value: 'alpha', label: 'Alpha Sans' }],
      search: { label: 'Search fonts' },
      onOpen,
      onChange,
    }
    const view = render(<AppSelect {...props} loadingMessage="Loading fonts…" />)
    const trigger = screen.getByRole('combobox', { name: 'Font' })
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    expect(onOpen).toHaveBeenCalledOnce()
    expect(screen.getByRole('listbox').getAttribute('aria-busy')).toBe('true')
    expect(screen.getByRole('status').textContent).toBe('Loading fonts…')
    expect(screen.queryAllByRole('option')).toHaveLength(0)
    fireEvent.keyDown(trigger, { key: 'Enter' })
    expect(onChange).not.toHaveBeenCalled()
    const search = screen.getByRole('searchbox')
    fireEvent.change(search, { target: { value: 'beta' } })
    view.rerender(
      <AppSelect {...props} options={[...props.options, { value: 'beta', label: 'Beta Serif' }]} />,
    )
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Beta Serif',
    ])
    fireEvent.keyDown(search, { key: 'Enter', isComposing: true })
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.keyDown(search, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith('beta')
    expect(document.activeElement).toBe(trigger)
  })

  it('applies selection immediately while the old list exits at its original position', async () => {
    const onChange = vi.fn()
    render(<SelectHarness onChange={onChange} />)
    const trigger = screen.getByRole('combobox', { name: 'Project' })
    fireEvent.click(trigger, { detail: 1 })
    const listbox = screen.getByRole('listbox')
    let finishExit: (() => void) | undefined
    const finished = new Promise<void>((resolve) => {
      finishExit = resolve
    })
    Object.defineProperty(listbox, 'getAnimations', { value: () => [{ finished }] })
    const top = listbox.style.top

    fireEvent.click(screen.getByRole('option', { name: 'Beta' }))
    expect(onChange).toHaveBeenCalledWith('beta')
    expect(trigger.textContent).toBe('Beta')
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(listbox.isConnected).toBe(true)
    expect(listbox.hasAttribute('inert')).toBe(true)
    expect(listbox.style.top).toBe(top)
    expect(document.activeElement).toBe(trigger)

    await act(async () => finishExit?.())
    expect(listbox.isConnected).toBe(false)
  })

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
    fireEvent.keyDown(trigger, { key: 'Enter', isComposing: true })
    expect(onChange).not.toHaveBeenCalled()
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

  it('groups options under one heading each and ranks the best matches first', () => {
    render(
      <AppSelect
        ariaLabel="Font"
        value="system"
        onChange={() => {}}
        search={{ label: 'Search fonts' }}
        options={[
          { value: 'system', label: 'System default', group: 'Built in' },
          { value: 'geist', label: 'Geist', group: 'Built in' },
          { value: 'engraved', label: 'Academy Engraved', group: 'Installed' },
          { value: 'avestan', label: 'Noto Sans Avestan', group: 'Installed' },
          { value: 'avenir', label: 'Avenir', group: 'Installed' },
        ]}
      />,
    )
    fireEvent.click(screen.getByRole('combobox', { name: 'Font' }))
    const listbox = screen.getByRole('listbox', { name: 'Font' })
    expect(
      [...listbox.querySelectorAll('.app-select__group')].map((group) => group.textContent),
    ).toEqual(['Built in', 'Installed'])

    const search = screen.getByRole('searchbox', { name: 'Search fonts' })
    fireEvent.change(search, { target: { value: 'av' } })
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Avenir',
      'Noto Sans Avestan',
      'Academy Engraved',
    ])
    expect(search.getAttribute('aria-activedescendant')).toBe(
      screen.getByRole('option', { name: 'Avenir' }).id,
    )
    expect(
      [...listbox.querySelectorAll('.app-select__group')].map((group) => group.textContent),
    ).toEqual(['Installed'])
  })

  it('is typed into where its value stands, at one list height', () => {
    const { container } = render(<SearchableSelectHarness />)
    const trigger = screen.getByRole('combobox', { name: 'Font' })
    fireEvent.click(trigger)
    const listbox = screen.getByRole('listbox', { name: 'Font' })
    const height = listbox.style.height
    expect(height).toBe('120px')

    const search = screen.getByRole('searchbox', { name: 'Search fonts' }) as HTMLInputElement
    expect(container.contains(search)).toBe(true)
    expect(listbox.querySelector('input')).toBeNull()
    expect(search.placeholder).toBe('Alpha Sans')
    expect(container.querySelector('.app-select')?.className).toContain('is-searching')

    fireEvent.change(search, { target: { value: 'brush' } })
    expect(listbox.style.height).toBe(height)
    // The hidden value carries the query, so the trigger keeps the field's width.
    expect(trigger.querySelector('.app-select__value')?.textContent).toBe('brush')

    fireEvent.mouseDown(search)
    expect(screen.getByRole('listbox', { name: 'Font' })).toBeTruthy()
    fireEvent.keyDown(search, { key: 'Escape' })
    expect(screen.queryByRole('searchbox')).toBeNull()
    expect(trigger.textContent).toBe('Alpha Sans')
  })

  it('follows the keyboard with scrolling but leaves the list still under the pointer', () => {
    const scrollIntoView = vi.fn()
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    })
    render(<SearchableSelectHarness />)
    fireEvent.click(screen.getByRole('combobox', { name: 'Font' }))
    expect(scrollIntoView).toHaveBeenLastCalledWith({ block: 'center' })
    scrollIntoView.mockClear()

    fireEvent.mouseMove(screen.getByRole('option', { name: 'Delta Mono' }))
    expect(screen.getByRole('option', { name: 'Delta Mono' }).className).toContain('is-active')
    expect(scrollIntoView).not.toHaveBeenCalled()

    fireEvent.keyDown(screen.getByRole('searchbox', { name: 'Search fonts' }), {
      key: 'ArrowUp',
    })
    expect(screen.getByRole('option', { name: 'Brush Script' }).className).toContain('is-active')
    expect(scrollIntoView).toHaveBeenLastCalledWith({ block: 'nearest' })
    Reflect.deleteProperty(Element.prototype, 'scrollIntoView')
  })

  it('sets a font sample beside each option that names one', () => {
    render(
      <AppSelect
        ariaLabel="Font"
        value="geist"
        onChange={() => {}}
        search={{ label: 'Search fonts' }}
        options={[{ value: 'geist', label: 'Geist', sampleFont: 'var(--font-geist)' }]}
      />,
    )
    fireEvent.click(screen.getByRole('combobox', { name: 'Font' }))
    const option = screen.getByRole('option', { name: 'Geist' })
    expect(option.hasAttribute('data-sample')).toBe(true)
    expect(option.style.getPropertyValue('--app-select-sample')).toBe('var(--font-geist)')
    expect(option.textContent).toBe('Geist')
  })
})
