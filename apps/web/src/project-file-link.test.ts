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
    expect(
      preserveProjectFileLinks(
        'Updated [panel](<file:///E:/randomtesting/path with spaces/panel(test).tsx>).',
      ),
    ).toBe(
      'Updated [panel](/__harness/project-file/file%3A%2F%2F%2FE%3A%2Frandomtesting%2Fpath%20with%20spaces%2Fpanel%28test%29.tsx).',
    )
    expect(preserveProjectFileLinks('Updated [panel](E:/randomtesting/panel(test).tsx).')).toBe(
      'Updated [panel](/__harness/project-file/E%3A%2Frandomtesting%2Fpanel%28test%29.tsx).',
    )
  })

  it('does not rewrite link examples inside inline or fenced code', () => {
    const markdown = [
      '`[inline](file:///E:/project/inline.ts)`',
      '    [indented](file:///E:/project/indented.ts)',
      '```md',
      '```not-a-close',
      '[fenced](file:///E:/project/fenced.ts)',
      '```',
      '> ~~~md',
      '> [quoted](file:///E:/project/quoted.ts)',
      '> ~~~',
      '- ~~~md',
      '  [listed](file:///E:/project/listed.ts)',
      '  ~~~',
      '[real](file:///E:/project/real.ts)',
    ].join('\n')

    const preserved = preserveProjectFileLinks(markdown)
    expect(preserved).toContain('`[inline](file:///E:/project/inline.ts)`')
    expect(preserved).toContain('[indented](file:///E:/project/indented.ts)')
    expect(preserved).toContain('[fenced](file:///E:/project/fenced.ts)')
    expect(preserved).toContain('[quoted](file:///E:/project/quoted.ts)')
    expect(preserved).toContain('[listed](file:///E:/project/listed.ts)')
    expect(preserved).toContain(
      '[real](/__harness/project-file/file%3A%2F%2F%2FE%3A%2Fproject%2Freal.ts)',
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
