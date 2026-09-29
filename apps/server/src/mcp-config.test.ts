import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
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

  it('accepts credential references in the mcp/ namespace', () => {
    const { project, store } = setup()

    store.add('codex', project, {
      id: 'docs',
      enabled: true,
      transport: {
        type: 'http',
        url: 'https://example.com/mcp',
        headers: { Authorization: { source: 'credential', credentialRef: 'mcp/docs/auth' } },
      },
    })
    store.add('codex', project, {
      id: 'tools',
      enabled: true,
      transport: {
        type: 'stdio',
        command: 'node',
        environment: { API_KEY: { source: 'credential', credentialRef: 'mcp/tools/key' } },
      },
    })

    expect(store.list('codex', project).map(({ id }) => id)).toEqual(['docs', 'tools'])
  })

  it('rejects credential references outside the mcp/ namespace', () => {
    const { project, store } = setup()

    expect(() =>
      store.add('codex', project, {
        id: 'docs',
        enabled: true,
        transport: {
          type: 'http',
          url: 'https://example.com/mcp',
          headers: {
            Authorization: {
              source: 'credential',
              credentialRef: 'model-connections/3f4a2c10-9b87-4c1d-8f3e-2a1b0c9d8e7f',
            },
          },
        },
      }),
    ).toThrow('"mcp/" namespace')
    expect(() =>
      store.add('codex', project, {
        id: 'tools',
        enabled: true,
        transport: {
          type: 'stdio',
          command: 'node',
          environment: {
            API_KEY: {
              source: 'credential',
              credentialRef: 'custom-environment/3f4a2c10-9b87-4c1d-8f3e-2a1b0c9d8e7f',
            },
          },
        },
      }),
    ).toThrow('"mcp/" namespace')

    expect(store.list('codex', project)).toEqual([])
  })

  it('grandfathers stored references but validates newly supplied ones', () => {
    const { project, location, store } = setup()
    // Seed a config that predates the namespace policy — the file is
    // hand-editable and old free-form references must keep working.
    const legacy = {
      id: 'docs',
      enabled: true as const,
      displayName: 'Docs',
      transport: {
        type: 'stdio' as const,
        command: 'node',
        environment: { TOKEN: { source: 'credential' as const, credentialRef: 'legacy/token' } },
      },
    }
    mkdirSync(path.dirname(location))
    const projectKey =
      process.platform === 'win32'
        ? realpathSync.native(project).toLowerCase()
        : realpathSync.native(project)
    writeFileSync(
      location,
      JSON.stringify({ version: 1, projects: { [projectKey]: { codex: { docs: legacy } } } }),
    )

    // Re-saving the stored reference stays allowed…
    store.update('codex', project, { ...legacy, displayName: 'Docs 2' })
    expect(store.list('codex', project)[0]?.displayName).toBe('Docs 2')

    // …a new out-of-namespace reference on that same server does not…
    expect(() =>
      store.update('codex', project, {
        ...legacy,
        transport: {
          type: 'stdio',
          command: 'node',
          environment: {
            TOKEN: { source: 'credential', credentialRef: 'legacy/other-token' },
          },
        },
      }),
    ).toThrow('"mcp/" namespace')

    // …and the stored one cannot seed another server.
    expect(() =>
      store.add('codex', project, {
        id: 'other',
        enabled: true,
        transport: {
          type: 'stdio',
          command: 'node',
          environment: {
            TOKEN: { source: 'credential', credentialRef: 'legacy/token' },
          },
        },
      }),
    ).toThrow('"mcp/" namespace')

    // A new mcp/-namespaced reference alongside the grandfathered one works.
    store.update('codex', project, {
      ...legacy,
      transport: {
        type: 'stdio',
        command: 'node',
        environment: {
          TOKEN: { source: 'credential', credentialRef: 'legacy/token' },
          EXTRA: { source: 'credential', credentialRef: 'mcp/docs/extra' },
        },
      },
    })
    expect(store.list('codex', project)[0]?.transport).toMatchObject({
      environment: { EXTRA: { credentialRef: 'mcp/docs/extra' } },
    })
  })
})
