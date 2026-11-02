// @vitest-environment happy-dom
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { SettingsSegmented } from './SettingsSegmented.js'

afterEach(cleanup)

const OPTIONS = [
  { value: 'auto', label: 'Auto', title: "The model's own window" },
  { value: '200000', label: '200K' },
  { value: '1000000', label: '1M' },
] as const

function Harness(props: { initial: string; onChange?: (value: string) => void }) {
  const [value, setValue] = useState(props.initial)
  return (
    <SettingsSegmented
      ariaLabel="Context window"
      value={value}
      options={OPTIONS}
      onChange={(next) => {
        props.onChange?.(next)
        setValue(next)
      }}
    />
  )
}

const radios = () => within(screen.getByRole('radiogroup', { name: 'Context window' }))

describe('SettingsSegmented', () => {
  it('is one radio group whose only tab stop is the chosen option', () => {
    render(<Harness initial="200000" />)
    const options = radios().getAllByRole('radio')
    expect(options.map((option) => option.textContent)).toEqual(['Auto', '200K', '1M'])
    expect(options.map((option) => option.getAttribute('aria-checked'))).toEqual([
      'false',
      'true',
      'false',
    ])
    expect(options.map((option) => option.tabIndex)).toEqual([-1, 0, -1])
    expect(options[0]?.getAttribute('title')).toBe("The model's own window")
  })

  it('moves the choice with the focus on arrow keys, wrapping at both ends', () => {
    const onChange = vi.fn()
    render(<Harness initial="auto" onChange={onChange} />)
    const auto = radios().getByRole('radio', { name: 'Auto' })

    fireEvent.keyDown(auto, { key: 'ArrowRight' })
    const twoHundred = radios().getByRole('radio', { name: '200K' })
    expect(document.activeElement).toBe(twoHundred)
    expect(twoHundred.getAttribute('aria-checked')).toBe('true')

    fireEvent.keyDown(twoHundred, { key: 'ArrowDown' })
    fireEvent.keyDown(radios().getByRole('radio', { name: '1M' }), { key: 'ArrowRight' })
    expect(document.activeElement).toBe(auto)
    expect(auto.getAttribute('aria-checked')).toBe('true')

    fireEvent.keyDown(auto, { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(radios().getByRole('radio', { name: '1M' }))
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(twoHundred)

    expect(onChange.mock.calls.map(([value]) => value)).toEqual([
      '200000',
      '1000000',
      'auto',
      '1000000',
      '200000',
    ])
  })

  it('jumps to the ends with Home and End, ignores other keys, and never re-picks the choice', () => {
    const onChange = vi.fn()
    render(<Harness initial="200000" onChange={onChange} />)
    const twoHundred = radios().getByRole('radio', { name: '200K' })

    fireEvent.keyDown(twoHundred, { key: 'End' })
    expect(document.activeElement).toBe(radios().getByRole('radio', { name: '1M' }))
    fireEvent.keyDown(document.activeElement!, { key: 'Home' })
    expect(document.activeElement).toBe(radios().getByRole('radio', { name: 'Auto' }))

    fireEvent.keyDown(document.activeElement!, { key: 'a' })
    fireEvent.click(radios().getByRole('radio', { name: 'Auto' }))
    expect(onChange.mock.calls.map(([value]) => value)).toEqual(['1000000', 'auto'])
  })

  it('keeps the first option reachable when nothing is chosen', () => {
    render(<Harness initial="unknown" />)
    const options = radios().getAllByRole('radio')
    expect(options.map((option) => option.tabIndex)).toEqual([0, -1, -1])
    expect(options.every((option) => option.getAttribute('aria-checked') === 'false')).toBe(true)
  })
})
