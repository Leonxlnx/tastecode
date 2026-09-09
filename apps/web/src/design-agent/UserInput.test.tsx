// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { UserInput } from './UserInput.js'
import { IndeterminateRequestError } from '../transport.js'

afterEach(() => {
  cleanup()
  document.querySelector('.composer__box')?.remove()
})

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
  it('attaches the question card directly to the composer', () => {
    const composer = document.createElement('div')
    composer.className = 'composer__box'
    document.body.append(composer)

    render(<UserInput request={request} onSubmit={vi.fn()} />)

    expect(composer.querySelector('form[aria-label="Design brief questions"]')).toBeTruthy()
  })

  it('pages through one question at a time and preserves earlier answers', () => {
    render(<UserInput request={request} onSubmit={vi.fn()} />)

    expect(screen.getByText('Do you already have a palette?')).toBeTruthy()
    expect(screen.queryByText('Colour')).toBeNull()
    expect(screen.queryByText('Infer the strongest direction.')).toBeNull()
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

  it('uses the wheel to move only after the current question is answered', () => {
    const now = vi.spyOn(Date, 'now')
    now.mockReturnValueOnce(1_000).mockReturnValueOnce(1_500)
    render(<UserInput request={request} onSubmit={vi.fn()} />)

    const form = screen.getByRole('form', { name: 'Design brief questions' })
    fireEvent.wheel(form, { deltaY: 80 })
    expect(screen.getByText('Do you already have a palette?')).toBeTruthy()

    fireEvent.click(screen.getByRole('radio', { name: 'Decide for me' }))
    fireEvent.wheel(form, { deltaY: 80 })
    expect(screen.getByText('How should the page feel?')).toBeTruthy()

    fireEvent.wheel(form, { deltaY: -80 })
    expect(screen.getByText('Do you already have a palette?')).toBeTruthy()
    now.mockRestore()
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

    fireEvent.click(screen.getByRole('radio', { name: 'Write your own answer' }))
    expect(screen.getByRole('button', { name: 'Submit' }).hasAttribute('disabled')).toBe(true)
    const customAnswer = screen.getByRole('textbox', { name: /Custom answer/ })
    expect(customAnswer.getAttribute('placeholder')).toBe('Type your answer…')
    fireEvent.change(customAnswer, {
      target: { value: 'Deep green with warm ivory' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))

    expect(onSubmit).toHaveBeenCalledWith({ palette: ['Deep green with warm ivory'] })
  })

  it('restores the questions when answer submission fails', async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error('disconnected'))
    render(
      <UserInput
        request={{ ...request, questions: [request.questions[0]!] }}
        onSubmit={onSubmit}
      />,
    )

    fireEvent.click(screen.getByRole('radio', { name: /Decide for me/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Try again'))
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
    expect(onSubmit).toHaveBeenCalledTimes(2)
  })

  it('waits for history before retrying an indeterminate submission', async () => {
    const onSubmit = vi.fn().mockRejectedValue(new IndeterminateRequestError('disconnected'))
    const pending = { ...request, questions: [request.questions[0]!] }
    const view = render(<UserInput request={pending} onSubmit={onSubmit} />)

    fireEvent.click(screen.getByRole('radio', { name: /Decide for me/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))

    expect(await screen.findByText('Checking whether answers were received…')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Submit' })).toBeNull()

    view.rerender(<UserInput request={{ ...pending }} onSubmit={onSubmit} />)
    expect(await screen.findByRole('button', { name: 'Submit' })).toBeTruthy()
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })
})
