// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type {
  ChatImportChat,
  ChatImportJob,
  ChatImportScan,
  ChatImportSource,
} from '@harness/contracts'
import type { Transport } from '../transport.js'
import { ImportSettings } from './ImportSettings.js'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const codex: ChatImportSource = { id: 'codex', name: 'Codex', provider: 'codex', state: 'ready' }
const t3: ChatImportSource = { id: 't3-code', name: 'T3 Code', state: 'ready' }

function chat(id: string, overrides: Partial<ChatImportChat> = {}): ChatImportChat {
  return {
    id,
    source: 'codex',
    title: id,
    folder: '/work/site',
    provider: 'codex',
    createdAt: 1,
    updatedAt: Date.now() - 3_600_000,
    continuation: 'session',
    imported: false,
    ...overrides,
  }
}

const folders: ChatImportScan['folders'] = [
  { path: '/work/site', name: 'site', label: '~/site', isProject: false, missing: false },
  { path: '/work/gone', name: 'gone', label: '~/gone', isProject: true, missing: true },
]

function client(scans: ChatImportScan[] | (() => ChatImportScan)) {
  const pushes = new Map<string, (data: ChatImportJob) => void>()
  const queue = Array.isArray(scans) ? [...scans] : undefined
  const request = vi.fn(async (method: string, params: { chats?: string[] }) => {
    if (method === 'chatImport.scan') {
      if (!queue) return (scans as () => ChatImportScan)()
      return queue.length > 1 ? queue.shift() : queue[0]
    }
    if (method === 'chatImport.start') {
      return {
        state: 'running',
        done: 0,
        total: params.chats?.length ?? 0,
        imported: 0,
        failed: 0,
        projects: [],
      }
    }
    throw new Error(`unexpected ${method}`)
  })
  const transport = {
    state: 'open',
    request,
    on: vi.fn((channel: string, listener: (data: ChatImportJob) => void) => {
      pushes.set(channel, listener)
      return () => pushes.delete(channel)
    }),
    onState: vi.fn(() => () => {}),
  } as unknown as Transport
  return {
    transport,
    request,
    push: (job: ChatImportJob) => pushes.get('chatImport.progress')?.(job),
  }
}

function page(transport: Transport, onOpenChat: (threadId: string) => void = () => {}) {
  render(<ImportSettings transport={transport} onOpenChat={onOpenChat} />)
}

const filter = async () => within(await screen.findByRole('radiogroup', { name: 'Filter by app' }))

describe('Import chats settings', () => {
  it('leads with what it found, and filters the list by app', async () => {
    const { transport } = client([
      {
        sources: [codex, t3],
        chats: [
          chat('Fix the header'),
          chat('Trace the query', { source: 't3-code', folder: '/work/gone' }),
          chat('Already here', { imported: true }),
        ],
        folders,
      },
    ])
    page(transport)

    const strip = await filter()
    expect(strip.getByRole('radio', { name: /All apps\s*2/ })).toHaveProperty('tabIndex', 0)
    expect(strip.getByRole('radio', { name: /Codex\s*1/ })).toBeTruthy()
    expect(screen.getByText('New project')).toBeTruthy()
    expect(screen.getByText('Folder is gone')).toBeTruthy()

    fireEvent.click(strip.getByRole('radio', { name: /T3 Code/ }))
    expect(screen.queryByText('site')).toBeNull()
    expect(screen.getByText('gone')).toBeTruthy()
  })

  it('moves the filter with the arrow keys, as one radio group', async () => {
    const { transport } = client([{ sources: [codex, t3], chats: [chat('one')], folders }])
    page(transport)
    const strip = await filter()
    fireEvent.keyDown(strip.getByRole('radio', { name: /All apps/ }), { key: 'ArrowRight' })
    expect(strip.getByRole('radio', { name: /Codex/ }).getAttribute('aria-checked')).toBe('true')
    // A filter that wraps onto a second line moves with Up and Down too.
    fireEvent.keyDown(strip.getByRole('radio', { name: /Codex/ }), { key: 'ArrowDown' })
    expect(strip.getByRole('radio', { name: /T3 Code/ }).getAttribute('aria-checked')).toBe('true')
    fireEvent.keyDown(strip.getByRole('radio', { name: /T3 Code/ }), { key: 'ArrowUp' })
    expect(strip.getByRole('radio', { name: /Codex/ }).getAttribute('aria-checked')).toBe('true')
  })

  it('says what Import will do before it does it, then imports exactly that', async () => {
    const { transport, request } = client([
      { sources: [codex], chats: [chat('one'), chat('two')], folders },
    ])
    page(transport)
    await filter()
    expect(screen.getByRole('button', { name: 'Import' })).toHaveProperty('disabled', true)

    fireEvent.click(screen.getByRole('button', { name: /site/ }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'two' }))
    // The row leaves its app to the folder; a screen reader still hears it.
    expect(screen.getByRole('checkbox', { name: 'two', description: /^Codex, / })).toBeTruthy()
    expect(screen.getByText('1 chat from 1 folder · 1 new project')).toBeTruthy()
    expect(screen.getByText('1 of 2 chats', { selector: '.import-folder__count' })).toBeTruthy()
    const box = screen.getByRole<HTMLInputElement>('checkbox', {
      name: 'Select all chats in site',
    })
    expect(box.indeterminate).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Import 1 chat' }))
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('chatImport.start', { chats: ['two'] }),
    )
  })

  it('finds chats inside closed folders while searching', async () => {
    const { transport } = client([
      { sources: [codex], chats: [chat('Fix the header'), chat('Other')], folders },
    ])
    page(transport)
    await filter()
    expect(screen.queryByText('Fix the header')).toBeNull()
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'header' } })
    expect(screen.getByText('Fix the header')).toBeTruthy()
    expect(screen.queryByText('Other')).toBeNull()
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'nothing like it' } })
    expect(screen.getByText('No chats match that search.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }))
    expect(screen.getByRole<HTMLInputElement>('searchbox').value).toBe('')
    expect(screen.queryByText('No chats match that search.')).toBeNull()
  })

  it('leaves archived chats out until asked, because most people archived them on purpose', async () => {
    const { transport } = client([
      { sources: [codex], chats: [chat('one'), chat('old', { archived: true })], folders },
    ])
    page(transport)
    const strip = await filter()
    expect(strip.getByRole('radio', { name: /All apps\s*1/ })).toBeTruthy()
    fireEvent.click(screen.getByRole('checkbox', { name: /Include 1 archived chat/ }))
    expect(strip.getByRole('radio', { name: /All apps\s*2/ })).toBeTruthy()
  })

  it('explains Copy only when a listed chat is one', async () => {
    const { transport } = client([
      {
        sources: [t3],
        chats: [chat('one', { source: 't3-code', continuation: 'copy' })],
        folders,
      },
    ])
    page(transport)
    await filter()
    expect(screen.getByText(/A chat marked Copy/)).toBeTruthy()
  })

  it('shows progress at its true ratio, then what happened and the way to a chat', async () => {
    const finished: ChatImportScan = {
      sources: [codex],
      chats: [chat('one', { imported: true }), chat('two', { imported: true })],
      folders,
    }
    const { transport, push } = client([
      { sources: [codex], chats: [chat('one'), chat('two')], folders },
      finished,
    ])
    const onOpenChat = vi.fn()
    page(transport, onOpenChat)
    await filter()
    fireEvent.click(screen.getByRole('checkbox', { name: /Select all 2 chats/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Import 2 chats' }))
    await screen.findByText('Importing 0 of 2 chats')

    act(() =>
      push({
        state: 'running',
        done: 1,
        total: 2,
        imported: 1,
        failed: 0,
        projects: ['/work/site'],
      }),
    )
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('1')

    act(() =>
      push({
        state: 'finished',
        done: 2,
        total: 2,
        imported: 2,
        failed: 0,
        projects: ['/work/site'],
        thread: 'external:codex:two',
      }),
    )
    await screen.findByText('Imported 2 chats, adding 1 project.')
    await screen.findByText('Every chat here is already in TasteCode.')
    fireEvent.click(screen.getByRole('button', { name: 'Open newest chat' }))
    expect(onOpenChat).toHaveBeenCalledWith('external:codex:two')
  })

  it('says how many chats it could not read', async () => {
    const { transport, push } = client([{ sources: [codex], chats: [chat('one')], folders }])
    page(transport)
    await filter()
    act(() => push({ state: 'finished', done: 3, total: 3, imported: 2, failed: 1, projects: [] }))
    await screen.findByText(/Imported 2 chats\. 1 chat could not be read/)
  })

  it('says so when nothing at all could be read, with no chat to open', async () => {
    const { transport, push } = client([{ sources: [codex], chats: [chat('one')], folders }])
    page(transport)
    await filter()
    act(() => push({ state: 'finished', done: 2, total: 2, imported: 0, failed: 2, projects: [] }))
    await screen.findByText('2 chats could not be read.')
    expect(screen.queryByRole('button', { name: 'Open newest chat' })).toBeNull()
  })

  it('offers no Import when nothing is left to bring in', async () => {
    const { transport } = client([
      { sources: [codex], chats: [chat('one', { imported: true })], folders },
    ])
    page(transport)
    await screen.findByText('Every chat here is already in TasteCode.')
    expect(screen.queryByRole('button', { name: 'Import' })).toBeNull()
  })

  it('stops further choices while an import runs, also when it was started elsewhere', async () => {
    const { transport } = client([
      {
        sources: [codex],
        chats: [chat('one')],
        folders,
        job: { state: 'running', done: 1, total: 4, imported: 1, failed: 0, projects: [] },
      },
    ])
    page(transport)
    await screen.findByText('Importing 1 of 4 chats')
    expect(screen.getByRole('checkbox', { name: /Select all 1 chat/ })).toHaveProperty(
      'disabled',
      true,
    )
    expect(screen.getByRole('button', { name: 'Scan again' })).toHaveProperty('disabled', true)
  })

  it('does not repeat the result of an import from an earlier visit', async () => {
    const { transport } = client([
      {
        sources: [codex],
        chats: [chat('one')],
        folders,
        job: { state: 'finished', done: 1, total: 1, imported: 1, failed: 0, projects: [] },
      },
    ])
    page(transport)
    await filter()
    expect(screen.queryByText(/^Imported/)).toBeNull()
  })

  it('names a source it could not read without hiding the others', async () => {
    const { transport } = client([
      { sources: [codex, { ...t3, state: 'failed' }], chats: [chat('one')], folders },
    ])
    page(transport)
    await screen.findByText(/T3 Code could not be read/)
    expect(screen.getByRole('radio', { name: /T3 Code\s*–/ })).toBeTruthy()
    expect(screen.getByRole('radio', { name: /Codex\s*1/ })).toBeTruthy()
  })

  it('asks again while a first scan is still running, and stops when it is done', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { transport, request } = client([
      { sources: [{ ...codex, state: 'scanning' }], chats: [], folders: [] },
      { sources: [codex], chats: [chat('one')], folders },
    ])
    page(transport)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(screen.getByText('Still looking through saved chats…')).toBeTruthy()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000)
    })
    expect(screen.getByRole('radio', { name: /Codex\s*1/ })).toBeTruthy()
    const asked = request.mock.calls.length
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(request.mock.calls).toHaveLength(asked)
  })

  it('says when no app on this computer saved anything', async () => {
    const { transport } = client([{ sources: [], chats: [], folders: [] }])
    page(transport)
    await screen.findByText('No chats to import')
    expect(screen.queryByRole('button', { name: 'Import' })).toBeNull()
  })

  it('offers a retry when the scan itself fails', async () => {
    let attempts = 0
    const { transport } = client(() => {
      attempts += 1
      if (attempts === 1) throw new Error('The server did not reply.')
      return { sources: [codex], chats: [chat('one')], folders }
    })
    page(transport)
    await screen.findByText(/Could not look for chats/)
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await filter()
    expect(screen.queryByText(/Could not look for chats/)).toBeNull()
  })

  it('reports a refused start instead of pretending it ran', async () => {
    const { transport, request } = client([{ sources: [codex], chats: [chat('one')], folders }])
    page(transport)
    await filter()
    fireEvent.click(screen.getByRole('checkbox', { name: /Select all 1 chat/ }))
    request.mockRejectedValueOnce(new Error('An import is already running.'))
    fireEvent.click(screen.getByRole('button', { name: 'Import 1 chat' }))
    await screen.findByText('An import is already running.')
  })
})
