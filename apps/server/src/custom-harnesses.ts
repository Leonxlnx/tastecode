import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  CustomHarnessEnvironmentKeySchema,
  CustomHarnessSchema,
  CustomHarnessUpdateSchema,
  type CustomHarness,
  type CustomHarnessEnvironmentUpdates,
  type CustomHarnessUpdate,
  type PublicCustomHarness,
} from '@harness/contracts'
import { z } from 'zod'
import { readCredential, removeCredentialStrict, writeCredential } from './credentials.js'
import { configFile } from './product-paths.js'

const CustomEnvironmentCredentialReferenceSchema = z
  .string()
  .regex(
    /^custom-environment\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  )

const EnvironmentBindingsSchema = z
  .record(CustomHarnessEnvironmentKeySchema, CustomEnvironmentCredentialReferenceSchema)
  .refine((value) => Object.keys(value).length <= 64, 'too many environment entries')

const StoredHarnessSchema = CustomHarnessSchema.omit({ environment: true }).extend({
  environmentBindings: EnvironmentBindingsSchema,
})
type StoredHarness = z.infer<typeof StoredHarnessSchema>
type MaterializedEnvironment = NonNullable<CustomHarness['environment']>

const LegacyConfigSchema = z.object({
  version: z.literal(1),
  harnesses: z.array(CustomHarnessSchema),
})
type LegacyConfig = z.infer<typeof LegacyConfigSchema>

const ConfigSchema = z
  .object({
    version: z.literal(2),
    harnesses: z.array(StoredHarnessSchema),
  })
  .superRefine(({ harnesses }, context) => {
    const references = harnesses.flatMap((harness) => Object.values(harness.environmentBindings))
    if (new Set(references).size !== references.length) {
      context.addIssue({
        code: 'custom',
        message: 'duplicate custom environment credential reference',
      })
    }
  })
type Config = z.infer<typeof ConfigSchema>

const EMPTY_CONFIG: Config = { version: 2, harnesses: [] }

const RecoveryOperationSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('upsert'),
    harnessId: z.string().min(1),
    expectedReferences: z.array(CustomEnvironmentCredentialReferenceSchema),
  }),
  z.object({ kind: z.literal('remove'), harnessId: z.string().min(1) }),
])

const RecoverySchema = z.object({
  version: z.literal(1),
  operation: RecoveryOperationSchema,
  stagedReferences: z.array(CustomEnvironmentCredentialReferenceSchema),
  obsoleteReferences: z.array(CustomEnvironmentCredentialReferenceSchema),
})
type Recovery = z.infer<typeof RecoverySchema>

export type CustomHarnessCredentialStore = {
  read(reference: string): string
  write(reference: string, value: string): void
  remove(reference: string): void
}

const OS_CREDENTIALS: CustomHarnessCredentialStore = {
  read: readCredential,
  write: writeCredential,
  remove: removeCredentialStrict,
}

function defaultLocation(): string {
  return configFile('custom-harnesses.json')
}

function parseJson(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    throw new Error(`invalid ${label}: expected valid JSON`)
  }
}

function parseConfig(raw: string): Config | LegacyConfig {
  const value = z
    .union([ConfigSchema, LegacyConfigSchema])
    .safeParse(parseJson(raw, 'custom harness config'))
  if (!value.success) {
    throw new Error('invalid custom harness config: expected a version 1 or 2 harness list')
  }
  return value.data
}

function parseRecovery(raw: string): Recovery {
  const value = RecoverySchema.safeParse(parseJson(raw, 'custom harness recovery record'))
  if (!value.success) {
    throw new Error('invalid custom harness recovery record')
  }
  return value.data
}

function credentialReference(): string {
  return `custom-environment/${randomUUID()}`
}

function environmentIdentity(key: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? key.toLowerCase() : key
}

function assertPortableUpdates(
  updates: CustomHarnessEnvironmentUpdates,
  platform: NodeJS.Platform,
): void {
  const setKeys = new Set<string>()
  for (const key of Object.keys(updates.set)) {
    const identity = environmentIdentity(key, platform)
    if (setKeys.has(identity)) throw new Error('environment update contains equivalent set keys')
    setKeys.add(identity)
  }
  const unsetKeys = new Set<string>()
  for (const key of updates.unset) {
    const identity = environmentIdentity(key, platform)
    if (unsetKeys.has(identity))
      throw new Error('environment update contains equivalent unset keys')
    if (setKeys.has(identity)) throw new Error('environment key cannot be both set and unset')
    unsetKeys.add(identity)
  }
}

function publicHarness(harness: StoredHarness): PublicCustomHarness {
  const { environmentBindings, ...metadata } = harness
  return { ...metadata, environmentKeys: Object.keys(environmentBindings) }
}

/** Custom executable metadata with write-only, credential-backed environment values. */
export class CustomHarnessStore {
  readonly #recoveryLocation: string

  constructor(
    private readonly location = defaultLocation(),
    private readonly credentials: CustomHarnessCredentialStore = OS_CREDENTIALS,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {
    this.#recoveryLocation = `${location}.recovery`
  }

  list(): PublicCustomHarness[] {
    return this.#read().harnesses.map(publicHarness)
  }

  get(id: string): CustomHarness {
    const harness = this.#stored(id)
    return this.#materialize(harness)
  }

  find(id: string): CustomHarness | undefined {
    const harness = this.#read().harnesses.find((entry) => entry.id === id)
    return harness ? this.#materialize(harness) : undefined
  }

  preview(input: CustomHarnessUpdate): CustomHarness {
    const update = CustomHarnessUpdateSchema.parse(input)
    const existing = this.#read().harnesses.find((entry) => entry.id === update.id)
    const environment = existing ? this.#materializeEnvironment(existing) : {}
    this.#applyValues(environment, update.environmentUpdates)
    const { environmentUpdates: _updates, ...metadata } = update
    return {
      ...metadata,
      ...(Object.keys(environment).length === 0 ? {} : { environment }),
    }
  }

  upsert(input: CustomHarnessUpdate): PublicCustomHarness {
    const update = CustomHarnessUpdateSchema.parse(input)
    const file = this.#read()
    const index = file.harnesses.findIndex((entry) => entry.id === update.id)
    const existing = index < 0 ? undefined : file.harnesses[index]
    const environmentBindings = { ...existing?.environmentBindings }
    const staged: Array<{ reference: string; value: string }> = []
    const obsoleteReferences: string[] = []

    if (update.environmentUpdates) {
      assertPortableUpdates(update.environmentUpdates, this.platform)
      for (const key of update.environmentUpdates.unset) {
        const existingKey = this.#equivalentKey(environmentBindings, key)
        if (!existingKey) continue
        const obsoleteReference = environmentBindings[existingKey]
        if (obsoleteReference) obsoleteReferences.push(obsoleteReference)
        delete environmentBindings[existingKey]
      }
      for (const [key, value] of Object.entries(update.environmentUpdates.set)) {
        const existingKey = this.#equivalentKey(environmentBindings, key)
        if (existingKey) {
          const obsoleteReference = environmentBindings[existingKey]
          if (obsoleteReference) obsoleteReferences.push(obsoleteReference)
          delete environmentBindings[existingKey]
        }
        const reference = credentialReference()
        environmentBindings[key] = reference
        staged.push({ reference, value })
      }
    }

    if (Object.keys(environmentBindings).length > 64) {
      throw new Error('custom harness cannot have more than 64 environment entries')
    }

    const { environmentUpdates: _updates, ...metadata } = update
    const harness = StoredHarnessSchema.parse({ ...metadata, environmentBindings })
    if (index < 0) file.harnesses.push(harness)
    else file.harnesses[index] = harness

    if (staged.length === 0 && obsoleteReferences.length === 0) {
      this.#writeConfig(file)
    } else {
      this.#commitCredentialChange(
        file,
        {
          kind: 'upsert',
          harnessId: harness.id,
          expectedReferences: Object.values(environmentBindings),
        },
        staged,
        obsoleteReferences,
      )
    }
    return publicHarness(harness)
  }

  remove(id: string): void {
    const file = this.#read()
    const index = file.harnesses.findIndex((entry) => entry.id === id)
    if (index < 0) throw new Error(`custom harness "${id}" does not exist`)
    const [harness] = file.harnesses.splice(index, 1)
    if (!harness || Object.keys(harness.environmentBindings).length === 0) {
      this.#writeConfig(file)
      return
    }
    this.#commitCredentialChange(
      file,
      { kind: 'remove', harnessId: id },
      [],
      Object.values(harness.environmentBindings),
    )
  }

  #stored(id: string): StoredHarness {
    const harness = this.#read().harnesses.find((entry) => entry.id === id)
    if (!harness) throw new Error(`custom harness "${id}" does not exist`)
    return harness
  }

  #materialize(harness: StoredHarness): CustomHarness {
    const { environmentBindings: _bindings, ...metadata } = harness
    const environment = this.#materializeEnvironment(harness)
    return {
      ...metadata,
      ...(Object.keys(environment).length === 0 ? {} : { environment }),
    }
  }

  #materializeEnvironment(harness: StoredHarness): MaterializedEnvironment {
    const environment: MaterializedEnvironment = {}
    for (const [key, reference] of Object.entries(harness.environmentBindings)) {
      try {
        environment[key] = this.credentials.read(reference)
      } catch {
        throw new Error(
          `Custom harness environment value for "${key}" is unavailable. Unlock the OS credential store and try again.`,
        )
      }
    }
    return environment
  }

  #applyValues(
    environment: Record<string, string>,
    updates: CustomHarnessEnvironmentUpdates | undefined,
  ): void {
    if (!updates) return
    assertPortableUpdates(updates, this.platform)
    for (const key of updates.unset) {
      const existingKey = this.#equivalentKey(environment, key)
      if (existingKey) delete environment[existingKey]
    }
    for (const [key, value] of Object.entries(updates.set)) {
      const existingKey = this.#equivalentKey(environment, key)
      if (existingKey) delete environment[existingKey]
      environment[key] = value
    }
    if (Object.keys(environment).length > 64) {
      throw new Error('custom harness cannot have more than 64 environment entries')
    }
  }

  #equivalentKey(values: Record<string, unknown>, key: string): string | undefined {
    const identity = environmentIdentity(key, this.platform)
    return Object.keys(values).find(
      (candidate) => environmentIdentity(candidate, this.platform) === identity,
    )
  }

  #read(): Config {
    this.#recover()
    if (!existsSync(this.location)) return structuredClone(EMPTY_CONFIG)
    const file = parseConfig(readFileSync(this.location, 'utf8'))
    if (file.version === 1) return this.#migrate(file)
    for (const harness of file.harnesses) {
      const keys = Object.keys(harness.environmentBindings)
      assertPortableUpdates(
        { set: Object.fromEntries(keys.map((key) => [key, ''])), unset: [] },
        this.platform,
      )
    }
    return file
  }

  #migrate(legacy: LegacyConfig): Config {
    const harnesses: StoredHarness[] = []
    const staged: Array<{ reference: string; value: string }> = []
    for (const harness of legacy.harnesses) {
      const environmentBindings: Record<string, string> = {}
      const environment = harness.environment ?? {}
      assertPortableUpdates({ set: environment, unset: [] }, this.platform)
      for (const [key, value] of Object.entries(environment)) {
        const reference = credentialReference()
        environmentBindings[key] = reference
        staged.push({ reference, value })
      }
      const { environment: _environment, ...metadata } = harness
      harnesses.push(StoredHarnessSchema.parse({ ...metadata, environmentBindings }))
    }
    const file: Config = { version: 2, harnesses }
    if (staged.length === 0) {
      this.#writeConfig(file)
      return file
    }
    this.#commitCredentialChange(
      file,
      {
        kind: 'upsert',
        harnessId: '__migration__',
        expectedReferences: staged.map(({ reference }) => reference),
      },
      staged,
      [],
      true,
    )
    return file
  }

  #commitCredentialChange(
    file: Config,
    operation: Recovery['operation'],
    staged: Array<{ reference: string; value: string }>,
    obsoleteReferences: string[],
    migration = false,
  ): void {
    const recovery: Recovery = {
      version: 1,
      operation,
      stagedReferences: staged.map(({ reference }) => reference),
      obsoleteReferences: [...new Set(obsoleteReferences)],
    }
    this.#atomicWrite(this.#recoveryLocation, recovery)
    try {
      for (const { reference, value } of staged) {
        this.credentials.write(reference, value)
        if (this.credentials.read(reference) !== value) {
          throw new Error('credential verification failed')
        }
      }
      this.#writeConfig(file)
    } catch {
      try {
        this.#recover()
      } catch {
        throw new Error(
          'Custom harness environment cleanup is pending in the OS credential store; unlock the store and try again.',
        )
      }
      throw new Error(
        migration
          ? 'Custom harness environment migration could not finish; the original configuration was preserved. Unlock the OS credential store and try again.'
          : 'Custom harness environment could not be saved. Unlock the OS credential store and try again.',
      )
    }
    this.#recover()
  }

  #recover(): void {
    if (!existsSync(this.#recoveryLocation)) return
    const recovery = parseRecovery(readFileSync(this.#recoveryLocation, 'utf8'))
    const current = existsSync(this.location)
      ? parseConfig(readFileSync(this.location, 'utf8'))
      : EMPTY_CONFIG
    const committed = current.version === 2 && this.#operationCommitted(current, recovery.operation)
    const references = committed ? recovery.obsoleteReferences : recovery.stagedReferences
    try {
      for (const reference of references) this.credentials.remove(reference)
    } catch {
      throw new Error(
        'Custom harness environment cleanup is pending in the OS credential store; unlock the store and try again.',
      )
    }
    unlinkSync(this.#recoveryLocation)
  }

  #operationCommitted(file: Config, operation: Recovery['operation']): boolean {
    const harness = file.harnesses.find((entry) => entry.id === operation.harnessId)
    if (operation.kind === 'remove') return harness === undefined
    if (operation.harnessId === '__migration__') {
      const references = file.harnesses.flatMap((entry) => Object.values(entry.environmentBindings))
      return this.#sameReferences(references, operation.expectedReferences)
    }
    return (
      harness !== undefined &&
      this.#sameReferences(Object.values(harness.environmentBindings), operation.expectedReferences)
    )
  }

  #sameReferences(left: string[], right: string[]): boolean {
    if (left.length !== right.length) return false
    const sortedRight = [...right].sort()
    return [...left].sort().every((value, index) => value === sortedRight[index])
  }

  #writeConfig(file: Config): void {
    this.#atomicWrite(this.location, file)
  }

  #atomicWrite(location: string, value: Config | Recovery): void {
    mkdirSync(path.dirname(location), { recursive: true })
    const temporary = `${location}.${randomUUID()}.tmp`
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
    renameSync(temporary, location)
  }
}
