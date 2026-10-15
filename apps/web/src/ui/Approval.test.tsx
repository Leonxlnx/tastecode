// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ApprovalRequest } from '@harness/contracts'
import { Approval } from './Approval.js'

afterEach(cleanup)

const requests = {
  command: {
    id: 'approval-command',
    kind: 'command',
    createdAt: 10,
    command: 'pnpm test',
    cwd: '/workspace',
  },
  write: {
    id: 'approval-write',
    kind: 'file_change',
    createdAt: 10,
    path: 'src/pricing.ts',
  },
  network: {
    id: 'approval-network',
    kind: 'permissions',
    createdAt: 10,
    cwd: '/workspace',
    command: 'Requested access:\n{ "network": { "enabled": true } }',
  },
  mcp: {
    id: 'approval-mcp',
    kind: 'permissions',
    createdAt: 10,
    reason: 'Reads one file.',
    command: 'Allow the figma MCP server to run get_file?',
  },
} satisfies Record<string, ApprovalRequest>

describe('Approval', () => {
  it('gives the two secondary decisions the same solid button treatment', () => {
    render(<Approval request={requests.command} onDecide={vi.fn()} />)

    const stop = screen.getByRole('button', { name: 'Stop the turn' })
    const session = screen.getByRole('button', { name: 'Always this session' })
    expect(stop.className).toBe('approval__secondary-action')
    expect(session.className).toBe(stop.className)
  })

  it.each(Object.entries(requests))(
    'keeps Allow once as the only primary decision on a %s request',
    (_name, request) => {
      const onDecide = vi.fn()
      render(<Approval request={request} onDecide={onDecide} />)

      const buttons = screen.getAllByRole('button')
      expect(buttons.map((button) => button.textContent)).toEqual([
        'Deny',
        'Stop the turn',
        'Always this session',
        'Allow once',
      ])
      expect(buttons.filter((button) => button.classList.contains('btn'))).toEqual([
        screen.getByRole('button', { name: 'Allow once' }),
      ])
      for (const name of ['Deny', 'Stop the turn', 'Always this session']) {
        expect(screen.getByRole('button', { name }).className).toBe('approval__secondary-action')
      }
      // Nothing is focused for the user: a held Enter must not answer the card.
      expect(buttons).not.toContain(document.activeElement)

      fireEvent.click(screen.getByRole('button', { name: 'Deny' }))
      expect(onDecide).toHaveBeenCalledWith('deny')
    },
  )
})
