import { describe, expect, it } from 'vitest'
import { chatToMarkdown, exportFilename } from './chat-export.js'

describe('chatToMarkdown', () => {
  it('keeps the conversation and the visible work, drops the noise', () => {
    const markdown = chatToMarkdown('Fix login', [
      {
        id: '1',
        turnId: 't1',
        type: 'message',
        status: 'completed',
        role: 'user',
        text: 'Fix the login bug',
        createdAt: 1,
      },
      {
        id: '2',
        turnId: 't1',
        type: 'reasoning',
        status: 'completed',
        text: 'private thinking',
        createdAt: 2,
      },
      {
        id: '3',
        turnId: 't1',
        type: 'command',
        status: 'completed',
        command: 'pnpm test',
        exitCode: 1,
        createdAt: 3,
      },
      {
        id: '4',
        turnId: 't1',
        type: 'file_change',
        status: 'completed',
        path: 'src/auth.ts',
        linesAdded: 4,
        linesRemoved: 1,
        createdAt: 4,
      },
      {
        id: '5',
        turnId: 't1',
        type: 'message',
        status: 'completed',
        role: 'assistant',
        text: 'Done - the token check was inverted.',
        createdAt: 5,
      },
    ])

    expect(markdown).toContain('# Fix login')
    expect(markdown).toContain('## You')
    expect(markdown).toContain('Fix the login bug')
    expect(markdown).toContain('$ pnpm test # exit 1')
    expect(markdown).toContain('> Edited `src/auth.ts` (+4 -1)')
    expect(markdown).toContain('## Assistant')
    expect(markdown).not.toContain('private thinking')
  })
})

describe('exportFilename', () => {
  it('slugs the title and stamps the date', () => {
    expect(exportFilename('Fix: the Login Bug!', new Date('2026-08-07T03:00:00Z'))).toBe(
      'fix-the-login-bug-2026-08-07.md',
    )
  })

  it('falls back when the title has nothing usable', () => {
    expect(exportFilename('???', new Date('2026-08-07T03:00:00Z'))).toBe('chat-2026-08-07.md')
  })
})
