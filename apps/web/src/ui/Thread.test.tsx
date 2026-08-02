// @vitest-environment happy-dom
import { fireEvent, render } from '@testing-library/react'
import type { Item } from '@harness/contracts'
import { describe, expect, it } from 'vitest'
import { WorkedTranscript } from './WorkedTranscript.js'

const item = (overrides: Partial<Item> & Pick<Item, 'id' | 'type'>): Item =>
  ({
    turnId: 'turn',
    status: 'completed',
    createdAt: 1_000,
    ...overrides,
  }) as Item

describe('completed turn transcript', () => {
  it('keeps commentary and every grouped tool call in reading order', () => {
    const items = [
      item({
        id: 'update',
        type: 'message',
        role: 'assistant',
        text: 'I found the cause.',
      }),
      item({
        id: 'command-1',
        type: 'command',
        command: 'pnpm typecheck',
        text: 'types clean',
      }),
      item({ id: 'command-2', type: 'command', command: 'pnpm test', text: 'tests clean' }),
    ]
    const { container } = render(<WorkedTranscript items={items} />)

    expect(container.textContent).toContain('I found the cause.')
    expect(container.textContent).toContain('pnpm test')
    expect(container.textContent).toContain('+1 previous tool call')
    expect(container.querySelectorAll('.activity__tool-row')).toHaveLength(1)

    const toggle = container.querySelector<HTMLButtonElement>('.activity__previous-toggle')
    fireEvent.click(toggle!)

    expect(container.querySelectorAll('.activity__tool-row')).toHaveLength(2)
    expect(container.textContent).toContain('pnpm typecheck')
    expect(toggle?.textContent).toContain('Show fewer tool calls')
  })

  it('opens file changes with the same inline detail treatment as commands', () => {
    const fileChange = item({
      id: 'file-change',
      type: 'file_change',
      path: 'apps/web/src/ui/Thread.tsx',
    })
    const { container } = render(<WorkedTranscript items={[fileChange]} />)

    const row = container.querySelector<HTMLDetailsElement>('.activity__tool-row')
    expect(row?.textContent).toContain('File Change')
    expect(row?.querySelector('pre')?.textContent).toContain('apps/web/src/ui/Thread.tsx')
    expect(row?.open).toBe(false)
  })
})
