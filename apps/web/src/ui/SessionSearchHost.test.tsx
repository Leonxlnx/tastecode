// @vitest-environment happy-dom
import { createRef, useRef, useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Transport } from '../transport.js'
import { SessionSearchHost, type SessionSearchHandle } from './SessionSearchHost.js'

const PROJECTS = [
  {
    path: 'D:\\repo',
    name: 'TasteCode',
    sessions: [
      {
        id: 'thread-1',
        title: 'Regression planning',
        provider: 'codex' as const,
        createdAt: 44,
      },
    ],
  },
]

const transport = {
  request: vi.fn(async () => ({ results: [], nextCursor: null })),
} as unknown as Transport

function SearchHost(props: { onSelect?: () => void }) {
  const search = useRef<SessionSearchHandle>(null)
  return (
    <>
      <button type="button" onClick={() => search.current?.open()}>
        Search chats
      </button>
      <SessionSearchHost
        ref={search}
        transport={transport}
        projects={PROJECTS}
        onSelect={() => props.onSelect?.()}
      />
    </>
  )
}

describe('SessionSearchHost focus restoration', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it.each([
    ['Escape', (input: HTMLElement) => fireEvent.keyDown(input, { key: 'Escape' })],
    ['scrim click', () => fireEvent.click(screen.getByRole('button', { name: 'Close search' }))],
    ['close button click', () => fireEvent.click(screen.getByRole('button', { name: 'Close' }))],
  ])('returns focus to the invoking control after %s', async (_path, close) => {
    render(<SearchHost />)
    const opener = screen.getByRole('button', { name: 'Search chats' })
    opener.focus()
    fireEvent.click(opener)
    const input = await screen.findByRole('combobox', { name: 'Search every chat' })
    expect(document.activeElement).toBe(input)

    close(input)

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(document.activeElement).toBe(opener)
  })

  it('returns focus after selecting a result', async () => {
    render(<SearchHost />)
    const opener = screen.getByRole('button', { name: 'Search chats' })
    opener.focus()
    fireEvent.click(opener)
    const input = await screen.findByRole('combobox', { name: 'Search every chat' })
    fireEvent.change(input, { target: { value: 'regression' } })

    fireEvent.click(screen.getByRole('option', { name: /Regression planning/ }))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(document.activeElement).toBe(opener)
  })

  it('uses the inbox search control when a programmatic opener is unavailable', async () => {
    const search = createRef<SessionSearchHandle>()
    render(
      <>
        <input aria-label="Search threads" />
        <SessionSearchHost
          ref={search}
          transport={transport}
          projects={PROJECTS}
          onSelect={() => undefined}
        />
      </>,
    )
    act(() => search.current?.open())
    const input = await screen.findByRole('combobox', { name: 'Search every chat' })

    fireEvent.keyDown(input, { key: 'Escape' })

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Search threads' }))
  })

  it('skips an inert sidebar fallback when the rail is collapsed', async () => {
    const search = createRef<SessionSearchHandle>()
    render(
      <>
        <nav inert>
          <input aria-label="Search threads" />
        </nav>
        <textarea placeholder="Do anything" />
        <SessionSearchHost
          ref={search}
          transport={transport}
          projects={PROJECTS}
          onSelect={() => undefined}
        />
      </>,
    )
    act(() => search.current?.open())
    const input = await screen.findByRole('combobox', { name: 'Search every chat' })

    fireEvent.keyDown(input, { key: 'Escape' })

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(document.activeElement).toBe(screen.getByPlaceholderText('Do anything'))
  })

  it('falls back when the invoking control unmounts after selection', async () => {
    function TasteCode() {
      const search = useRef<SessionSearchHandle>(null)
      const [showOpener, setShowOpener] = useState(true)
      return (
        <>
          {showOpener ? (
            <button type="button" onClick={() => search.current?.open()}>
              Temporary opener
            </button>
          ) : null}
          <input aria-label="Search threads" />
          <SessionSearchHost
            ref={search}
            transport={transport}
            projects={PROJECTS}
            onSelect={() => setShowOpener(false)}
          />
        </>
      )
    }
    render(<TasteCode />)
    const opener = screen.getByRole('button', { name: 'Temporary opener' })
    opener.focus()
    fireEvent.click(opener)
    fireEvent.change(await screen.findByRole('combobox', { name: 'Search every chat' }), {
      target: { value: 'regression' },
    })

    fireEvent.click(screen.getByRole('option', { name: /Regression planning/ }))

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Temporary opener' })).toBeNull(),
    )
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Search threads' }))
  })

  it('does not steal focus selected by result navigation', async () => {
    const outside = createRef<HTMLButtonElement>()
    render(
      <>
        <button type="button" aria-label="Search chats" />
        <button ref={outside} type="button">
          Navigated target
        </button>
        <SearchHost onSelect={() => outside.current?.focus()} />
      </>,
    )
    const opener = screen.getAllByRole('button', { name: 'Search chats' }).at(-1)!
    opener.focus()
    fireEvent.click(opener)
    fireEvent.change(await screen.findByRole('combobox', { name: 'Search every chat' }), {
      target: { value: 'regression' },
    })

    fireEvent.click(screen.getByRole('option', { name: /Regression planning/ }))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(document.activeElement).toBe(outside.current)
  })
})
