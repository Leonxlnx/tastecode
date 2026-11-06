// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { ThreadTile, threadTileMark, tileInitial } from './ThreadTile.js'

afterEach(cleanup)

describe('ThreadTile', () => {
  it('takes the first letter or digit of the project name', () => {
    expect(tileInitial('harbor-site')).toBe('H')
    expect(tileInitial('.dotfiles')).toBe('D')
    expect(tileInitial('3d-viewer')).toBe('3')
    expect(tileInitial('ö')).toBe('Ö')
    expect(tileInitial('')).toBe('')
  })

  it('gives every inbox state its own mark and none to idle', () => {
    expect(threadTileMark('starting')).toBe('working')
    expect(threadTileMark('working')).toBe('working')
    expect(threadTileMark('failed')).toBe('failed')
    expect(threadTileMark('input')).toBe('attention')
    expect(threadTileMark('approval')).toBe('attention')
    expect(threadTileMark('queued')).toBe('queued')
    expect(threadTileMark('ready')).toBe('done')
    expect(threadTileMark('idle')).toBe('none')
  })

  it('animates a state only when it changes, never when the row mounts', () => {
    const { container, rerender } = render(
      <ThreadTile image={undefined} name="Alpha" mark="working" />,
    )
    expect(container.querySelector('.thread-tile.is-working .thread-tile__ring')).not.toBeNull()
    expect(container.querySelector('.is-entering')).toBeNull()

    rerender(<ThreadTile image={undefined} name="Alpha" mark="failed" />)
    expect(
      container.querySelector('.thread-tile.is-failed .thread-tile__ring.is-entering'),
    ).not.toBeNull()

    rerender(<ThreadTile image={undefined} name="Alpha" mark="none" />)
    expect(container.querySelector('.thread-tile__ring')).toBeNull()
  })

  it('draws no ring once the work is done', () => {
    const { container } = render(<ThreadTile image={undefined} name="Alpha" mark="done" />)
    expect(container.querySelector('.thread-tile__ring')).toBeNull()
    expect(container.querySelector('.thread-tile__initial')?.textContent).toBe('A')
  })
})
