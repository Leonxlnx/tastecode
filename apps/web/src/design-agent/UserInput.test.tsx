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
    {
      id: 'tone',
      header: 'Tone',
      question: 'How should the page feel?',
      allowOther: false,
      secret: false,
      options: [
        { label: 'Editorial', description: 'Quiet and considered.' },
        { label: 'Energetic', description: 'Bold and active.' },
      ],
    },
    {
      id: 'priority',
      header: 'Priority',
      question: 'What matters most?',
      allowOther: false,
      secret: false,
      options: [
        { label: 'Clarity', description: 'Make the offer immediately clear.' },
        { label: 'Impact', description: 'Make the visual direction memorable.' },
      ],
    },
  ],
}

describe('briefing questions', () => {
  it('pages through one question at a time and preserves earlier answers', () => {
    render(<UserInput request={request} onSubmit={vi.fn()} />)

    expect(screen.getByText('Do you already have a palette?')).toBeTruthy()
    expect(screen.queryByText('How should the page feel?')).toBeNull()
    expect(screen.getByRole('button', { name: 'Next' }).hasAttribute('disabled')).toBe(true)

    fireEvent.click(screen.getByRole('radio', { name: /Decide for me/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))

    expect(screen.getByText('How should the page feel?')).toBeTruthy()
    expect(screen.getByText('Question 2 of 3')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect((screen.getByRole('radio', { name: /Decide for me/ }) as HTMLInputElement).checked).toBe(
      true,
    )
  })

  it('submits the complete batch only after the last question', () => {
    const onSubmit = vi.fn()
    render(<UserInput request={request} onSubmit={onSubmit} />)

    fireEvent.click(screen.getByRole('radio', { name: /Decide for me/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    fireEvent.click(screen.getByRole('radio', { name: /Editorial/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    fireEvent.click(screen.getByRole('radio', { name: /Clarity/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))

    expect(onSubmit).toHaveBeenCalledWith({
      palette: ['Decide for me'],
      tone: ['Editorial'],
      priority: ['Clarity'],
    })
    expect(screen.getByText('Submitting answers…')).toBeTruthy()
  })

  it('accepts a custom answer', () => {
    const onSubmit = vi.fn()
    render(
      <UserInput
        request={{ ...request, questions: [request.questions[0]!] }}
        onSubmit={onSubmit}
      />,
    )

    fireEvent.change(screen.getByRole('textbox', { name: /Custom answer/ }), {
      target: { value: 'Deep green with warm ivory' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))

    expect(onSubmit).toHaveBeenCalledWith({ palette: ['Deep green with warm ivory'] })
  })
})
