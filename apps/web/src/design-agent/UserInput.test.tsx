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
  it.each(['constructor', '__proto__', 'toString'])('handles arbitrary question id %s', (id) => {
    const onSubmit = vi.fn()
    render(
      <UserInput
        request={{ ...request, questions: [{ ...request.questions[0]!, id }] }}
        onSubmit={onSubmit}
      />,
    )
    expect(screen.getByRole('button', { name: 'Submit' }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('radio', { name: 'Decide for me' }))
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
    expect(onSubmit).toHaveBeenCalledWith(Object.fromEntries([[id, ['Decide for me']]]))
  })

  it('toggles multiple options and includes Other without replacing them', () => {
    const onSubmit = vi.fn()
    render(
      <UserInput
        request={{ ...request, questions: [{ ...request.questions[0]!, multiSelect: true }] }}
        onSubmit={onSubmit}
      />,
    )
    fireEvent.click(screen.getByRole('checkbox', { name: 'Decide for me' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'I have colours' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Decide for me' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Write your own answer' }))
    fireEvent.change(screen.getByRole('textbox', { name: /Custom answer/ }), {
      target: { value: '  Green  ' },
    })
    expect(
      (screen.getByRole('checkbox', { name: 'I have colours' }) as HTMLInputElement).checked,
    ).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
    expect(onSubmit).toHaveBeenCalledWith({ palette: ['I have colours', 'Green'] })
  })

  it('attaches the question card directly to the composer', () => {
    const composer = document.createElement('div')
    composer.className = 'composer__box'
    document.body.append(composer)

    render(<UserInput request={request} onSubmit={vi.fn()} />)

    expect(composer.querySelector('form[aria-label="Design brief questions"]')).toBeTruthy()
  })

  it('keeps an inline question card out of the main composer', () => {
    const composer = document.createElement('div')
    composer.className = 'composer__box'
    document.body.append(composer)

    const view = render(<UserInput request={request} onSubmit={vi.fn()} inline />)

    expect(composer.querySelector('form')).toBeNull()
    expect(view.container.querySelector('form[aria-label="Design brief questions"]')).toBeTruthy()
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

  it('keeps a custom answer open while typing through an option label', () => {
    const onSubmit = vi.fn()
    render(
      <UserInput
        request={{ ...request, questions: request.questions.slice(0, 2) }}
        onSubmit={onSubmit}
      />,
    )

    fireEvent.click(screen.getByRole('radio', { name: 'Write your own answer' }))
    const customAnswer = screen.getByRole('textbox', { name: /Custom answer/ })
    const text = 'I have colours, use green'
    for (let length = 1; length <= text.length; length += 1) {
      fireEvent.change(customAnswer, { target: { value: text.slice(0, length) } })
      expect(screen.getByRole('textbox', { name: /Custom answer/ })).toBe(customAnswer)
      expect(document.activeElement).toBe(customAnswer)
      expect(
        (screen.getByRole('radio', { name: 'I have colours' }) as HTMLInputElement).checked,
      ).toBe(false)
    }

    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    fireEvent.click(screen.getByRole('radio', { name: 'Editorial' }))
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect((screen.getByRole('textbox', { name: /Custom answer/ }) as HTMLInputElement).value).toBe(
      text,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))

    expect(onSubmit).toHaveBeenCalledWith({ palette: [text], tone: ['Editorial'] })
  })

  it('lets an explicit option choice replace matching custom text', () => {
    render(<UserInput request={request} onSubmit={vi.fn()} />)

    fireEvent.click(screen.getByRole('radio', { name: 'Write your own answer' }))
    fireEvent.change(screen.getByRole('textbox', { name: /Custom answer/ }), {
      target: { value: 'I have colours' },
    })
    expect(screen.getByRole('textbox', { name: /Custom answer/ })).toBeTruthy()
    fireEvent.click(screen.getByRole('radio', { name: 'I have colours' }))
    expect(screen.queryByRole('textbox', { name: /Custom answer/ })).toBeNull()
    expect(
      (screen.getByRole('radio', { name: 'I have colours' }) as HTMLInputElement).checked,
    ).toBe(true)

    fireEvent.click(screen.getByRole('radio', { name: 'Write your own answer' }))
    expect((screen.getByRole('textbox', { name: /Custom answer/ }) as HTMLInputElement).value).toBe(
      '',
    )
    expect(screen.getByRole('button', { name: 'Next' }).hasAttribute('disabled')).toBe(true)
  })

  it('preserves custom mode on refresh and resets it for a new request key', () => {
    const onSubmit = vi.fn()
    const view = render(<UserInput key={request.id} request={request} onSubmit={onSubmit} />)

    fireEvent.click(screen.getByRole('radio', { name: 'Write your own answer' }))
    fireEvent.change(screen.getByRole('textbox', { name: /Custom answer/ }), {
      target: { value: 'I have colours' },
    })
    view.rerender(<UserInput key={request.id} request={{ ...request }} onSubmit={onSubmit} />)
    expect((screen.getByRole('textbox', { name: /Custom answer/ }) as HTMLInputElement).value).toBe(
      'I have colours',
    )

    const nextRequest = { ...request, id: 'brief-2' }
    view.rerender(<UserInput key={nextRequest.id} request={nextRequest} onSubmit={onSubmit} />)
    expect(screen.queryByRole('textbox', { name: /Custom answer/ })).toBeNull()
    expect(
      screen.getAllByRole('radio').every((radio) => !(radio as HTMLInputElement).checked),
    ).toBe(true)
    expect(screen.getByRole('button', { name: 'Next' }).hasAttribute('disabled')).toBe(true)
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
