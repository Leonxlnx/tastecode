import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('./app-update-toast.css', import.meta.url), 'utf8')
const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')

function rule(selector: string): string {
  const start = css.indexOf(`${selector} {`)
  if (start < 0) return ''
  return css.slice(start, css.indexOf('\n}', start))
}

describe('the app update notice', () => {
  it('sits centred under the header, away from every composer', () => {
    const notice = rule('.notice.notice--app-update')
    // Composers dock at the bottom of each pane, the right one in the window's
    // bottom-right corner in split view, where other notices default to.
    expect(notice).toContain('top: 54px')
    expect(notice).toContain('bottom: auto')
    expect(notice).toContain('right: auto')
    expect(notice).toContain('left: 50%')
    expect(notice).toContain('translate: -50% 0')
  })

  it('waits below an open deleted-chat toast instead of under it', () => {
    const stacked = rule(".notice.notice--app-update:has(~ .notice--archive[data-state='open'])")
    expect(stacked).toContain('top: 100px')
    // The sibling selector needs the update notice first in the document.
    const update = app.indexOf('<AppUpdateToast')
    const archive = app.indexOf('<ArchiveToast')
    expect(update).toBeGreaterThan(-1)
    expect(archive).toBeGreaterThan(update)
  })
})
