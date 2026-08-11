import { describe, expect, it } from 'vitest'
import { preserveProjectFileLinks, projectFileReference } from './project-file-link.js'

describe('project file links', () => {
  it('preserves file URLs before the Markdown parser blocks them', () => {
    expect(
      preserveProjectFileLinks(
        'Updated [index.html](file:///E:/randomtesting/A_personalharness/site/index.html).',
      ),
    ).toContain('/__harness/project-file/file%3A%2F%2F%2FE%3A%2Frandomtesting')
    expect(
      preserveProjectFileLinks(
        'Updated [index.html](<file:///E:/randomtesting/path%20with%20spaces/index.html>).',
      ),
    ).toBe(
      'Updated [index.html](/__harness/project-file/file%3A%2F%2F%2FE%3A%2Frandomtesting%2Fpath%2520with%2520spaces%2Findex.html).',
    )
  })

  it('accepts Windows files on another drive when they stay inside the project', () => {
    expect(
      projectFileReference(
        '/__harness/project-file/file%3A%2F%2F%2FE%3A%2Frandomtesting%2FA_personalharness%2Fsite%2Findex.html',
        'E:\\randomtesting\\A_personalharness\\site',
      ),
    ).toEqual({
      kind: 'safe',
      path: 'E:\\randomtesting\\A_personalharness\\site\\index.html',
    })
  })

  it('accepts macOS files inside the selected project', () => {
    expect(
      projectFileReference(
        '/Users/blue/Developer/site/src/index.ts:42',
        '/Users/blue/Developer/site',
      ),
    ).toEqual({ kind: 'safe', path: '/Users/blue/Developer/site/src/index.ts' })
  })

  it('blocks traversal, sibling, drive, and network paths with useful reasons', () => {
    const root = 'E:\\randomtesting\\A_personalharness\\site'
    const references = [
      projectFileReference('E:\\randomtesting\\A_personalharness\\site\\..\\secret.txt', root),
      projectFileReference('E:\\randomtesting\\A_personalharness\\sibling\\secret.txt', root),
      projectFileReference('C:\\other\\secret.txt', root),
      projectFileReference('file://server/share/secret.txt', root),
    ]

    expect(references.every((reference) => reference?.kind === 'blocked')).toBe(true)
    expect(
      references.map((reference) => reference?.kind === 'blocked' && reference.reason),
    ).toEqual([
      'This file is outside the selected project',
      'This file is outside the selected project',
      'This file is outside the selected project',
      'Network file links are not allowed',
    ])
  })
})
