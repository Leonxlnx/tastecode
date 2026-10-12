import { randomUUID } from 'node:crypto'
import {
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import {
  StoredModelConnectionSchema,
  type ModelConnection,
  type StoredModelConnection,
} from '@harness/contracts'
import { z } from 'zod'
import { hasCredential, removeCredential, writeCredential } from './credentials.js'
import { configFile } from './product-paths.js'

/**
 * What one read of the file found. Entries this build cannot use stay in
 * `invalid` exactly as they were, and every save writes them back: they may
 * come from a newer build, a rule an older build did not have, or a hand edit
 * the user still means to repair. `unreadable` says why the whole file was
 * ignored; the first save after that keeps a copy of the original.
 */
type ConfigState = {
  connections: StoredModelConnection[]
  invalid: unknown[]
  skipped: string[]
  unreadable?: string
}

// Entries are checked one at a time below. Validating the array as a whole
// let one bad entry fail every read, which also blocked deleting that entry.
const ConfigFileSchema = z.object({
  version: z.literal(1),
  connections: z.array(z.unknown()),
})

function defaultLocation(): string {
  return configFile('providers.json')
}

function entryId(entry: unknown): string | undefined {
  if (typeof entry !== 'object' || entry === null || !('id' in entry)) return undefined
  return typeof entry.id === 'string' && entry.id.length > 0 ? entry.id : undefined
}

function emptyState(unreadable?: string): ConfigState {
  return { connections: [], invalid: [], skipped: [], ...(unreadable ? { unreadable } : {}) }
}

function parseConfig(raw: string): ConfigState {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return emptyState('it is not valid JSON')
  }
  const file = ConfigFileSchema.safeParse(value)
  if (!file.success) return emptyState('it is not a version 1 connection list')

  const state = emptyState()
  file.data.connections.forEach((entry, index) => {
    const connection = StoredModelConnectionSchema.safeParse(entry)
    if (connection.success) {
      state.connections.push(connection.data)
      return
    }
    state.invalid.push(entry)
    // Field names only: the values are the user's and stay out of the log.
    const fields = new Set(
      connection.error.issues.map((issue) => issue.path.map(String).join('.') || 'entry'),
    )
    const id = entryId(entry)
    const label = id === undefined ? `#${index + 1}` : JSON.stringify(id)
    state.skipped.push(`${label} (${[...fields].join(', ')})`)
  })
  return state
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
}

const OS_CREDENTIALS: ModelCredentialStore = {
  has: hasCredential,
  write: writeCredential,
  remove: removeCredential,
}

/** Human-readable provider configuration. API keys stay in the OS credential store. */
export class ModelConnectionStore {
  /** The broken content last logged, so it is reported once rather than on every read. */
  #reported: string | undefined

  constructor(
    private readonly location = defaultLocation(),
    private readonly credentials: ModelCredentialStore = OS_CREDENTIALS,
  ) {}

  list(): ModelConnection[] {
    return this.#read().connections.map((connection) => this.#public(connection))
  }

  get(id: string): StoredModelConnection {
    const file = this.#read()
    const connection = file.connections.find((entry) => entry.id === id)
    if (!connection) throw this.#missing(file, id)
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
    this.credentials.write(connection.credentialRef, apiKey)
  }

  remove(id: string): void {
    const file = this.#read()
    const index = file.connections.findIndex((entry) => entry.id === id)
    if (index < 0) throw this.#missing(file, id)
    const [connection] = file.connections.splice(index, 1)
    this.#write(file)
    if (connection) this.credentials.remove(connection.credentialRef)
  }

  #public(connection: StoredModelConnection): ModelConnection {
    const { credentialRef, ...config } = connection
    return {
      ...config,
      credentialConfigured: this.credentials.has(credentialRef),
      capabilities: capabilities(connection),
    }
  }

  #missing(file: ConfigState, id: string): Error {
    if (file.unreadable) {
      return new Error(
        `model connection "${id}" is unavailable because ${this.location} could not be read: ${file.unreadable}`,
      )
    }
    if (file.invalid.some((entry) => entryId(entry) === id)) {
      return new Error(`model connection "${id}" is invalid in ${this.location}`)
    }
    return new Error(`model connection "${id}" does not exist`)
  }

  #read(): ConfigState {
    if (!existsSync(this.location)) return emptyState()
    const raw = readFileSync(this.location, 'utf8')
    const file = parseConfig(raw)
    if (!file.unreadable && file.skipped.length === 0) {
      this.#reported = undefined
    } else if (raw !== this.#reported) {
      this.#reported = raw
      console.warn(
        file.unreadable
          ? `[model-connections] ignoring ${this.location} because ${file.unreadable}; the next save keeps a copy of it beside the new file`
          : `[model-connections] skipping invalid connections in ${this.location}, which stay in the file unchanged: ${file.skipped.join('; ')}`,
      )
    }
    return file
  }

  #write(file: ConfigState): void {
    mkdirSync(path.dirname(this.location), { recursive: true })
    const temporary = `${this.location}.${randomUUID()}.tmp`
    const content = { version: 1, connections: [...file.connections, ...file.invalid] }
    try {
      writeFileSync(temporary, `${JSON.stringify(content, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      })
      // An unreadable file is still the user's. Refusing to save would lock
      // them out of every API connection until they found and repaired it by
      // hand, so copy it aside instead, and leave it active until the complete
      // replacement is atomically in place.
      let backup: string | undefined
      if (file.unreadable && existsSync(this.location)) {
        backup = `${this.location}.invalid-${Date.now()}-${randomUUID().slice(0, 8)}.bak`
        copyFileSync(this.location, backup, constants.COPYFILE_EXCL)
      }
      renameSync(temporary, this.location)
      if (backup) {
        console.warn(
          `[model-connections] replaced the unreadable ${this.location}; the original is kept as ${backup}`,
        )
      }
    } catch (error) {
      // A failed save must not leave a stray temporary file behind on every retry.
      try {
        rmSync(temporary, { force: true })
      } catch {
        // Report the save failure, not the cleanup one.
      }
      throw error
    }
  }
}
