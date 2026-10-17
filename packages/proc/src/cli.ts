import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { accessSync, constants, realpathSync, statSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { applyDesktopPath, desktopPath } from './desktop-path.js'
import { killTree, spawnOwned } from './kill.js'

/**
 * Spawn a CLI that may have been installed as an npm shim.
 *
 * On Windows, `codex` is `codex.cmd` and `claude` is `claude.cmd` — batch
 * files. `spawn('codex')` fails with EINVAL because CreateProcess cannot
 * execute a .cmd directly; it has to go through cmd.exe. This is the single
 * most common way a cross-platform agent wrapper breaks on Windows, so every
 * adapter shares this one implementation rather than each rediscovering it.
 *
 * Native executables bypass the shell. Batch shims need both Windows argv
 * quoting and cmd escaping; Node's default argv quoting alone is not enough.
 */
export function spawnCli(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; replaceEnv?: boolean } = {},
): ChildProcessWithoutNullStreams {
  const spawnOptions = {
    ...(!(options.cwd === undefined) ? { cwd: options.cwd } : {}),
    env: childEnvironment(options),
    stdio: ['pipe', 'pipe', 'pipe'] satisfies ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  }

  if (process.platform === 'win32') {
    if (/\.(?:exe|com)$/i.test(command)) return spawnOwned(command, args, spawnOptions)
    const resolved = resolveWindowsExecutable(command, spawnOptions.env, options.cwd)
    const executable = resolved ?? command
    if (/\.(?:exe|com)$/i.test(executable)) return spawnOwned(executable, args, spawnOptions)
    const batch = /\.(?:cmd|bat)$/i.test(executable)
    const shellCommand = [
      escapeCmdToken(path.win32.normalize(executable)),
      ...args.map((argument) => quoteCmdArgument(argument, batch)),
    ].join(' ')
    return spawnOwned('cmd.exe', ['/d', '/s', '/v:off', '/c', `"${shellCommand}"`], {
      ...spawnOptions,
      // cmd.exe searches cwd for a name it could not find on PATH either.
      ...(resolved
        ? {}
        : {
            env: { ...(spawnOptions.env ?? process.env), NoDefaultCurrentDirectoryInExePath: '1' },
          }),
      windowsVerbatimArguments: true,
    })
  }
  return spawnOwned(command, args, spawnOptions)
}

const CMD_META = /([()[\]%!^"`<>&|;, *?\t\v\f])/g

function escapeCmdToken(value: string): string {
  // cmd cannot carry literal line breaks safely. Multiline CLI bodies belong on stdin.
  if (/[\r\n\0]/.test(value)) {
    throw new Error('Windows batch commands cannot contain line breaks or NUL bytes')
  }
  return value.replace(CMD_META, '^$1')
}

export function quoteCmdArgument(value: string, batch = false): string {
  if (value && !/[\s()[\]%!^"`<>&|;,*?\0]/.test(value)) return value
  let quoted = '"'
  let backslashes = 0
  for (const character of value) {
    if (character === '\\') {
      backslashes += 1
      continue
    }
    quoted += '\\'.repeat(character === '"' ? backslashes * 2 + 1 : backslashes) + character
    backslashes = 0
  }
  quoted += '\\'.repeat(backslashes * 2) + '"'
  const escaped = escapeCmdToken(quoted)
  // A forwarding .cmd shim parses %* a second time before starting its executable.
  return batch ? escapeCmdToken(escaped) : escaped
}

// The same few CLIs start dozens of times a session, and one PATH × PATHEXT walk
// is hundreds of synchronous stats (35-77 ms measured) on the server's only
// thread. A found command costs one stat to reuse. A missing one is looked up
// again after a few seconds, so a CLI installed meanwhile shows up.
const FOUND_COMMAND_TTL_MS = 5 * 60_000
const MISSING_COMMAND_TTL_MS = 5_000
const COMMAND_CACHE_LIMIT = 256
const commandCache = new Map<string, { path: string | undefined; expiresAt: number }>()

/** Forget every command lookup, for example after an install or update finished. */
export function invalidateCommandCache(): void {
  commandCache.clear()
  folderListings.clear()
}

type WindowsLookup = { key: string; candidates: () => Generator<string> }

function windowsLookup(
  command: string,
  environment: NodeJS.ProcessEnv,
  cwd: string,
): WindowsLookup {
  const envValue = (name: string) =>
    Object.entries(environment).find(([key]) => key.toUpperCase() === name)?.[1]
  const searchPath = envValue('PATH') ?? ''
  const pathExt = envValue('PATHEXT') ?? '.COM;.EXE;.BAT;.CMD'
  const relative = /[\\/]/.test(command)
  return {
    // cwd only matters to a command that names a directory.
    key: [command, searchPath, pathExt, relative ? cwd : ''].join('\0'),
    candidates: () => windowsCandidates(command, searchPath, pathExt, relative, cwd),
  }
}

function cachedLookup(key: string): { path: string | undefined } | undefined {
  const cached = commandCache.get(key)
  return cached && cached.expiresAt > Date.now() ? cached : undefined
}

function rememberLookup(key: string, found: string | undefined): string | undefined {
  // Re-inserting keeps the oldest lookup first for the size limit below.
  commandCache.delete(key)
  commandCache.set(key, {
    path: found,
    expiresAt: Date.now() + (found ? FOUND_COMMAND_TTL_MS : MISSING_COMMAND_TTL_MS),
  })
  if (commandCache.size > COMMAND_CACHE_LIMIT) {
    const oldest = commandCache.keys().next().value
    if (oldest !== undefined) commandCache.delete(oldest)
  }
  return found
}

function resolveWindowsExecutable(
  command: string,
  environment: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): string | undefined {
  const lookup = windowsLookup(command, environment, cwd)
  const cached = cachedLookup(lookup.key)
  if (cached && (cached.path === undefined || isFile(cached.path))) return cached.path
  for (const candidate of lookup.candidates()) {
    // Match Windows PATH/PATHEXT order without launching the candidate.
    if (isFile(candidate)) return rememberLookup(lookup.key, candidate)
  }
  return rememberLookup(lookup.key, undefined)
}

/**
 * The same lookup without blocking the event loop. One directory listing per
 * PATH entry replaces hundreds of stats, and a burst of lookups shares them.
 */
async function resolveWindowsExecutableAsync(
  command: string,
  environment: NodeJS.ProcessEnv,
  cwd = process.cwd(),
): Promise<string | undefined> {
  const lookup = windowsLookup(command, environment, cwd)
  const cached = cachedLookup(lookup.key)
  if (cached && (cached.path === undefined || (await isFileAsync(cached.path)))) {
    return cached.path
  }
  const candidates = [...lookup.candidates()]
  const folder = (candidate: string) => path.win32.dirname(candidate).toLowerCase()
  const folders = [...new Set(candidates.map(folder))]
  const listings = new Map(
    await Promise.all(folders.map(async (name) => [name, await folderNames(name)] as const)),
  )
  for (const candidate of candidates) {
    const names = listings.get(folder(candidate))
    if (!names?.has(path.win32.basename(candidate).toLowerCase())) continue
    if (await isFileAsync(candidate)) return rememberLookup(lookup.key, candidate)
  }
  return rememberLookup(lookup.key, undefined)
}

/** Every path Windows would try for `command`, in PATH, then PATHEXT, order. */
function* windowsCandidates(
  command: string,
  searchPath: string,
  pathExt: string,
  relative: boolean,
  cwd: string,
): Generator<string> {
  const extensions = path.win32.extname(command) ? [''] : pathExt.split(';')
  // A bare command is searched on PATH only, never in cwd: cwd is usually the
  // user's workspace, and a checked-in `git.cmd` must not shadow the real tool.
  // Empty PATH entries are skipped because they would resolve to cwd as well.
  const directories = relative
    ? [cwd]
    : searchPath
        .split(';')
        .map((directory) => directory.replace(/^"|"$/g, ''))
        .filter(Boolean)
  for (const directory of directories) {
    for (const extension of extensions) {
      yield path.win32.resolve(cwd, directory, command + extension)
    }
  }
}

// Detection asks for a dozen commands at once; they share one listing per folder.
const FOLDER_LISTING_TTL_MS = 2_000
const folderListings = new Map<string, { names: Promise<Set<string> | undefined>; at: number }>()

function folderNames(folder: string): Promise<Set<string> | undefined> {
  const cached = folderListings.get(folder)
  if (cached && Date.now() - cached.at < FOLDER_LISTING_TTL_MS) return cached.names
  if (folderListings.size > COMMAND_CACHE_LIMIT) folderListings.clear()
  const names = readdir(folder).then(
    (entries) => new Set(entries.map((entry) => entry.toLowerCase())),
    () => undefined,
  )
  folderListings.set(folder, { names, at: Date.now() })
  return names
}

function isFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile()
  } catch {
    return false
  }
}

function isFileAsync(candidate: string): Promise<boolean> {
  return stat(candidate).then(
    (entry) => entry.isFile(),
    () => false,
  )
}

/**
 * Where a command would be found on the desktop-safe PATH, without running it.
 *
 * On Windows this is the same PATH × PATHEXT lookup spawnCli launches from, and
 * it fills the same cache, so detection and launching agree, the working
 * directory is never searched, and the first launch after detection is cheap.
 */
export function locateCommand(
  command: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  if (process.platform !== 'win32') return Promise.resolve(resolveExecutable(command, environment))
  const env = { ...environment }
  applyDesktopPath(env)
  return resolveWindowsExecutableAsync(command, env)
}

/** npm's forwarding shim for a package whose bin is a native executable, LF line ends. */
const NPM_NATIVE_SHIM =
  /^@ECHO off\nGOTO start\n:find_dp0\nSET dp0=%~dp0\nEXIT \/b\n:start\nSETLOCAL\nCALL :find_dp0\n"%dp0%\\([^"%\n]+\.exe)"[ \t]+%\*$/i

/**
 * The native executable an npm shim forwards to, on Windows.
 *
 * npm installs a CLI that ships a Windows binary (opencode-ai, for one) as a
 * `.cmd` file whose only work is to start `node_modules\...\<name>.exe`.
 * Launched through it, the real program is cmd.exe's child: the pid a caller
 * holds is the shim's, and a long-lived server can outlive a cleanup that only
 * reached cmd.exe. Starting the executable directly avoids both. Any other
 * shim, a node script among them, gives undefined, and the caller keeps
 * launching the command as before.
 */
export async function nativeShimTarget(
  command: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  if (process.platform !== 'win32') return undefined
  const shim = await locateCommand(command, environment)
  if (!shim || !/\.cmd$/i.test(shim)) return undefined
  let text: string
  try {
    text = await readFile(shim, 'utf8')
  } catch {
    return undefined
  }
  const target = NPM_NATIVE_SHIM.exec(text.replace(/\r\n/g, '\n').trim())?.[1]
  if (!target) return undefined
  const executable = path.win32.join(path.win32.dirname(shim), target)
  return (await isFileAsync(executable)) ? executable : undefined
}

/**
 * Whether a command exists on PATH.
 *
 * Asked with a PATH lookup rather than by running the thing: agent CLIs open
 * browsers, start sessions, and print banners on first launch, none of which
 * is an acceptable side effect of drawing a list.
 */
export async function isInstalled(
  command: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  return (await locateCommand(command, environment)) !== undefined
}

function childEnvironment(options: {
  env?: NodeJS.ProcessEnv
  replaceEnv?: boolean
}): NodeJS.ProcessEnv | undefined {
  if (options.replaceEnv) return options.env
  const env = { ...process.env, ...options.env }
  applyDesktopPath(env)
  return env
}

/**
 * A CLI's own version string, or undefined if it will not say.
 *
 * Every vendor formats this differently and some print startup noise first, so
 * this takes the first line that contains a version-looking number rather than
 * trusting position. Reporting nothing beats reporting a deprecation warning as
 * if it were a version.
 */
export async function commandVersion(
  command: string,
  timeoutMs = 5000,
): Promise<string | undefined> {
  if (process.platform !== 'win32') {
    const executable = resolveExecutable(command)
    if (executable) {
      try {
        const target = path.basename(realpathSync(executable))
        const linkedVersion = /^v?(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?)$/.exec(target)?.[1]
        if (linkedVersion) return linkedVersion
      } catch {
        // The command can disappear between PATH lookup and realpath. Let the
        // normal process fallback report that race as an unavailable version.
      }
    }
  }

  return spawnCommandVersion(command, timeoutMs)
}

async function spawnCommandVersion(
  command: string,
  timeoutMs: number,
): Promise<string | undefined> {
  try {
    const child = spawnCli(command, ['--version'])
    const captured = captureCli(child, timeoutMs, 64 * 1024, commandLabel(command))
    endStdin(child)
    const { stdout } = await captured
    return (
      stdout
        .split('\n')
        .find((entry) => /\d+\.\d+/.test(entry))
        ?.trim() || undefined
    )
  } catch {
    return undefined
  }
}

function resolveExecutable(
  command: string,
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const candidates = command.includes(path.sep)
    ? [command]
    : desktopPath(environment.PATH ?? '', { env: environment })
        .split(path.delimiter)
        .map((directory) => path.join(directory || '.', command))

  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK)
      // X_OK also holds for a directory, such as one named after the CLI.
      if (statSync(candidate).isFile()) return candidate
    } catch {
      // Continue in PATH order, matching normal command resolution.
    }
  }
  return undefined
}

/** Run a short, non-interactive CLI command and capture its public output. */
export function runCli(
  command: string,
  args: string[],
  timeoutMs = 5000,
): Promise<{ code: number | null; stdout: string; stderr?: string | undefined }> {
  const child = spawnCli(command, args)
  const captured = captureCli(child, timeoutMs, undefined, commandLabel(command))
  endStdin(child)
  return captured
}

/**
 * Send EOF to a command that gets no input. spawnCli opens stdin as a pipe, and
 * a CLI that reads it until EOF would otherwise wait for the time limit.
 */
function endStdin(child: ChildProcessWithoutNullStreams): void {
  // A child that exits or fails to start before reading leaves a broken pipe;
  // captureCli already reports that through the child's own events.
  child.stdin.on('error', () => undefined)
  child.stdin.end()
}

/**
 * Bound combined stdout/stderr before retaining bytes; settle only after owned cleanup.
 * stdin stays open: callers that send a request body write and end it themselves.
 */
export function captureCli(
  child: ChildProcessWithoutNullStreams,
  timeoutMs = 5000,
  maxBytes = 1024 * 1024,
  /** The command's name for the timeout message, such as `cursor-agent`. */
  label?: string,
): Promise<CapturedCli> {
  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    let bytes = 0
    let settled = false
    const finish = (result: CapturedCli | Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // Handlers keep draining pipes but cannot retain more output after failure.
      stdout = ''
      stderr = ''
      void killTree(child).then(() => {
        if (result instanceof Error) reject(result)
        else resolve(result)
      }, reject)
    }
    const timer = setTimeout(() => {
      finish(new Error(`${label ?? 'The CLI'} did not answer within ${timeLimit(timeoutMs)}.`))
    }, timeoutMs)
    const append = (chunk: string, stream: 'stdout' | 'stderr') => {
      if (settled) return
      const size = Buffer.byteLength(chunk)
      if (size > maxBytes - bytes) {
        finish(new Error('CLI output exceeded the size limit. Reduce command output and retry.'))
        return
      }
      bytes += size
      if (stream === 'stdout') stdout += chunk
      else stderr += chunk
    }
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => append(chunk, 'stdout'))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => append(chunk, 'stderr'))
    child.on('error', () =>
      finish(new Error('CLI could not start. Check the executable and permissions.')),
    )
    // Exit can precede the final bytes in inherited pipes.
    child.on('close', (code, signal) => finish({ code, signal, stdout, stderr }))
  })
}

/** `cursor-agent` for `C:\...\cursor-agent.cmd`: the name a user would type. */
function commandLabel(command: string): string {
  return path.basename(command).replace(/\.(?:cmd|bat|exe|com)$/i, '')
}

function timeLimit(ms: number): string {
  if (ms < 1000) return `${ms} ms`
  const seconds = Math.round(ms / 1000)
  return `${seconds} ${seconds === 1 ? 'second' : 'seconds'}`
}

export type CapturedCli = {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
}
