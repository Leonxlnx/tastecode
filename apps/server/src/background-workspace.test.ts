import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isBackgroundWorkspace } from './background-workspace.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function folder(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'harness-background-'))
  roots.push(root)
  return root
}

describe('a background writing folder', () => {
  it('is one in the temporary folder, also once it is gone', () => {
    const temporary = folder()
    expect(
      isBackgroundWorkspace(path.join(temporary, 'tastecode-background-ABC123'), temporary),
    ).toBe(true)
  })

  it('is not a project of the user’s that has the same name', () => {
    const temporary = folder()
    const projects = folder()
    const project = path.join(projects, 'tastecode-background-ABC123')
    mkdirSync(project)
    expect(isBackgroundWorkspace(project, temporary)).toBe(false)
  })

  it('is found under another spelling of the temporary folder', (context) => {
    const temporary = folder()
    const elsewhere = folder()
    const link = path.join(elsewhere, 'temp-link')
    try {
      symlinkSync(temporary, link, 'dir')
    } catch {
      // Windows without Developer Mode or admin rights cannot create one.
      context.skip()
    }
    expect(isBackgroundWorkspace(path.join(link, 'tastecode-background-ABC123'), temporary)).toBe(
      true,
    )
    expect(
      isBackgroundWorkspace(
        path.join(realpathSync(temporary), 'tastecode-background-ABC123'),
        link,
      ),
    ).toBe(true)
  })

  it('needs the name: other folders in the temporary folder are not', () => {
    const temporary = folder()
    expect(
      isBackgroundWorkspace(path.join(temporary, 'tastecode-background-notes'), temporary),
    ).toBe(false)
    expect(isBackgroundWorkspace(path.join(temporary, 'project'), temporary)).toBe(false)
  })
})
