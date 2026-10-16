import { describe, expect, it } from 'vitest'
import { parseFeedbackCommand } from './feedback-command.js'

describe('parseFeedbackCommand', () => {
  it('opens an empty dialog for the bare command, in any case', () => {
    expect(parseFeedbackCommand('/feedback')).toEqual({ text: '' })
    expect(parseFeedbackCommand('  /Feedback  ')).toEqual({ text: '' })
  })

  it('carries the rest of the draft into the dialog', () => {
    expect(parseFeedbackCommand('/feedback export does nothing')).toEqual({
      text: 'export does nothing',
    })
    expect(parseFeedbackCommand('/feedback\nline one\nline two')).toEqual({
      text: 'line one\nline two',
    })
  })

  it('leaves ordinary text and other slash commands for the provider', () => {
    expect(parseFeedbackCommand('/feedbacks')).toBeUndefined()
    expect(parseFeedbackCommand('please /feedback this')).toBeUndefined()
    expect(parseFeedbackCommand('/review')).toBeUndefined()
  })
})
