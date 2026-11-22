import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { CustomHarnessSchema, type CustomHarness } from '@harness/contracts'
import { z } from 'zod'
// Apart from the node:fs import above, which the temporary-file cleanup (#2346) changes.
import { constants, copyFileSync } from 'node:fs'
import { configFile } from './product-paths.js'
import { assertProviderOffered, providerOffered } from './provider-edition.js'

/**
 * `unsupported` holds entries this build cannot run, such as a harness on a
 * provider that ships only on the nightly branch. Both builds share this file,
 * so those entries stay in it untouched instead of failing every read.
 */
type ConfigFile = { version: 1; harnesses: CustomHarness[]; unsupported: unknown[] }
const EMPTY_CONFIG: ConfigFile = { version: 1, harnesses: [], unsupported: [] }
const ConfigFileSchema = z.object({
  version: z.literal(1),
  harnesses: z.array(z.unknown()),
})

function defaultLocation(): string {
  return configFile('custom-harnesses.json')
}

function parseConfig(raw: string): ConfigFile {
  // Windows editors and PowerShell 5 save UTF-8 with a byte order mark, which
  // `JSON.parse` rejects.
  const value = ConfigFileSchema.safeParse(JSON.parse(raw.replace(/^﻿/, '')))
  if (!value.success) {
    throw new Error('invalid custom harness config: expected a version 1 harness list')
  }
  const harnesses: CustomHarness[] = []
  const unsupported: unknown[] = []
  for (const entry of value.data.harnesses) {
    const harness = CustomHarnessSchema.safeParse(entry)
    // A harness on a provider this build does not offer is kept the same way.
    if (harness.success && providerOffered(harness.data.provider)) harnesses.push(harness.data)
    else unsupported.push(entry)
  }
  return { version: 1, harnesses, unsupported }
}

function entryId(entry: unknown): unknown {
  return typeof entry === 'object' && entry !== null && 'id' in entry ? entry.id : undefined
}

/** Human-readable launch configuration. It deliberately has no credential fields. */
export class CustomHarnessStore {
  constructor(private readonly location = defaultLocation()) {}

  list(): CustomHarness[] {
    return this.#read().harnesses
  }

  get(id: string): CustomHarness {
    const harness = this.#read().harnesses.find((entry) => entry.id === id)
    if (!harness) throw new Error(`custom harness "${id}" does not exist`)
    return harness
  }

  find(id: string): CustomHarness | undefined {
    return this.#read().harnesses.find((entry) => entry.id === id)
  }

  upsert(input: CustomHarness): CustomHarness {
    const harness = CustomHarnessSchema.parse(input)
    assertProviderOffered(harness.provider)
    const file = this.#read()
    file.unsupported = file.unsupported.filter((entry) => entryId(entry) !== harness.id)
    const index = file.harnesses.findIndex((entry) => entry.id === harness.id)
    if (index < 0) file.harnesses.push(harness)
    else file.harnesses[index] = harness
    this.#setAsideUnreadable()
    this.#write(file)
    return harness
  }

  remove(id: string): void {
    const file = this.#read()
    const index = file.harnesses.findIndex((entry) => entry.id === id)
    if (index < 0) throw new Error(`custom harness "${id}" does not exist`)
    file.harnesses.splice(index, 1)
    this.#setAsideUnreadable()
    this.#write(file)
  }

  /** The last read could not parse the file; it is set aside before a write replaces it. */
  #readLossy = false

  #read(): ConfigFile {
    this.#readLossy = false
    if (!existsSync(this.location)) return structuredClone(EMPTY_CONFIG)
    try {
      return parseConfig(readFileSync(this.location, 'utf8'))
    } catch (error) {
      // Every ACP chat start and background source reads this file. A stray
      // comma from a hand edit must not stop them, nor the settings page that
      // could repair it: read it as empty, as the MCP config does.
      console.warn(
        `[custom-harnesses] ignoring ${this.location}: ${error instanceof Error ? error.message : String(error)}`,
      )
      this.#readLossy = true
      return structuredClone(EMPTY_CONFIG)
    }
  }

  /** A hand-edited file we could not parse is not ours to destroy. */
  #setAsideUnreadable(): void {
    if (!this.#readLossy || !existsSync(this.location)) return
    copyFileSync(
      this.location,
      `${this.location}.invalid-${Date.now()}-${randomUUID().slice(0, 8)}.bak`,
      constants.COPYFILE_EXCL,
    )
    this.#readLossy = false
  }

  #write(file: ConfigFile): void {
    mkdirSync(path.dirname(this.location), { recursive: true })
    const temporary = `${this.location}.${randomUUID()}.tmp`
    const stored = { version: file.version, harnesses: [...file.harnesses, ...file.unsupported] }
    try {
      writeFileSync(temporary, `${JSON.stringify(stored, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      })
      renameSync(temporary, this.location)
    } catch (error) {
      // Every attempt has a name of its own, so each failed one would leave
      // another .tmp beside the file. mcp-config.ts does the same.
      try {
        rmSync(temporary, { force: true })
      } catch {
        // Report the write failure, not the cleanup one.
      }
      throw error
    }
  }
}
