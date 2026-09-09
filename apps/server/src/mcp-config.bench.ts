import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, bench, describe } from 'vitest'
import { McpConfigStore } from './mcp-config.js'

const OPTIONS = { iterations: 10, time: 0, warmupIterations: 3, warmupTime: 0 }
const READ_COUNT = 5_000
const root = mkdtempSync(path.join(tmpdir(), 'harness-mcp-config-bench-'))
const project = path.join(root, 'project')
mkdirSync(project)
const emptyStore = new McpConfigStore(path.join(root, 'empty', 'mcp.json'))
const configuredLocation = path.join(root, 'configured', 'mcp.json')
const configuredStore = new McpConfigStore(configuredLocation)
configuredStore.add('codex', project, {
  id: 'docs',
  enabled: true,
  transport: { type: 'http', url: 'https://example.com/mcp' },
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

function readEmptyConfig(): void {
  let servers = 0
  for (let index = 0; index < READ_COUNT; index += 1) {
    servers += emptyStore.list('codex', project).length
  }
  if (servers !== 0) throw new Error('expected an empty MCP config')
}

function readConfiguredProject(): void {
  let servers = 0
  for (let index = 0; index < READ_COUNT; index += 1) {
    servers += configuredStore.list('codex', project).length
  }
  if (servers !== READ_COUNT) throw new Error('expected one configured MCP server per read')
}

function readConfiguredProjectCold(): void {
  if (new McpConfigStore(configuredLocation).list('codex', project).length !== 1) {
    throw new Error('expected one configured MCP server')
  }
}

describe('MCP config reads during thread start', () => {
  bench('lists an absent config 5,000 times', readEmptyConfig, OPTIONS)
  bench('lists one configured project 5,000 times', readConfiguredProject, OPTIONS)
  bench('opens and lists one configured project once', readConfiguredProjectCold, {
    time: 1_200,
    warmupTime: 300,
  })
})
