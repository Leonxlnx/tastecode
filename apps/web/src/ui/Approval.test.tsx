// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { Approval } from './Approval.js'

afterEach(cleanup)

describe('Approval', () => {
  it('gives the two secondary decisions the same solid button treatment', () => {
    render(
      <Approval
        request={{
          id: 'approval-1',
          kind: 'command',
          createdAt: 10,
          command: 'pnpm test',
          cwd: '/workspace',
        }}
        onDecide={vi.fn()}
      />,
    )

    const stop = screen.getByRole('button', { name: 'Stop the turn' })
    const session = screen.getByRole('button', { name: 'Always this session' })
    expect(stop.className).toBe('approval__secondary-action')
    expect(session.className).toBe(stop.className)
  })
})
