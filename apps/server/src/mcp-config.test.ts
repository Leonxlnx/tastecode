import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { McpConfigStore } from './mcp-config.js'

function setup() {
  const root = mkdtempSync(path.join(tmpdir(), 'harness-mcp-config-'))
  const project = path.join(root, 'project')
  mkdirSync(project)
  const location = path.join(root, 'config', 'mcp.json')
  return { project, location, store: new McpConfigStore(location) }
}

describe('project MCP config', () => {
  it('adds, updates, and removes one project without disturbing another', () => {
    const { project, location, store } = setup()
    const otherProject = path.join(path.dirname(project), 'other')
    mkdirSync(otherProject)

    store.add('codex', otherProject, { id: 'other', enabled: false })
    store.add('codex', project, {
      id: 'docs',
      enabled: true,
      transport: { type: 'http', url: 'https://example.com/mcp' },
    })
    store.update('codex', project, { id: 'docs', enabled: false })

    expect(store.list('codex', project)).toEqual([{ id: 'docs', enabled: false }])
    expect(() => store.add('codex', project, { id: 'docs', enabled: false })).toThrow(
      'already exists',
    )

    store.remove('codex', project, 'docs')
    expect(store.list('codex', project)).toEqual([])
    expect(store.list('codex', otherProject)).toEqual([{ id: 'other', enabled: false }])
    expect(readFileSync(location, 'utf8')).not.toContain('example.com')
  })

  it('skips malformed entries but parks the original before rewriting', () => {
    const { project, location, store } = setup()
    mkdirSync(path.dirname(location))
    writeFileSync(
      location,
      '{"version":1,"projects":{"bad":{"codex":{"x":{"id":"y","enabled":false}}}}}',
    )

    // The bad entry must not brick every MCP operation…
    expect(store.list('codex', project)).toEqual([])

    // …and the first rewrite must keep the hand-edited original around.
    store.add('codex', project, { id: 'fresh', enabled: false })
    const backups = readdirSync(path.dirname(location)).filter((name) => name.includes('.invalid-'))
    expect(backups).toHaveLength(1)
    expect(store.list('codex', project)).toEqual([{ id: 'fresh', enabled: false }])
  })

  it('reloads hand edits after the short read cache expires', () => {
    const { project, location } = setup()
    let now = 1_000
    const store = new McpConfigStore(location, () => now)
    store.add('codex', project, {
      id: 'docs',
      enabled: true,
      transport: { type: 'http', url: 'https://example.com/mcp' },
    })
    expect(store.list('codex', project)).toEqual([
      {
        id: 'docs',
        enabled: true,
        transport: { type: 'http', url: 'https://example.com/mcp' },
      },
    ])

    const edited = JSON.parse(readFileSync(location, 'utf8')) as {
      projects: Record<string, { codex: Record<string, { id: string; enabled: boolean }> }>
    }
    const projectKey = Object.keys(edited.projects)[0]!
    edited.projects[projectKey]!.codex['docs']!.enabled = false
    writeFileSync(location, JSON.stringify(edited))

    expect(store.list('codex', project)[0]?.enabled).toBe(true)
    now += 101
    expect(store.list('codex', project)[0]?.enabled).toBe(false)
  })

  it('merges app writes with hand edits even inside the read cache window', () => {
    const { project, location, store } = setup()
    store.add('codex', project, { id: 'docs', enabled: false })
    store.list('codex', project)

    const edited = JSON.parse(readFileSync(location, 'utf8')) as {
      projects: Record<string, { codex: Record<string, { id: string; enabled: boolean }> }>
    }
    const projectKey = Object.keys(edited.projects)[0]!
    edited.projects[projectKey]!.codex['external'] = { id: 'external', enabled: false }
    writeFileSync(location, JSON.stringify(edited))
    store.add('codex', project, { id: 'fresh', enabled: false })

    expect(store.list('codex', project).map(({ id }) => id)).toEqual(['docs', 'external', 'fresh'])
  })
})
