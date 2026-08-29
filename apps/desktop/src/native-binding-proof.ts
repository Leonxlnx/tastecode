import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PTY_MARKER = 'TASTECODE_NATIVE_PTY_OK'
const CREDENTIAL_SERVICE = 'TasteCode Native Binding Proof'

export interface Disposable {
  dispose(): void
}

export interface PtyProcess {
  onData(listener: (data: string) => void): Disposable
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): Disposable
  resize(columns: number, rows: number): void
  kill(): void
}

export interface PtyModule {
  spawn(
    file: string,
    args: string[],
    options: {
      name: string
      cols: number
      rows: number
      cwd: string
      env: Record<string, string>
    },
  ): PtyProcess
}

export interface KeyringEntry {
  getPassword(): string | null
  setPassword(value: string): void
  deletePassword(): void
}

export interface KeyringModule {
  Entry: new (service: string, account: string) => KeyringEntry
}

export interface PackagedNativeModules {
  pty: PtyModule
  keyring: KeyringModule
  moduleEntries: string[]
  nativeBindings: string[]
}

function environment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  )
}

function canonicalPath(pathname: string): string {
  return pathname
    .replaceAll('\\', '/')
    .replaceAll(/\/{2,}/g, '/')
    .toLowerCase()
}

function archiveRoot(proofFile: string): string | undefined {
  const match = /[\\/]app\.asar[\\/]/i.exec(proofFile)
  return match ? proofFile.slice(0, match.index + match[0].length - 1) : undefined
}

function isInsideArchive(pathname: string, archive: string): boolean {
  const normalized = canonicalPath(pathname)
  const canonicalArchive = canonicalPath(archive)
  return (
    normalized.startsWith(`${canonicalArchive}/`) ||
    normalized.startsWith(`${canonicalArchive}.unpacked/`)
  )
}

function unpackedBindingPath(pathname: string, archive: string): string | undefined {
  const normalized = canonicalPath(pathname)
  const canonicalArchive = canonicalPath(archive)
  if (normalized.startsWith(`${canonicalArchive}.unpacked/`)) return pathname
  if (!normalized.startsWith(`${canonicalArchive}/`)) return undefined

  // Electron keeps the virtual app.asar path as the require.cache key even
  // when its ASAR loader reads a native module from app.asar.unpacked.
  const physicalPath = `${archive}.unpacked${pathname.slice(archive.length)}`
  return existsSync(physicalPath) ? physicalPath : undefined
}

export function assertPackagedNativeModules(
  proofFile: string,
  modules: Pick<PackagedNativeModules, 'moduleEntries' | 'nativeBindings'>,
): void {
  const archive = archiveRoot(proofFile)
  if (!archive) throw new Error('native proof must execute from the packaged app.asar')
  for (const entry of modules.moduleEntries) {
    if (!isInsideArchive(entry, archive)) {
      throw new Error(`native module entry resolved outside the packaged application: ${entry}`)
    }
  }
  const unpackedBindings = modules.nativeBindings.flatMap((binding) => {
    const unpackedBinding = unpackedBindingPath(binding, archive)
    return unpackedBinding ? [unpackedBinding] : []
  })
  if (!unpackedBindings.some((binding) => binding.toLowerCase().includes('node-pty'))) {
    throw new Error('the unpacked node-pty native binding was not loaded')
  }
  if (!unpackedBindings.some((binding) => binding.toLowerCase().includes('keyring'))) {
    throw new Error('the unpacked keyring native binding was not loaded')
  }
}

export function loadPackagedNativeModules(): PackagedNativeModules {
  const desktopRequire = createRequire(import.meta.url)
  // These bindings belong to the packaged server workspace. Resolve from its
  // entry so pnpm's strict dependency layout is exercised exactly as it is by
  // the real server instead of relying on accidental desktop-level hoisting.
  const serverRequire = createRequire(desktopRequire.resolve('@harness/server'))
  const before = new Set(Object.keys(serverRequire.cache))
  const pty: PtyModule = serverRequire('node-pty')
  const keyring: KeyringModule = serverRequire('@napi-rs/keyring')
  return {
    pty,
    keyring,
    moduleEntries: [serverRequire.resolve('node-pty'), serverRequire.resolve('@napi-rs/keyring')],
    get nativeBindings() {
      return Object.keys(serverRequire.cache).filter(
        (modulePath) => !before.has(modulePath) && path.extname(modulePath) === '.node',
      )
    },
  }
}

export async function provePtyBinding(pty: PtyModule, platform = process.platform): Promise<void> {
  const shell = platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : '/bin/sh'
  const args =
    platform === 'win32' ? ['/d', '/s', '/c', `echo ${PTY_MARKER}`] : ['-c', `printf ${PTY_MARKER}`]
  const child = pty.spawn(shell, args, {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: process.cwd(),
    env: environment(),
  })
  let output = ''
  let timer: ReturnType<typeof setTimeout> | undefined
  let dataSubscription: Disposable | undefined
  let exitSubscription: Disposable | undefined

  try {
    const exit = new Promise<{ exitCode: number; signal?: number }>((resolve, reject) => {
      dataSubscription = child.onData((data) => {
        output = `${output}${data}`.slice(-4_096)
      })
      exitSubscription = child.onExit((event) => resolve(event))
      timer = setTimeout(() => {
        child.kill()
        reject(new Error('packaged PTY proof timed out'))
      }, 10_000)
    })
    child.resize(100, 30)
    const result = await exit
    if (result.exitCode !== 0) throw new Error(`packaged PTY exited with code ${result.exitCode}`)
    if (!output.includes(PTY_MARKER))
      throw new Error('packaged PTY did not return its proof marker')
  } finally {
    if (timer) clearTimeout(timer)
    dataSubscription?.dispose()
    exitSubscription?.dispose()
    try {
      child.kill()
    } catch {
      // A naturally exited PTY may already have released its native handle.
    }
  }
}

export function proveSqliteRuntime(): void {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'tastecode-sqlite-proof-'))
  let database: DatabaseSync | undefined
  try {
    database = new DatabaseSync(path.join(directory, 'proof.sqlite'))
    database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE proof (value TEXT NOT NULL);
      CREATE VIRTUAL TABLE proof_search USING fts5(value);
    `)
    database.prepare('INSERT INTO proof (value) VALUES (?)').run('packaged-sqlite')
    database.prepare('INSERT INTO proof_search (value) VALUES (?)').run('packaged-search')
    const stored = database.prepare('SELECT value FROM proof').get() as { value?: unknown }
    const searched = database
      .prepare('SELECT value FROM proof_search WHERE proof_search MATCH ?')
      .get('packaged') as { value?: unknown }
    if (stored.value !== 'packaged-sqlite' || searched.value !== 'packaged-search') {
      throw new Error('packaged SQLite or FTS5 read-back failed')
    }
  } finally {
    database?.close()
    rmSync(directory, { recursive: true, force: true })
  }
}

export function proveKeyringBinding(keyring: KeyringModule): void {
  const account = `native-proof-${process.platform}-${process.arch}-${randomUUID()}`
  const password = `proof-${randomUUID()}`
  const entry = new keyring.Entry(CREDENTIAL_SERVICE, account)
  let stored = false

  try {
    entry.setPassword(password)
    stored = true
    if (entry.getPassword() !== password) throw new Error('packaged keyring read-back failed')
    entry.deletePassword()
    stored = false
    if (entry.getPassword() !== null) throw new Error('packaged keyring deletion failed')
  } finally {
    if (stored) {
      try {
        entry.deletePassword()
      } catch {
        // The proof must preserve the original failure while still attempting cleanup.
      }
    }
  }
}

export function isNativeBindingProofPlatform(platform: NodeJS.Platform): boolean {
  return platform === 'win32' || platform === 'darwin' || platform === 'linux'
}

export async function runNativeBindingProof(
  options: { proofFile?: string; modules?: PackagedNativeModules } = {},
): Promise<void> {
  const proofFile = options.proofFile ?? fileURLToPath(import.meta.url)
  if (!process.versions.electron || process.env.ELECTRON_RUN_AS_NODE !== '1') {
    throw new Error('native proof must run through the packaged Electron executable in Node mode')
  }
  if (!isNativeBindingProofPlatform(process.platform)) {
    throw new Error('native proof is a Windows, macOS, and Linux release gate')
  }
  const modules = options.modules ?? loadPackagedNativeModules()
  await provePtyBinding(modules.pty)
  assertPackagedNativeModules(proofFile, modules)
  proveSqliteRuntime()
  proveKeyringBinding(modules.keyring)
}

const isEntryPoint =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href

if (isEntryPoint) {
  runNativeBindingProof()
    .then(() => process.stdout.write('packaged PTY, SQLite, and keyring proofs passed\n'))
    .catch((error) => {
      process.stderr.write(
        `[native-proof] ${error instanceof Error ? error.message : String(error)}\n`,
      )
      process.exitCode = 1
    })
}
