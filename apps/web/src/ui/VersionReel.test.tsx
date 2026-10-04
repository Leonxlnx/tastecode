// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { alignVersions, CountReel, VersionTarget } from './VersionReel.js'

afterEach(cleanup)

function wheels(from: string, to: string) {
  return alignVersions(from, to).flatMap((column) =>
    column.kind === 'wheel' ? [`${column.from || '_'}${column.to || '_'}${column.order}`] : [],
  )
}

describe('version reel', () => {
  it('turns only the characters that differ, from the right', () => {
    expect(wheels('0.158.0', '0.159.0')).toEqual(['890'])
    expect(wheels('2.0.14', '2.0.21')).toEqual(['121', '410'])
  })

  it('right-aligns digits within a part so units meet units', () => {
    expect(wheels('0.9.0', '0.11.0')).toEqual(['_11', '910'])
    expect(wheels('1.10.0', '1.9.0')).toEqual(['1_1', '090'])
  })

  it('opens and closes columns for parts only one version has', () => {
    expect(wheels('1.2', '1.2.1')).toEqual(['_.1', '_10'])
    expect(wheels('1.0.0-beta.2', '1.0.0')).toEqual([
      '-_6',
      'b_5',
      'e_4',
      't_3',
      'a_2',
      '._1',
      '2_0',
    ])
  })

  it('brings forward every part of the new version that changed', () => {
    const view = render(<VersionTarget from="0.158.0" to="0.159.0" />)
    const runs = [...view.container.querySelectorAll('.version-target > span')].map((span) => [
      span.textContent,
      span.hasAttribute('data-changed'),
    ])
    expect(runs).toEqual([
      ['0.', false],
      ['159', true],
      ['.0', false],
    ])
  })

  it('mounts a fresh reel for each change of a count', () => {
    const view = render(<CountReel value={3} />)
    const first = view.container.querySelector('.version-reel')
    expect(first?.querySelector('.version-reel__wheel')).toBeNull()
    view.rerender(<CountReel value={2} />)
    const second = view.container.querySelector('.version-reel')
    expect(second).not.toBe(first)
    expect(second?.querySelector('.version-reel__strip')?.textContent).toBe('32')
  })
})
