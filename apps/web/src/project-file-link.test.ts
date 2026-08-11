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
      '',
      '    [indented](file:///E:/project/indented.ts)',
      '',
      '-     [list-indented](file:///E:/project/list-indented.ts)',
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
      '\\](file:///E:/project/escaped.ts)',
      '[outer](https://example.com "title ](file:///E:/project/title.ts)")',
      '<pre>[html](file:///E:/project/html.ts)</pre>',
      '[real](file:///E:/project/real.ts)',
    ].join('\n')

    const preserved = preserveProjectFileLinks(markdown)
    expect(preserved).toContain('`[inline](file:///E:/project/inline.ts)`')
    expect(preserved).toContain('[indented](file:///E:/project/indented.ts)')
    expect(preserved).toContain('[list-indented](file:///E:/project/list-indented.ts)')
    expect(preserved).toContain('[fenced](file:///E:/project/fenced.ts)')
    expect(preserved).toContain('[quoted](file:///E:/project/quoted.ts)')
    expect(preserved).toContain('[listed](file:///E:/project/listed.ts)')
    expect(preserved).toContain('\\](file:///E:/project/escaped.ts)')
    expect(preserved).toContain('title ](file:///E:/project/title.ts)')
    expect(preserved).toContain('<pre>[html](file:///E:/project/html.ts)</pre>')
    expect(preserved).toContain(
      '[real](/__harness/project-file/file%3A%2F%2F%2FE%3A%2Fproject%2Freal.ts)',
    )
  })

  it('rewrites only link-owned semantic destinations', () => {
    expect(
      preserveProjectFileLinks(
        [
          '[![local image](file:///E:/project/image.png)](https://example.com)',
          '[![external image](https://example.com/image.png)](file:///E:/project/panel.tsx)',
          '[escaped](E:/project/panel\\(test\\).tsx)',
          '[entity](<file:///E:/project/a&amp;b.ts>)',
        ].join('\n'),
      ),
    ).toBe(
      [
        '[![local image](file:///E:/project/image.png)](https://example.com)',
        '[![external image](https://example.com/image.png)](/__harness/project-file/file%3A%2F%2F%2FE%3A%2Fproject%2Fpanel.tsx)',
        '[escaped](/__harness/project-file/E%3A%2Fproject%2Fpanel%28test%29.tsx)',
        '[entity](/__harness/project-file/file%3A%2F%2F%2FE%3A%2Fproject%2Fa%26b.ts)',
      ].join('\n'),
    )
  })

  it('preserves complete multiline resource boundaries', () => {
    const markdown = [
      '[plain](file:///E:/project/plain.ts\n "title")',
      '[literal](<file:///E:/project/literal.ts>\n "title")',
      '[leading](\nfile:///E:/project/leading.ts)',
    ].join('\n')

    const preserved = preserveProjectFileLinks(markdown)
    expect(preserved).toContain(
      '[plain](/__harness/project-file/file%3A%2F%2F%2FE%3A%2Fproject%2Fplain.ts\n "title")',
    )
    expect(preserved).toContain(
      '[literal](/__harness/project-file/file%3A%2F%2F%2FE%3A%2Fproject%2Fliteral.ts\n "title")',
    )
    expect(preserved).toContain(
      '[leading](\n/__harness/project-file/file%3A%2F%2F%2FE%3A%2Fproject%2Fleading.ts)',
    )
  })

  it('does not parse a large unrelated tail after the final candidate line', () => {
    const markdown = `[index](file:///E:/project/index.ts)\n${'ordinary text '.repeat(80_000)}`
    const started = performance.now()
    const preserved = preserveProjectFileLinks(markdown)

    expect(performance.now() - started).toBeLessThan(50)
    expect(preserved.endsWith('ordinary text ')).toBe(true)
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
