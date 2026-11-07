import { describe, expect, it } from 'vitest'
import { ChatImportScanSchema } from './chat-import.js'
import { channels, methods } from './protocol.js'

describe('chat import contracts', () => {
  it('reads a scan with a chat two sources saved', () => {
    const scan = ChatImportScanSchema.parse({
      sources: [{ id: 't3-code', name: 'T3 Code', state: 'ready' }],
      chats: [
        {
          id: 't3-code:thread-1',
          source: 't3-code',
          alsoIn: ['codex'],
          title: 'Fix the build',
          folder: '/work/site',
          provider: 'codex',
          createdAt: 1,
          updatedAt: 2,
          continuation: 'session',
          imported: false,
        },
      ],
      folders: [{ path: '/work/site', name: 'site', isProject: false, missing: false }],
    })
    expect(scan.chats[0]?.alsoIn).toEqual(['codex'])
    expect(scan.job).toBeUndefined()
  })

  it('takes chat ids and never a path to read', () => {
    const params = methods['chatImport.start'].params
    expect(params.safeParse({ chats: ['codex:session-1'] }).success).toBe(true)
    expect(params.safeParse({ chats: [] }).success).toBe(false)
    expect(params.parse({ chats: ['codex:session-1'], path: '/etc/passwd' })).toEqual({
      chats: ['codex:session-1'],
    })
  })

  it('reports progress on its own channel', () => {
    const job = { state: 'running', done: 1, total: 3, imported: 1, failed: 0, projects: [] }
    expect(channels['chatImport.progress'].parse(job)).toEqual(job)
  })
})
