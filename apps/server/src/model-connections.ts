import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  StoredModelConnectionSchema,
  type ModelConnection,
  type StoredModelConnection,
} from '@harness/contracts'
import { hasCredential, removeCredential, writeCredential } from './credentials.js'

type ConfigFile = { version: 1; connections: StoredModelConnection[] }
const EMPTY_CONFIG: ConfigFile = { version: 1, connections: [] }

function defaultLocation(): string {
  const root = process.env['HARNESS_CONFIG_DIR'] ?? path.join(os.homedir(), '.personalharness')
  return path.join(root, 'providers.json')
}

function parseConfig(raw: string): ConfigFile {
  const value = JSON.parse(raw) as { version?: unknown; connections?: unknown }
  if (value.version !== 1 || !Array.isArray(value.connections)) {
    throw new Error('invalid provider config: expected a version 1 connection list')
  }
  return {
    version: 1,
    connections: value.connections.map((entry) => StoredModelConnectionSchema.parse(entry)),
  }
}

function capabilities(connection: StoredModelConnection): ModelConnection['capabilities'] {
  return {
    streaming: true,
    tools: true,
    images: false,
    reasoning: true,
    modelDiscovery: connection.preset !== 'zai',
    usage: connection.preset !== 'zai',
  }
}

/** Human-readable provider configuration. API keys stay in the OS credential store. */
export class ModelConnectionStore {
  constructor(private readonly location = defaultLocation()) {}

  list(): ModelConnection[] {
    return this.#read().connections.map((connection) => this.#public(connection))
  }

  get(id: string): StoredModelConnection {
    const connection = this.#read().connections.find((entry) => entry.id === id)
    if (!connection) throw new Error(`model connection "${id}" does not exist`)
    return connection
  }

  upsert(input: Omit<StoredModelConnection, 'credentialRef'>): ModelConnection {
    const file = this.#read()
    const index = file.connections.findIndex((entry) => entry.id === input.id)
    const existing = index < 0 ? undefined : file.connections[index]
    const connection = StoredModelConnectionSchema.parse({
      ...input,
      credentialRef: existing?.credentialRef ?? `model-connections/${input.id}`,
    })
    if (index < 0) file.connections.push(connection)
    else file.connections[index] = connection
    this.#write(file)
    return this.#public(connection)
  }

  setCredential(id: string, apiKey: string): void {
    const connection = this.get(id)
    writeCredential(connection.credentialRef, apiKey)
  }

  remove(id: string): void {
    const file = this.#read()
    const index = file.connections.findIndex((entry) => entry.id === id)
    if (index < 0) throw new Error(`model connection "${id}" does not exist`)
    const [connection] = file.connections.splice(index, 1)
    this.#write(file)
    if (connection) removeCredential(connection.credentialRef)
  }

  #public(connection: StoredModelConnection): ModelConnection {
    const { credentialRef, ...config } = connection
    return {
      ...config,
      credentialConfigured: hasCredential(credentialRef),
      capabilities: capabilities(connection),
    }
  }

  #read(): ConfigFile {
    return existsSync(this.location)
      ? parseConfig(readFileSync(this.location, 'utf8'))
      : structuredClone(EMPTY_CONFIG)
  }

  #write(file: ConfigFile): void {
    mkdirSync(path.dirname(this.location), { recursive: true })
    const temporary = `${this.location}.${randomUUID()}.tmp`
    writeFileSync(temporary, `${JSON.stringify(file, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
    renameSync(temporary, this.location)
  }
}
