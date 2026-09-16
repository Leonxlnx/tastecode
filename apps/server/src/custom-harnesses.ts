import { randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
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
  // Migration owns no single harness. Earlier records overloaded harnessId
  // with a '__migration__' sentinel that a real user harness id could collide
  // with, so the operation kind carries the distinction instead.
  z.object({
    kind: z.literal('migrate'),
    expectedReferences: z.array(CustomEnvironmentCredentialReferenceSchema),
  }),
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

const LOCK_TIMEOUT_MS = 10_000
const LOCK_STALE_MS = 30_000
const LOCK_WAIT = new Int32Array(new SharedArrayBuffer(4))

/** Synchronous sleep for the lock retry loop; every caller is already sync fs. */
function pause(ms: number): void {
  Atomics.wait(LOCK_WAIT, 0, 0, ms)
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Persist the rename itself; Windows cannot fsync a directory handle. */
function fsyncDirectory(directory: string): void {
  let fd: number
  try {
    fd = openSync(directory, 'r')
  } catch {
    return
  }
  try {
    fsyncSync(fd)
  } catch {
    // EINVAL/ENOTSUP where directory fsync is unsupported.
  } finally {
    closeSync(fd)
  }
}

/** Extra timing knobs so tests do not wait on real lock timeouts. */
export type CustomHarnessLockOptions = {
  timeoutMs?: number
  staleMs?: number
}

/** Custom executable metadata with write-only, credential-backed environment values. */
export class CustomHarnessStore {
  readonly #recoveryLocation: string
  readonly #lockLocation: string

  constructor(
    private readonly location = defaultLocation(),
    private readonly credentials: CustomHarnessCredentialStore = OS_CREDENTIALS,
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly locking: CustomHarnessLockOptions = {},
  ) {
    this.#recoveryLocation = `${location}.recovery`
    this.#lockLocation = `${location}.lock`
  }

  list(): PublicCustomHarness[] {
    return this.#withLock(() => this.#read().harnesses.map(publicHarness))
  }

  get(id: string): CustomHarness {
    return this.#withLock(() => this.#materialize(this.#stored(id)))
  }

  find(id: string): CustomHarness | undefined {
    return this.#withLock(() => {
      const harness = this.#read().harnesses.find((entry) => entry.id === id)
      return harness ? this.#materialize(harness) : undefined
    })
  }

  preview(input: CustomHarnessUpdate): CustomHarness {
    return this.#withLock(() => this.#preview(input))
  }

  #preview(input: CustomHarnessUpdate): CustomHarness {
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
    return this.#withLock(() => this.#upsert(input))
  }

  #upsert(input: CustomHarnessUpdate): PublicCustomHarness {
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
    this.#withLock(() => this.#remove(id))
  }

  #remove(id: string): void {
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

  /**
   * Serialize the read → recover → commit section against other processes.
   * The Electron shell and `harness serve` share this config and keyring, so
   * without a lock an interleaved pair can roll back live staged credentials
   * or leak obsolete ones. Locking is advisory and dependency-free: an
   * exclusively created `<config>.lock` file whose owner's liveness and age
   * bound how long a dead holder can block the store.
   */
  #withLock<T>(operation: () => T): T {
    mkdirSync(path.dirname(this.location), { recursive: true })
    const timeoutMs = this.locking.timeoutMs ?? LOCK_TIMEOUT_MS
    const deadline = Date.now() + timeoutMs
    let delay = 25
    for (;;) {
      let fd: number
      try {
        fd = openSync(this.#lockLocation, 'wx')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        const stale = this.#staleLock()
        if (stale === 'missing') continue
        if (stale !== undefined) {
          try {
            // Only break the exact file that was judged stale: a contender may
            // have removed it and written its own lock in between.
            if (readFileSync(this.#lockLocation, 'utf8') === stale) {
              unlinkSync(this.#lockLocation)
            }
          } catch {
            // Another contender removed it first; retry either way.
          }
          continue
        }
        if (Date.now() >= deadline) {
          throw new Error(
            'timed out waiting for the custom harness configuration lock held by another process',
          )
        }
        pause(delay)
        delay = Math.min(delay * 2, 250)
        continue
      }
      const acquired = { pid: process.pid, createdAt: Date.now() }
      try {
        writeFileSync(fd, JSON.stringify(acquired), 'utf8')
        return operation()
      } finally {
        closeSync(fd)
        this.#releaseLock(acquired)
      }
    }
  }

  /**
   * A lock is stale when its holder can no longer release it: the recorded pid
   * is dead, or the file outlived the longest reasonable critical section. An
   * unparsable lock is treated as mid-write and only age can break it. Returns
   * the stale file's content as the breaker's fingerprint, 'missing' when the
   * lock vanished mid-check, or undefined for a live lock.
   */
  #staleLock(): string | 'missing' | undefined {
    let content: string
    let mtimeMs: number
    try {
      content = readFileSync(this.#lockLocation, 'utf8')
      mtimeMs = statSync(this.#lockLocation).mtimeMs
    } catch {
      return 'missing'
    }
    if (Date.now() - mtimeMs > (this.locking.staleMs ?? LOCK_STALE_MS)) return content
    let parsed: { pid?: unknown }
    try {
      parsed = JSON.parse(content) as { pid?: unknown }
    } catch {
      return undefined
    }
    // A lock recording our own pid can only be an orphaned leftover: the
    // critical section is synchronous and cannot re-enter #withLock.
    if (typeof parsed.pid !== 'number') return undefined
    return parsed.pid === process.pid || !pidAlive(parsed.pid) ? content : undefined
  }

  /**
   * Unlink only while the file is still ours: a breaker that called the lock
   * stale may have let another process create a fresh one in its place.
   */
  #releaseLock(acquired: { pid: number; createdAt: number }): void {
    try {
      const content = JSON.parse(readFileSync(this.#lockLocation, 'utf8')) as {
        pid?: unknown
        createdAt?: unknown
      }
      if (content.pid !== acquired.pid || content.createdAt !== acquired.createdAt) return
    } catch {
      return
    }
    try {
      unlinkSync(this.#lockLocation)
    } catch {
      // It is already gone; the next contender creates it fresh.
    }
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
      } catch (error) {
        throw new Error(
          `Custom harness environment value for "${key}" is unavailable. Unlock the OS credential store and try again.`,
          { cause: error },
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
        kind: 'migrate',
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
    } catch (error) {
      try {
        this.#recover()
      } catch (cleanupError) {
        throw new Error(
          'Custom harness environment cleanup is pending in the OS credential store; unlock the store and try again.',
          { cause: cleanupError },
        )
      }
      throw new Error(
        migration
          ? 'Custom harness environment migration could not finish; the original configuration was preserved. Unlock the OS credential store and try again.'
          : 'Custom harness environment could not be saved. Unlock the OS credential store and try again.',
        { cause: error },
      )
    }
    try {
      this.#recover()
    } catch (error) {
      // The operation already committed; reporting failure now would tell the
      // caller a lie. The recovery record stays on disk and the next read
      // retries the reference cleanup.
      console.warn(
        `[custom-harnesses] committed, but credential cleanup is deferred: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
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
    } catch (error) {
      throw new Error(
        'Custom harness environment cleanup is pending in the OS credential store; unlock the store and try again.',
        { cause: error },
      )
    }
    unlinkSync(this.#recoveryLocation)
  }

  #operationCommitted(file: Config, operation: Recovery['operation']): boolean {
    if (operation.kind === 'remove') {
      return !file.harnesses.some((entry) => entry.id === operation.harnessId)
    }
    if (operation.kind === 'upsert') {
      const harness = file.harnesses.find((entry) => entry.id === operation.harnessId)
      if (harness) {
        return this.#sameReferences(
          Object.values(harness.environmentBindings),
          operation.expectedReferences,
        )
      }
      // Records written before operations carried a `kind` marked migration
      // with a '__migration__' sentinel harness id. A real harness can claim
      // that id, so only fall back to the whole-file comparison when none did.
      if (operation.harnessId !== '__migration__') return false
    }
    const references = file.harnesses.flatMap((entry) => Object.values(entry.environmentBindings))
    return this.#sameReferences(references, operation.expectedReferences)
  }

  #sameReferences(left: string[], right: string[]): boolean {
    if (left.length !== right.length) return false
    const sortedRight = [...right].sort()
    return [...left].sort().every((value, index) => value === sortedRight[index])
  }

  #writeConfig(file: Config): void {
    this.#atomicWrite(this.location, file)
  }

  /**
   * Write-then-rename so readers only ever see complete files. The temp file
   * is fsynced before the rename and the directory after it, so a crash
   * cannot leave a zero-length config the journal cannot explain.
   */
  #atomicWrite(location: string, value: Config | Recovery): void {
    mkdirSync(path.dirname(location), { recursive: true })
    const temporary = `${location}.${randomUUID()}.tmp`
    try {
      const fd = openSync(temporary, 'w', 0o600)
      try {
        writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
    } catch (error) {
      try {
        unlinkSync(temporary)
      } catch {
        // A leftover unique-name temp file is harmless; the write still failed.
      }
      throw error
    }
    renameSync(temporary, location)
    fsyncDirectory(path.dirname(location))
  }
}
