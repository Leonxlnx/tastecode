import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CustomHarnessSchema, type CustomHarness } from '@harness/contracts'

type ConfigFile = { version: 1; harnesses: CustomHarness[] }
const EMPTY_CONFIG: ConfigFile = { version: 1, harnesses: [] }

function defaultLocation(): string {
  const root = process.env['HARNESS_CONFIG_DIR'] ?? path.join(os.homedir(), '.personalharness')
  return path.join(root, 'custom-harnesses.json')
}

function parseConfig(raw: string): ConfigFile {
  const value = JSON.parse(raw) as { version?: unknown; harnesses?: unknown }
  if (value.version !== 1 || !Array.isArray(value.harnesses)) {
    throw new Error('invalid custom harness config: expected a version 1 harness list')
  }
  return {
    version: 1,
    harnesses: value.harnesses.map((entry) => CustomHarnessSchema.parse(entry)),
  }
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
    const file = this.#read()
    const index = file.harnesses.findIndex((entry) => entry.id === harness.id)
    if (index < 0) file.harnesses.push(harness)
    else file.harnesses[index] = harness
    this.#write(file)
    return harness
  }

  remove(id: string): void {
    const file = this.#read()
    const index = file.harnesses.findIndex((entry) => entry.id === id)
    if (index < 0) throw new Error(`custom harness "${id}" does not exist`)
    file.harnesses.splice(index, 1)
    this.#write(file)
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
