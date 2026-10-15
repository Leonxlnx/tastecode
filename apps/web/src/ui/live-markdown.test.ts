import { describe, expect, it } from 'vitest'
import {
  LIVE_MARKDOWN_SOURCE_CHUNK_LIMIT,
  LiveMarkdownParser,
  type LiveMarkdownOperation,
} from './live-markdown.js'

function nodes(operations: LiveMarkdownOperation[]) {
  return operations.flatMap((operation) => (operation.type === 'node.open' ? [operation.node] : []))
}

function leafText(operations: LiveMarkdownOperation[]) {
  return operations
    .flatMap((operation) =>
      operation.type === 'leaf.append' || operation.type === 'leaf.bulk' ? [operation.text] : [],
    )
    .join('')
}

function normalizeLeafAppends(operations: LiveMarkdownOperation[]): LiveMarkdownOperation[] {
  const normalized: LiveMarkdownOperation[] = []
  for (const operation of operations) {
    const previous = normalized.at(-1)
    if (
      operation.type === 'leaf.append' &&
      previous?.type === 'leaf.append' &&
      previous.id === operation.id
    ) {
      previous.text += operation.text
    } else normalized.push({ ...operation })
  }
  return normalized
}

describe('LiveMarkdownParser', () => {
  it('keeps canonical source exact across append, replacement, and completion', () => {
    const parser = new LiveMarkdownParser()
    parser.append('old')
    const replacement = parser.replace('new **answer**')
    const appended = parser.append('\nwith code')

    expect(replacement.operations[0]).toEqual({ type: 'reset' })
    expect(appended.scannedCharacters).toBe('\nwith code'.length)
    expect(parser.complete()).toMatchObject({ source: 'new **answer**\nwith code' })
    expect(parser.complete()).toMatchObject({ source: 'new **answer**\nwith code' })
    expect(() => parser.append(' late')).toThrow(/completion/)
    expect(() => parser.replace('late')).toThrow(/completion/)
  })

  it('styles common Markdown when delimiters split across chunks', () => {
    const parser = new LiveMarkdownParser()
    const chunks = [
      '##',
      ' Title\n\nA *',
      '*bold*',
      '* and `co',
      'de`.\n\n- i',
      'tem\n# Next\n\n```ts\nco',
      'de\n``',
      '`\n',
    ]
    const operations = chunks.flatMap((chunk) => parser.append(chunk).operations)

    expect(nodes(operations)).toEqual(
      expect.arrayContaining([
        'heading-2',
        'strong',
        'inline-code',
        'list',
        'list-item',
        'code-block',
      ]),
    )
    expect(parser.complete().source).toBe(chunks.join(''))
    const sequence = JSON.stringify(operations)
    expect(sequence).toMatch(
      /"type":"node.close","node":"list"}.*"type":"node.open","node":"heading-1"/,
    )
  })

  it('keeps batched plain runs equal to character-at-a-time parsing', () => {
    const source = `${'# Title\n\nA '.padEnd(1_024, 'x')} **bold** and \`code_value\`.\n\n- item\n> quote\n\n\`\`\`ts\n${'const value = 1\n'.repeat(100)}\`\`\`\n`
    const batched = new LiveMarkdownParser()
    const incremental = new LiveMarkdownParser()

    const batchedOperations = batched.append(source).operations
    const incrementalOperations = Array.from(source).flatMap(
      (character) => incremental.append(character).operations,
    )

    expect(normalizeLeafAppends(batchedOperations)).toEqual(
      normalizeLeafAppends(incrementalOperations),
    )
    expect(batched.complete()).toEqual(incremental.complete())
  })

  it('bounds every mutable leaf and line-prefix carry', () => {
    const parser = new LiveMarkdownParser()
    const update = parser.append(`paragraph ${'x'.repeat(2_000)}${'_**'.repeat(10_000)}`)
    const leaves = update.operations.filter(
      (operation): operation is Extract<LiveMarkdownOperation, { type: 'leaf.append' }> =>
        operation.type === 'leaf.append',
    )

    expect(Math.max(...leaves.map((leaf) => leaf.text.length))).toBeLessThanOrEqual(256)
    expect(update.carryCharacters).toBeLessThanOrEqual(64)
    parser.append('\n')
    expect(parser.append('\n').operations.length).toBeLessThanOrEqual(66)
  })

  it('coalesces large sealed plain-text runs without growing mutable leaves', () => {
    const source = 'x'.repeat(1024 * 1024)
    const parser = new LiveMarkdownParser()
    const update = parser.appendLarge(source)

    expect(update.operations.length).toBeLessThan(10)
    expect(update.operations).toContainEqual(expect.objectContaining({ type: 'leaf.bulk' }))
    expect(update.mutableLeafCharacters).toBe(0)
    expect(parser.append('y').mutableLeafCharacters).toBe(1)
    expect(parser.complete().source).toBe(`${source}y`)
  })

  it('bounds source chunk bookkeeping during a very long stream', () => {
    const parser = new LiveMarkdownParser()
    let update = parser.append('')
    for (let index = 0; index < 10_000; index += 1) update = parser.append('x')

    expect(update.bufferedSourceChunks).toBeLessThan(LIVE_MARKDOWN_SOURCE_CHUNK_LIMIT)
    expect(parser.complete().source).toBe('x'.repeat(10_000))
  })

  it('joins compact source segments once at completion', () => {
    const parser = new LiveMarkdownParser()
    const chunks = Array.from(
      { length: LIVE_MARKDOWN_SOURCE_CHUNK_LIMIT * 3 + 17 },
      (_, index) => `${index % 10}`,
    )
    for (const chunk of chunks) parser.append(chunk)

    expect(parser.complete().source).toBe(chunks.join(''))
    expect(parser.complete().source).toBe(chunks.join(''))
  })

  it('keeps streamed HTML and links inert', () => {
    const source = '<img src=x onerror=alert(1)> [click](javascript:alert(1))'
    const parser = new LiveMarkdownParser()
    expect(nodes(parser.append(source).operations)).toEqual(['paragraph'])
    expect(parser.complete().source).toBe(source)
  })

  it('shows a streamed table only once its delimiter row confirms it, then row by row', () => {
    const parser = new LiveMarkdownParser()
    const before = parser.append('Results:\n\n| Suite | Before | After |\n| --- | ---: | :-: ')
    expect(nodes(before.operations)).toEqual(['paragraph'])
    expect(leafText(before.operations)).toBe('Results:\n')

    const header = parser.append('|\n| `api` | 14 ')
    expect(nodes(header.operations)).toEqual([
      'table',
      'table-head',
      'table-row',
      'table-header-cell',
      'table-header-cell',
      'table-header-cell',
    ])
    expect(header.operations).toContainEqual({
      type: 'node.open',
      node: 'table-header-cell',
      align: 'right',
    })
    expect(header.operations).toContainEqual({
      type: 'node.open',
      node: 'table-header-cell',
      align: 'center',
    })
    expect(leafText(header.operations)).toBe('SuiteBeforeAfter')

    const row = parser.append('| 19 |\n| db | 6')
    expect(nodes(row.operations)).toEqual([
      'table-body',
      'table-row',
      'table-cell',
      'inline-code',
      'table-cell',
      'table-cell',
    ])
    expect(leafText(row.operations)).toBe('api1419')

    const end = parser.append(' | 7 |\n\nDone.')
    expect(nodes(end.operations)).toEqual([
      'table-row',
      'table-cell',
      'table-cell',
      'table-cell',
      'paragraph',
    ])
    expect(JSON.stringify(end.operations)).toMatch(
      /"node.close","node":"table-body"}.*"node.close","node":"table"}.*"node":"paragraph"/,
    )
  })

  it('fills short rows and drops extra cells to the header width', () => {
    const parser = new LiveMarkdownParser()
    const update = parser.append('| a | b |\n|---|---|\n| one |\n| x | y | z |\n')
    const cells = update.operations.filter(
      (operation) => operation.type === 'node.open' && operation.node === 'table-cell',
    )
    expect(cells).toHaveLength(4)
    expect(leafText(update.operations)).toBe('abonexy')
  })

  it('releases a pipe line that is not a table as the prose it was', () => {
    const parser = new LiveMarkdownParser()
    const held = parser.append('| not a table\n')
    expect(held.operations).toEqual([])
    const released = parser.append('just text\n')
    expect(nodes(released.operations)).toEqual(['paragraph'])
    expect(leafText(released.operations)).toBe('| not a table\njust text\n')

    const delimiterLike = new LiveMarkdownParser()
    const rows = delimiterLike.append('| a | b |\n| - list |\n')
    expect(nodes(rows.operations)).toEqual(['paragraph'])
    expect(leafText(rows.operations)).toBe('| a | b |\n')
    expect(delimiterLike.append('\n').carryCharacters).toBe(0)
  })

  it('opens a web link once its closing parenthesis arrives', () => {
    const parser = new LiveMarkdownParser()
    const open = parser.append('See [the **docs**](https://docs.exa')
    expect(leafText(open.operations)).toBe('See ')
    expect(nodes(open.operations)).toEqual(['paragraph'])

    const closed = parser.append('mple.com/a_(b)) next')
    expect(closed.operations).toContainEqual({
      type: 'node.open',
      node: 'link',
      href: 'https://docs.example.com/a_(b)',
    })
    expect(nodes(closed.operations)).toEqual(['link', 'strong'])
    expect(leafText(closed.operations)).toBe('the docs next')
    expect(JSON.stringify(closed.operations)).toMatch(/"node.close","node":"link"}.*" next"/)
  })

  it('keeps non-web destinations, images and stray brackets as text', () => {
    const parser = new LiveMarkdownParser()
    const update = parser.append(
      '[run](javascript:alert(1)) [file](src/a.ts) ![logo](https://x.test/a.png) a[0] [b] c\n',
    )
    expect(nodes(update.operations)).toEqual(['paragraph'])
    expect(leafText(update.operations)).toBe('run file ![logo](https://x.test/a.png) a[0] [b] c\n')
    expect(parser.append('[open').carryCharacters).toBe(5)
    expect(leafText(parser.append('\n').operations)).toBe('[open\n')
  })

  it('renders task list markers as checkboxes', () => {
    const parser = new LiveMarkdownParser()
    const update = parser.append(
      '- [x] reviewed\n- [ ] deploy\n- [docs](https://a.test) item\n- [y] plain\n',
    )
    expect(update.operations.filter((operation) => operation.type === 'task')).toEqual([
      { type: 'task', checked: true },
      { type: 'task', checked: false },
    ])
    expect(nodes(update.operations)).toContain('link')
    expect(leafText(update.operations)).toBe('revieweddeploydocs item[y] plain')
  })

  it('keeps tables, links and task markers equal across chunkings', () => {
    const source =
      '## Plan\n\n| Step | Link |\n| :-- | --: |\n| one | [a](https://a.test) |\n| `two` | **b** |\n\n- [x] done [c](https://c.test)\n- [ ] next\n\n| no table\nprose [d](rel/path) and [e\n'
    const batched = new LiveMarkdownParser()
    const incremental = new LiveMarkdownParser()
    const batchedOperations = batched.append(source).operations
    const incrementalOperations = Array.from(source).flatMap(
      (character) => incremental.append(character).operations,
    )

    expect(normalizeLeafAppends(batchedOperations)).toEqual(
      normalizeLeafAppends(incrementalOperations),
    )
    expect(batched.complete()).toEqual(incremental.complete())
  })

  it('keeps the work of completing a table row independent of the rows before it', () => {
    const parser = new LiveMarkdownParser()
    parser.append('| id | name | state |\n| --- | --- | --- |\n')
    const rowOperations: number[] = []
    for (let row = 0; row < 500; row += 1) {
      parser.append(`| ${row % 10} | item `)
      expect(parser.append('name').operations).toEqual([])
      const update = parser.append(' | ok |\n')
      expect(update.scannedCharacters).toBe(' | ok |\n'.length)
      rowOperations.push(update.operations.length)
    }
    // The first row also opens the table body; every later row costs the same.
    expect(new Set(rowOperations.slice(1))).toEqual(new Set([rowOperations[1]]))
  })

  it.each([4_096, 65_536])('makes delta work independent of a %i-character prefix', (size) => {
    const parser = new LiveMarkdownParser()
    parser.replace('x'.repeat(size))
    const update = parser.append(' next')
    expect(update).toMatchObject({ scannedCharacters: 5, sourceLength: size + 5 })
    expect(update.operations.length).toBeLessThanOrEqual(5)
  })
})
