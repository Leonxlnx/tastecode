import { describe, expect, it } from 'vitest'
import { parseSideChatCommand } from './side-chat-command.js'

describe('parseSideChatCommand', () => {
  it('opens an empty side chat for the standalone command and its alias', () => {
    expect(parseSideChatCommand('/side')).toEqual({ prompt: '' })
    expect(parseSideChatCommand('  /btw')).toEqual({ prompt: '' })
  })

  it('keeps an inline follow-up as the first side-chat prompt', () => {
    expect(parseSideChatCommand('/side why did that test fail?')).toEqual({
      prompt: 'why did that test fail?',
    })
    expect(parseSideChatCommand('/btw\ncheck the logs')).toEqual({ prompt: 'check the logs' })
  })

  it('does not steal ordinary text or longer slash command names', () => {
    expect(parseSideChatCommand('please use /side')).toBeUndefined()
    expect(parseSideChatCommand('/sidebar')).toBeUndefined()
  })
})
