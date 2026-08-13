// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CustomModelForm } from './CustomModelForm.js'

afterEach(cleanup)

describe('CustomModelForm', () => {
  it('uses the shared provider picker with keyboard selection and focus return', () => {
    const onAdd = vi.fn()
    render(
      <CustomModelForm
        providers={[
          { id: 'codex', name: 'Codex' },
          { id: 'grok', name: 'Grok' },
          { id: 'claude-code', name: 'Claude Code' },
        ]}
        onAdd={onAdd}
      />,
    )

    const trigger = screen.getByRole('combobox', { name: 'Provider' })
    expect(trigger.textContent).toContain('Codex')
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })

    const codex = screen.getByRole('option', { name: 'Codex' })
    const grok = screen.getByRole('option', { name: 'Grok' })
    expect(codex.getAttribute('aria-selected')).toBe('true')
    expect(codex.classList.contains('is-active')).toBe(true)
    expect(codex.querySelector('svg')).toBeTruthy()
    expect(trigger.getAttribute('aria-activedescendant')).toBe(codex.id)

    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    expect(trigger.getAttribute('aria-activedescendant')).toBe(grok.id)
    fireEvent.keyDown(trigger, { key: 'Enter' })
    expect(trigger.textContent).toContain('Grok')

    fireEvent.click(trigger)
    fireEvent.keyDown(trigger, { key: 'Escape' })
    expect(document.activeElement).toBe(trigger)

    fireEvent.change(screen.getByLabelText('Model id'), { target: { value: 'grok-beta' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add model' }))
    expect(onAdd).toHaveBeenCalledWith({ provider: 'grok', modelId: 'grok-beta', displayName: '' })
  })
})
