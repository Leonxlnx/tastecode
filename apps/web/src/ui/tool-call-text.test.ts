import { describe, expect, it, vi } from 'vitest'
import {
  parseToolCall,
  readableToolJson,
  toolArgumentEntries,
  toolArgumentSnippet,
} from './tool-call-text.js'

describe('tool call text', () => {
  it('reads the name, one JSON argument line and the output', () => {
    expect(
      parseToolCall('cua_repl.js\n{"code":"await page.screenshot()"}\nSaved home.png\n[image]'),
    ).toEqual({
      name: 'cua_repl.js',
      args: { code: 'await page.screenshot()' },
      output: 'Saved home.png\n[image]',
    })
  })

  it('reads pretty-printed arguments separated by blank lines, as saved history writes them', () => {
    expect(parseToolCall('github.search_issues\n\n{\n  "query": "is:open"\n}\n\n3 issues')).toEqual(
      { name: 'github.search_issues', args: { query: 'is:open' }, output: '3 issues' },
    )
  })

  it('reads a legacy first-line payload as output, and a bare name as just a name', () => {
    expect(
      parseToolCall(
        'grep [ { "type": "content", "content": { "type": "text", "text": "found 29 matches" } } ]\n{ "type": "GrepSearch", "stdout": [60, 119] }',
      ),
    ).toEqual({ name: 'grep', args: undefined, output: 'found 29 matches' })
    expect(
      parseToolCall(
        'Bash [ { "type": "content", "content": { "type": "text", "text": "" } } ]\n{ "type": "Bash", "output": [], "exit_code": 0 }',
      ),
    ).toEqual({ name: 'Bash', args: undefined, output: undefined })
    expect(parseToolCall('web search')).toEqual({
      name: 'web search',
      args: undefined,
      output: undefined,
    })
    expect(parseToolCall(undefined)).toEqual({ name: '', args: undefined, output: undefined })
  })

  it('keeps plain text after the name as output, not as arguments', () => {
    expect(parseToolCall('Spawned a subagent\nAudit the reducer')).toEqual({
      name: 'Spawned a subagent',
      args: undefined,
      output: 'Audit the reducer',
    })
  })

  it('unwraps JSON output into its text', () => {
    expect(parseToolCall('mcp.tool\n{"q":1}\n[{"type":"text","text":"hello"}]').output).toBe(
      'hello',
    )
    expect(readableToolJson({ count: 3, ok: true })).toBe('count: 3\nok: true')
    expect(readableToolJson([1, 2, 3])).toBeUndefined()
  })

  it('reads the name and arguments without parsing the output until it is used', () => {
    const screenshot = JSON.stringify({ type: 'image', data: 'iVBORw0KGgo'.repeat(50_000) })
    const call = parseToolCall(`node_repl.js\n{"code":"crop()"}\n${screenshot}`)
    const parse = vi.spyOn(JSON, 'parse')

    expect(call.name).toBe('node_repl.js')
    expect(call.args).toEqual({ code: 'crop()' })
    expect(parse).not.toHaveBeenCalled()

    expect(call.output).toContain('type: image')
    expect(call.output).toContain('type: image')
    expect(parse).toHaveBeenCalledTimes(1)
    parse.mockRestore()
  })

  it('picks the argument a reader wants beside the tool name', () => {
    expect(toolArgumentSnippet({ query: 'vite  hmr\ncss' })).toBe('vite hmr css')
    expect(toolArgumentSnippet({ code: 'x'.repeat(100) }, 20)).toBe(`${'x'.repeat(19)}…`)
    expect(toolArgumentSnippet({ replace_all: true, file_path: 'src/a.ts' })).toBe('src/a.ts')
    expect(toolArgumentSnippet({ count: 3 })).toBeUndefined()
    expect(toolArgumentSnippet(undefined)).toBeUndefined()
  })

  it('flattens arguments into rows', () => {
    expect(
      toolArgumentEntries({
        url: 'https://x.test',
        headers: { a: '1' },
        tags: ['x', 'y'],
        skip: null,
      }),
    ).toEqual([
      ['url', 'https://x.test'],
      ['headers', '{\n  "a": "1"\n}'],
      ['tags', 'x, y'],
    ])
  })
})
