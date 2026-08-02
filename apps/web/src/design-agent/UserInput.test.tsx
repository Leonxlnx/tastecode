// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { UserInput } from './UserInput.js'

afterEach(cleanup)

const request = {
  id: 'brief-1',
  turnId: 'turn-1',
  autoResolutionMs: null,
  createdAt: 1,
  questions: [
    {
      id: 'palette',
      header: 'Colour',
      question: 'Do you already have a palette?',
      allowOther: true,
      secret: false,
      options: [
        { label: 'Decide for me', description: 'Infer the strongest direction.' },
        { label: 'I have colours', description: 'Add a custom answer.' },
      ],
    },
  ],
}

describe('briefing questions', () => {
  it('submits a generated choice to the waiting request', () => {
    const onSubmit = vi.fn()
    render(<UserInput request={request} onSubmit={onSubmit} />)

    fireEvent.click(screen.getByRole('radio', { name: /Decide for me/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Continue briefing' }))

    expect(onSubmit).toHaveBeenCalledWith({ palette: ['Decide for me'] })
  })

  it('accepts a custom answer instead of a generated choice', () => {
    const onSubmit = vi.fn()
    render(<UserInput request={request} onSubmit={onSubmit} />)

    fireEvent.change(screen.getByRole('textbox', { name: /Custom answer/ }), {
      target: { value: 'Deep green with warm ivory' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Continue briefing' }))

    expect(onSubmit).toHaveBeenCalledWith({ palette: ['Deep green with warm ivory'] })
  })
})
