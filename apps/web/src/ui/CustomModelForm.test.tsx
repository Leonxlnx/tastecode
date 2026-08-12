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

    const trigger = screen.getByRole('button', { name: 'Provider, Codex' })
    expect(screen.queryByRole('combobox')).toBeNull()
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })

    const codex = screen.getByRole('menuitemradio', { name: 'Codex' })
    const grok = screen.getByRole('menuitemradio', { name: 'Grok' })
    expect(codex.getAttribute('aria-checked')).toBe('true')
    expect(codex.classList.contains('is-active')).toBe(true)
    expect(codex.querySelector('svg')).toBeTruthy()
    expect(document.activeElement).toBe(codex)

    fireEvent.keyDown(codex, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(grok)
    fireEvent.keyDown(grok, { key: 'Enter' })
    expect(screen.getByRole('button', { name: 'Provider, Grok' })).toBeTruthy()

    const grokTrigger = screen.getByRole('button', { name: 'Provider, Grok' })
    fireEvent.click(grokTrigger)
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    expect(document.activeElement).toBe(grokTrigger)

    fireEvent.change(screen.getByLabelText('Model id'), { target: { value: 'grok-beta' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add model' }))
    expect(onAdd).toHaveBeenCalledWith({ provider: 'grok', modelId: 'grok-beta', displayName: '' })
  })
})
