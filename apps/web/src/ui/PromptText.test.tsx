// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { browserCommentBlock, newBrowserCommentId } from './browser-comments.js'
import { rememberChipTokens, resetRememberedChipTokens } from '../composer-chip-memory.js'
import { PromptText } from './PromptText.js'

beforeEach(() => {
  localStorage.clear()
  resetRememberedChipTokens()
})

afterEach(cleanup)

function renderPrompt(text: string) {
  return render(
    <p className="said__text">
      <PromptText text={text} />
    </p>,
  ).container.querySelector('.said__text')!
}

describe('PromptText', () => {
  it('draws the skills and command of a sent prompt as chips with icons', () => {
    const prompt = renderPrompt('$cook\n\n/design-taste-frontend')
    const chips = prompt.querySelectorAll('.prompt-chip')

    expect([...chips].map((chip) => chip.className)).toEqual([
      'prompt-chip prompt-chip--skill',
      'prompt-chip prompt-chip--command',
    ])
    expect(chips[0]!.querySelector('svg')).toBeTruthy()
    expect(chips[0]!.getAttribute('title')).toBe('$cook')
  })

  it('folds the blank line between two leading chips without losing it', () => {
    const text = '$cook\n\n/design-taste-frontend'
    const prompt = renderPrompt(text)

    expect(prompt.querySelector('.prompt-chip__gap')?.textContent).toBe('\n\n')
    expect(prompt.textContent).toBe(text)
  })

  it('keeps the prompt text exactly, markers included, for copying', () => {
    const text = '/goal $cook ship the landing page'
    const prompt = renderPrompt(text)

    expect(prompt.textContent).toBe(text)
    expect(prompt.querySelector('.prompt-chip__marker')?.textContent).toBe('/')
  })

  it('leaves a prompt without tokens as plain text', () => {
    const prompt = renderPrompt('echo $HOME, then ask @leon')

    expect(prompt.querySelector('.prompt-chip')).toBeNull()
    expect(prompt.textContent).toBe('echo $HOME, then ask @leon')
  })

  it('draws a token in the middle once it was sent as a chip from this device', () => {
    rememberChipTokens([{ token: '@officialDocs', kind: 'mcp' }])
    const prompt = renderPrompt('look it up in @officialDocs first')

    expect(prompt.querySelector('.prompt-chip--mcp')?.textContent).toBe('@officialDocs')
  })

  it('shows a sent annotation as a chip and opens its reference on keyboard focus', () => {
    const comment = {
      id: newBrowserCommentId(),
      comment: 'Tighten the heading',
      title: 'Coffee shop',
      url: 'http://127.0.0.1:6445/',
      selector: 'h1',
      text: 'Coffee',
    }
    const prompt = renderPrompt(browserCommentBlock(comment))
    expect(prompt.textContent).toBe(comment.comment)
    expect(prompt.textContent).not.toContain('Element:')
    fireEvent.focus(prompt.querySelector('.prompt-chip--browser')!)
    expect(screen.getByRole('tooltip').textContent).toContain('Coffee shop')
    expect(screen.getByRole('tooltip').textContent).toContain('1 element')
    fireEvent.keyDown(prompt.querySelector('.prompt-chip--browser')!, { key: 'Escape' })
    expect(screen.queryByRole('tooltip')).toBeNull()
  })
})
