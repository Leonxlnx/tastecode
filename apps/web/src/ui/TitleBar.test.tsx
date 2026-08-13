// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TitleBar } from './TitleBar.js'

afterEach(cleanup)

describe('TitleBar', () => {
  it('keeps workspace tools out of native window chrome', () => {
    const onToggleRail = vi.fn()
    render(<TitleBar collapsed={false} onToggleRail={onToggleRail} />)

    fireEvent.click(screen.getByRole('button', { name: 'Hide sidebar' }))
    expect(onToggleRail).toHaveBeenCalledOnce()
    expect(screen.queryByRole('button', { name: /workspace/i })).toBeNull()
  })
})
