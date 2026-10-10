import { describe, expect, it } from 'vitest'
import { turnDiff } from './turn-diff.js'

const header = (file: string, mode = '') =>
  [`diff --git a/${file} b/${file}`, ...(mode ? [mode] : [])].join('\n')
const edit = (file: string, ...hunk: string[]) =>
  `${header(file)}\n--- a/${file}\n+++ b/${file}\n${hunk.join('\n')}\n`
const lines = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, index) => ` l${from + index}`)

describe('imported Codex turn diff', () => {
  it('lists a file edited twice once, with the net change', () => {
    expect(
      turnDiff([
        edit('f.txt', '@@ -1,3 +1,3 @@', ' one', '-two', '+TWO', ' three'),
        edit('g.txt', '@@ -1 +1 @@', '-g', '+G'),
        edit('f.txt', '@@ -1,3 +1,3 @@', ' one', '-TWO', '+2', ' three'),
      ]),
    ).toBe(
      edit('f.txt', '@@ -1,3 +1,3 @@', ' one', '-two', '+2', ' three') +
        edit('g.txt', '@@ -1 +1 @@', '-g', '+G'),
    )
  })

  it('keeps line numbers right when an earlier edit moved later lines', () => {
    expect(
      turnDiff([
        edit('f.txt', '@@ -1,5 +1,7 @@', ' l1', ' l2', '+new a', '+new b', ' l3', ' l4', ' l5'),
        edit('f.txt', '@@ -14,7 +14,7 @@', ...lines(12, 14), '-l15', '+L15', ...lines(16, 18)),
      ]),
    ).toBe(
      edit(
        'f.txt',
        '@@ -1,5 +1,7 @@',
        ' l1',
        ' l2',
        '+new a',
        '+new b',
        ' l3',
        ' l4',
        ' l5',
        '@@ -12,7 +14,7 @@',
        ...lines(12, 14),
        '-l15',
        '+L15',
        ...lines(16, 18),
      ),
    )
  })

  it('composes a created file with a later edit into one creation', () => {
    expect(
      turnDiff([
        `${header('f.txt', 'new file mode 100644')}\n--- /dev/null\n+++ b/f.txt\n@@ -0,0 +1,2 @@\n+a\n+b\n`,
        edit('f.txt', '@@ -1,2 +1,2 @@', ' a', '-b', '+B'),
      ]),
    ).toBe(
      `${header('f.txt', 'new file mode 100644')}\n--- /dev/null\n+++ b/f.txt\n@@ -0,0 +1,2 @@\n+a\n+B\n`,
    )
  })

  it('leaves out a file whose edits cancel out', () => {
    expect(
      turnDiff([
        edit('f.txt', '@@ -1,2 +1,2 @@', ' one', '-two', '+TWO'),
        edit('f.txt', '@@ -1,2 +1,2 @@', ' one', '-TWO', '+two'),
      ]),
    ).toBe('')
  })

  it('keeps the edits in order when they do not follow each other', () => {
    const first = edit('f.txt', '@@ -1,2 +1,2 @@', ' one', '-two', '+TWO')
    const unrelated = edit('f.txt', '@@ -1,2 +1,2 @@', ' one', '-three', '+3')
    const noNewline = edit('f.txt', '@@ -1 +1 @@', '-TWO', '\\ No newline at end of file', '+2')
    expect(turnDiff([first, unrelated])).toBe(first + unrelated)
    expect(turnDiff([first, noNewline])).toBe(first + noNewline)
  })
})
