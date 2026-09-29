import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  StoredModelConnectionSchema,
  type ModelConnection,
  type StoredModelConnection,
} from '@harness/contracts'
import { z } from 'zod'
import {
  hasCredential,
  removeCredential,
  removeCredentialStrict,
  writeCredential,
} from './credentials.js'
import { configFile } from './product-paths.js'

type ConfigFile = { version: 1; connections: StoredModelConnection[] }
const EMPTY_CONFIG: ConfigFile = { version: 1, connections: [] }
const ConfigFileSchema = z.object({
  version: z.literal(1),
  connections: z.array(StoredModelConnectionSchema),
})

function defaultLocation(): string {
  return configFile('providers.json')
}

/**
 * Endpoint spelling differences must not silently drop a configured key:
 * the URL constructor already lowercases the host and folds default ports,
 * and a trailing pathname slash is meaningless for these API bases.
 */
function normalizedBaseUrl(value: string): string {
  try {
    const url = new URL(value)
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}${url.search}${url.hash}`
  } catch {
    return value
  }
}

function parseConfig(raw: string): ConfigFile {
  const value = ConfigFileSchema.safeParse(JSON.parse(raw))
  if (!value.success) {
    throw new Error('invalid provider config: expected a version 1 connection list')
  }
  return value.data
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

export type ModelCredentialStore = {
  has(reference: string): boolean
  write(reference: string, value: string): void
  remove(reference: string): void
  removeStrict(reference: string): void
}

const OS_CREDENTIALS: ModelCredentialStore = {
  has: hasCredential,
  write: writeCredential,
  remove: removeCredential,
  removeStrict: removeCredentialStrict,
}

/** Human-readable provider configuration. API keys stay in the OS credential store. */
export class ModelConnectionStore {
  constructor(
    private readonly location = defaultLocation(),
    private readonly credentials: ModelCredentialStore = OS_CREDENTIALS,
  ) {}

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
    // The stored key was entered for a specific endpoint: an upsert that moves
    // the base URL must not inherit it, or a client could aim the key at any
    // host. The connection keeps working only once the key is re-supplied.
    const retargeted =
      existing !== undefined &&
      normalizedBaseUrl(existing.baseUrl) !== normalizedBaseUrl(input.baseUrl)
    const connection = StoredModelConnectionSchema.parse({
      ...input,
      // Stored connections keep their reference while their endpoint stays
      // put. New ones get a unique reference rather than deriving it from the
      // id, so an API key a deleted same-id connection orphaned can never
      // resolve again.
      credentialRef:
        existing && !retargeted ? existing.credentialRef : `model-connections/${randomUUID()}`,
    })
    if (index < 0) file.connections.push(connection)
    else file.connections[index] = connection
    this.#write(file)
    if (!existing) {
      // Connections created before unique references used
      // `model-connections/<id>`; a leftover entry under that name is exactly
      // the orphan this schema change exists to bury.
      this.credentials.remove(`model-connections/${input.id}`)
    } else if (retargeted) {
      // The fresh reference can never resurrect the old key; delete it too so
      // no orphaned copy lingers in the credential store.
      this.credentials.remove(existing.credentialRef)
    }
    return this.#public(connection)
  }

  setCredential(id: string, apiKey: string): void {
    const connection = this.get(id)
    this.credentials.write(connection.credentialRef, apiKey)
  }

  remove(id: string): void {
    const file = this.#read()
    const index = file.connections.findIndex((entry) => entry.id === id)
    if (index < 0) throw new Error(`model connection "${id}" does not exist`)
    const [connection] = file.connections.splice(index, 1)
    this.#write(file)
    // Strict removal: a swallowed delete would orphan the API key, and the
    // caller deserves to know the keyring still holds it.
    if (connection) this.credentials.removeStrict(connection.credentialRef)
  }

  #public(connection: StoredModelConnection): ModelConnection {
    const { credentialRef, ...config } = connection
    return {
      ...config,
      credentialConfigured: this.credentials.has(credentialRef),
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
