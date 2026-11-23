import { createHash, randomUUID } from 'node:crypto'
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { inflateRawSync } from 'node:zlib'
import type {
  SimulatorAndroidSdk,
  SimulatorAndroidSystemImage,
  SimulatorDeviceModelOption,
} from '@harness/contracts'
import { killTree, spawnCli } from '@harness/proc'

const ANDROID_REPOSITORY_BASE = 'https://dl.google.com/android/repository'
const ANDROID_REPOSITORY_MANIFEST = `${ANDROID_REPOSITORY_BASE}/repository2-3.xml`

const CMDLINE_DOWNLOAD_TIMEOUT_MS = 10 * 60_000
const SDKMANAGER_TIMEOUT_MS = 20 * 60_000
const AVD_CMD_TIMEOUT_MS = 60_000

export const ANDROID_SYSTEM_IMAGE_PATTERN =
  /^system-images;android-[A-Za-z0-9._-]+;[A-Za-z0-9._-]+;(arm64-v8a|x86_64|armeabi-v7a|x86)$/
export const ANDROID_AVD_NAME_PATTERN = /^[A-Za-z0-9._-]+$/

export type AndroidHostAbi = 'arm64-v8a' | 'x86_64'

export type CmdlineToolsArchive = {
  readonly url: string
  readonly sha1: string
  readonly size: number
}

export type JavaResolution = {
  readonly available: boolean
  readonly javaHome: string | null
  readonly reason?: string | undefined
}

export type AndroidCommandResult = {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

export function hostAndroidAbi(arch: string = process.arch): AndroidHostAbi {
  return arch === 'arm64' ? 'arm64-v8a' : 'x86_64'
}

export function defaultAndroidSdkRoot(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const explicit = env['ANDROID_HOME']?.trim() || env['ANDROID_SDK_ROOT']?.trim()
  if (explicit) return explicit
  const home = env['HOME'] ?? env['USERPROFILE'] ?? os.homedir()
  if (platform === 'darwin') return path.join(home, 'Library', 'Android', 'sdk')
  if (platform === 'win32') {
    return path.join(env['LOCALAPPDATA'] ?? path.join(home, 'AppData', 'Local'), 'Android', 'Sdk')
  }
  return path.join(home, 'Android', 'Sdk')
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath)
    return true
  } catch {
    return false
  }
}

export function sdkmanagerBinaryPath(
  sdkRoot: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return path.join(
    sdkRoot,
    'cmdline-tools',
    'latest',
    'bin',
    platform === 'win32' ? 'sdkmanager.bat' : 'sdkmanager',
  )
}

export function avdmanagerBinaryPath(
  sdkRoot: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return path.join(
    sdkRoot,
    'cmdline-tools',
    'latest',
    'bin',
    platform === 'win32' ? 'avdmanager.bat' : 'avdmanager',
  )
}

export function emulatorBinaryPath(
  sdkRoot: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return path.join(sdkRoot, 'emulator', platform === 'win32' ? 'emulator.exe' : 'emulator')
}

export function adbBinaryPath(
  sdkRoot: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return path.join(sdkRoot, 'platform-tools', platform === 'win32' ? 'adb.exe' : 'adb')
}

function runCommand(
  command: string,
  args: string[],
  options: {
    env: NodeJS.ProcessEnv
    timeoutMs?: number
    stdin?: string
    onOutputLine?: (line: string) => void
  },
): Promise<AndroidCommandResult> {
  const timeoutMs = options.timeoutMs ?? AVD_CMD_TIMEOUT_MS
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawnCli>
    try {
      child = spawnCli(command, args, { env: options.env })
    } catch (error) {
      resolve({
        code: 127,
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
      })
      return
    }
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let capturedBytes = 0
    const maxOutputBytes = 4 * 1024 * 1024
    let settled = false
    let pendingLine = ''

    const emitLines = (text: string) => {
      if (!options.onOutputLine) return
      const combined = pendingLine + text
      const lines = combined.split(/\r\n|\r|\n/)
      pendingLine = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (trimmed) options.onOutputLine(trimmed)
      }
    }

    const pushChunk = (target: Buffer[], chunk: Buffer) => {
      emitLines(chunk.toString('utf8'))
      if (capturedBytes >= maxOutputBytes) return
      const remaining = maxOutputBytes - capturedBytes
      const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk
      target.push(slice)
      capturedBytes += slice.length
    }

    child.stdout.on('data', (chunk: Buffer) => pushChunk(stdoutChunks, chunk))
    child.stderr.on('data', (chunk: Buffer) => pushChunk(stderrChunks, chunk))
    child.stdin.on('error', () => undefined)
    if (options.stdin !== undefined) {
      child.stdin.end(options.stdin, 'utf8')
    } else {
      child.stdin.end()
    }

    const finish = (code: number, fallbackStderr?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (pendingLine.trim()) options.onOutputLine?.(pendingLine.trim())
      resolve({
        code,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8') || (fallbackStderr ?? ''),
      })
    }

    const timer = setTimeout(() => {
      void killTree(child).finally(() => finish(124, `Command timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    child.once('error', (error: Error) => finish(127, error.message))
    child.once('close', (code) => finish(code ?? 1))
  })
}

async function isValidJavaHome(home: string, platform: NodeJS.Platform): Promise<boolean> {
  const binary = path.join(home, 'bin', platform === 'win32' ? 'java.exe' : 'java')
  return pathExists(binary)
}

export async function resolveJavaHome(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<JavaResolution> {
  const candidates: string[] = []
  const envHome = env['JAVA_HOME']?.trim()
  if (envHome) candidates.push(envHome)

  if (platform === 'darwin') {
    candidates.push(
      '/Applications/Android Studio.app/Contents/jbr/Contents/Home',
      '/opt/homebrew/opt/openjdk/libexec/openjdk.jdk/Contents/Home',
      '/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home',
      '/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home',
      '/usr/local/opt/openjdk/libexec/openjdk.jdk/Contents/Home',
      '/usr/local/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home',
      '/usr/local/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home',
    )
  } else if (platform === 'win32') {
    const programFiles = env['ProgramFiles'] ?? 'C:\\Program Files'
    const localAppData = env['LOCALAPPDATA'] ?? path.join(os.homedir(), 'AppData', 'Local')
    candidates.push(
      path.join(programFiles, 'Android', 'Android Studio', 'jbr'),
      path.join(localAppData, 'Programs', 'Android Studio', 'jbr'),
    )
  } else {
    candidates.push('/opt/android-studio/jbr', '/usr/lib/jvm/default-java')
  }

  for (const candidate of candidates) {
    if (await isValidJavaHome(candidate, platform)) {
      return { available: true, javaHome: candidate }
    }
  }

  if (platform === 'darwin') {
    const javaHomeRes = await runCommand('/usr/libexec/java_home', [], { env, timeoutMs: 5_000 })
    const home = javaHomeRes.stdout.trim()
    if (javaHomeRes.code === 0 && home && (await isValidJavaHome(home, platform))) {
      return { available: true, javaHome: home }
    }
  }

  // Check java directly on PATH and derive JAVA_HOME from its resolved binary path.
  const searchPath = env['PATH'] ?? env['Path'] ?? ''
  const javaBin = platform === 'win32' ? 'java.exe' : 'java'
  for (const dir of searchPath.split(platform === 'win32' ? ';' : ':')) {
    if (!dir) continue
    const candidate = path.join(dir, javaBin)
    if (!(await pathExists(candidate))) continue
    const resolved = await realpath(candidate).catch(() => candidate)
    const home = path.dirname(path.dirname(resolved))
    if (await isValidJavaHome(home, platform)) {
      // Avoid macOS `/usr/bin/java` stub which exits non-zero when no JDK is installed.
      if (platform === 'darwin' && home === '/usr') continue
      return { available: true, javaHome: home }
    }
  }

  return {
    available: false,
    javaHome: null,
    reason:
      platform === 'darwin'
        ? 'Java 17+ is required for Android SDK tools. Install OpenJDK (`brew install openjdk@21`) or Android Studio.'
        : 'Java 17+ is required for Android SDK tools. Install a JDK (17 or 21) or Android Studio.',
  }
}

export function buildAndroidEnv(
  baseEnv: NodeJS.ProcessEnv,
  sdkRoot: string | null,
  javaHome: string | null,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const delimiter = platform === 'win32' ? ';' : ':'
  const currentPath = baseEnv['PATH'] ?? baseEnv['Path'] ?? ''
  const extraPaths: string[] = []
  if (sdkRoot) {
    extraPaths.push(
      path.join(sdkRoot, 'platform-tools'),
      path.join(sdkRoot, 'emulator'),
      path.join(sdkRoot, 'cmdline-tools', 'latest', 'bin'),
    )
  }
  if (javaHome) {
    extraPaths.push(path.join(javaHome, 'bin'))
  }
  return {
    ...baseEnv,
    ...(sdkRoot ? { ANDROID_HOME: sdkRoot, ANDROID_SDK_ROOT: sdkRoot } : {}),
    ...(javaHome ? { JAVA_HOME: javaHome } : {}),
    ...(extraPaths.length > 0 ? { PATH: [...extraPaths, currentPath].join(delimiter) } : {}),
  }
}

function formatImageLabel(apiLevel: number, tag: string, abi: string): string {
  const tagLabel =
    tag === 'google_apis_playstore'
      ? 'Google Play'
      : tag === 'google_apis'
        ? 'Google APIs'
        : tag === 'default'
          ? 'AOSP'
          : tag.replaceAll('_', ' ')
  return `Android API ${apiLevel} · ${tagLabel} (${abi})`
}

export function recommendedAndroidSystemImage(arch: string = process.arch): string {
  return `system-images;android-35;google_apis_playstore;${hostAndroidAbi(arch)}`
}

export function curatedAndroidSystemImages(
  arch: string = process.arch,
): SimulatorAndroidSystemImage[] {
  const abi = hostAndroidAbi(arch)
  const entries: ReadonlyArray<{ readonly apiLevel: number; readonly tag: string }> = [
    { apiLevel: 36, tag: 'google_apis_playstore' },
    { apiLevel: 35, tag: 'google_apis_playstore' },
    { apiLevel: 35, tag: 'google_apis' },
    { apiLevel: 34, tag: 'google_apis_playstore' },
    { apiLevel: 34, tag: 'google_apis' },
  ]
  return entries.map(({ apiLevel, tag }) => ({
    packageId: `system-images;android-${apiLevel};${tag};${abi}`,
    label: formatImageLabel(apiLevel, tag, abi),
    apiLevel,
    tag,
    abi,
    installed: false,
  }))
}

export async function listAndroidSystemImages(
  sdkRoot: string | null,
  arch: string = process.arch,
): Promise<SimulatorAndroidSystemImage[]> {
  const byId = new Map<string, SimulatorAndroidSystemImage>()
  for (const item of curatedAndroidSystemImages(arch)) {
    byId.set(item.packageId, item)
  }

  if (sdkRoot) {
    const imagesDir = path.join(sdkRoot, 'system-images')
    const apiDirs = await readdir(imagesDir, { withFileTypes: true }).catch(() => [])
    for (const apiEntry of apiDirs) {
      if (!apiEntry.isDirectory() || !apiEntry.name.startsWith('android-')) continue
      const apiNumber = Number.parseInt(apiEntry.name.slice('android-'.length), 10)
      if (!Number.isFinite(apiNumber) || apiNumber <= 0) continue
      const tagDirs = await readdir(path.join(imagesDir, apiEntry.name), {
        withFileTypes: true,
      }).catch(() => [])
      for (const tagEntry of tagDirs) {
        if (!tagEntry.isDirectory()) continue
        const abiDirs = await readdir(path.join(imagesDir, apiEntry.name, tagEntry.name), {
          withFileTypes: true,
        }).catch(() => [])
        for (const abiEntry of abiDirs) {
          if (!abiEntry.isDirectory()) continue
          const propsPath = path.join(
            imagesDir,
            apiEntry.name,
            tagEntry.name,
            abiEntry.name,
            'source.properties',
          )
          if (!(await pathExists(propsPath))) continue
          const packageId = `system-images;${apiEntry.name};${tagEntry.name};${abiEntry.name}`
          byId.set(packageId, {
            packageId,
            label: formatImageLabel(apiNumber, tagEntry.name, abiEntry.name),
            apiLevel: apiNumber,
            tag: tagEntry.name,
            abi: abiEntry.name,
            installed: true,
          })
        }
      }
    }
  }

  return [...byId.values()].sort((left, right) => {
    if (left.installed !== right.installed) return left.installed ? -1 : 1
    if (left.apiLevel !== right.apiLevel) return right.apiLevel - left.apiLevel
    return left.label.localeCompare(right.label)
  })
}

export async function inspectAndroidSdkDetails(
  sdkRoot: string | null,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): Promise<SimulatorAndroidSdk> {
  const defaultRoot = defaultAndroidSdkRoot(env, platform)
  const [adb, emulator, cmdlineTools, java, systemImages] = await Promise.all([
    sdkRoot ? pathExists(adbBinaryPath(sdkRoot, platform)) : Promise.resolve(false),
    sdkRoot ? pathExists(emulatorBinaryPath(sdkRoot, platform)) : Promise.resolve(false),
    sdkRoot
      ? Promise.all([
          pathExists(sdkmanagerBinaryPath(sdkRoot, platform)),
          pathExists(avdmanagerBinaryPath(sdkRoot, platform)),
        ]).then(([s, a]) => s && a)
      : Promise.resolve(false),
    resolveJavaHome(env, platform),
    listAndroidSystemImages(sdkRoot, arch),
  ])
  return {
    root: sdkRoot,
    defaultRoot,
    adb,
    emulator,
    cmdlineTools,
    javaAvailable: java.available,
    javaPath: java.javaHome,
    ...(java.reason ? { javaReason: java.reason } : {}),
    hostAbi: hostAndroidAbi(arch),
    systemImages,
  }
}

export function parseCmdlineToolsArchive(
  xml: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): CmdlineToolsArchive {
  const pkgMatch = /<remotePackage[^>]*path="cmdline-tools;latest"[\s\S]*?<\/remotePackage>/i.exec(
    xml,
  )
  if (!pkgMatch) {
    throw new Error('Could not find cmdline-tools;latest in Google Android SDK repository XML.')
  }

  const expectedOs = platform === 'darwin' ? 'macosx' : platform === 'win32' ? 'windows' : 'linux'
  const expectedArch = arch === 'arm64' ? 'aarch64' : 'x64'

  const matches: Array<{
    readonly url: string
    readonly sha1: string
    readonly size: number
    readonly hostArch: string | null
  }> = []

  const archiveRe = /<archive>([\s\S]*?)<\/archive>/gi
  let entry = archiveRe.exec(pkgMatch[0])
  while (entry) {
    const block = entry[1] ?? ''
    const osMatch = /<host-os>([^<]+)<\/host-os>/i.exec(block)
    if (osMatch?.[1]?.trim().toLowerCase() === expectedOs) {
      const urlMatch = /<url>([^<]+)<\/url>/i.exec(block)
      const sha1Match = /<checksum[^>]*type="sha1"[^>]*>([^<]+)<\/checksum>/i.exec(block)
      const sizeMatch = /<size>(\d+)<\/size>/i.exec(block)
      const archMatch = /<host-arch>([^<]+)<\/host-arch>/i.exec(block)
      const rawUrl = urlMatch?.[1]?.trim()
      const sha1 = sha1Match?.[1]?.trim().toLowerCase()
      const size = sizeMatch?.[1] ? Number.parseInt(sizeMatch[1], 10) : 0
      if (rawUrl && sha1) {
        const url = /^https?:\/\//i.test(rawUrl) ? rawUrl : `${ANDROID_REPOSITORY_BASE}/${rawUrl}`
        matches.push({
          url,
          sha1,
          size,
          hostArch: archMatch?.[1]?.trim().toLowerCase() ?? null,
        })
      }
    }
    entry = archiveRe.exec(pkgMatch[0])
  }

  const chosen =
    matches.find((item) => item.hostArch === expectedArch) ??
    matches.find((item) => item.hostArch === null) ??
    matches[0]
  if (!chosen) {
    throw new Error(`No Android cmdline-tools archive found for ${expectedOs}/${expectedArch}.`)
  }
  return { url: chosen.url, sha1: chosen.sha1, size: chosen.size }
}

/**
 * Pure Node.js cross-platform ZIP extractor supporting stored (0) and deflated (8)
 * entries. Prevents Zip Slip traversal and restores Unix executable bits.
 */
export async function extractZipToDir(zipBuffer: Buffer, destDir: string): Promise<void> {
  // Locate End of Central Directory (EOCD) signature 0x06054b50 from end of buffer.
  const minEocd = Math.max(0, zipBuffer.length - 65_557)
  let eocdOffset = -1
  for (let offset = zipBuffer.length - 22; offset >= minEocd; offset--) {
    if (zipBuffer.readUInt32LE(offset) === 0x06054b50) {
      eocdOffset = offset
      break
    }
  }
  if (eocdOffset < 0) {
    throw new Error('Invalid ZIP archive: End of Central Directory not found.')
  }

  const totalEntries = zipBuffer.readUInt16LE(eocdOffset + 10)
  const cdOffset = zipBuffer.readUInt32LE(eocdOffset + 16)
  const resolvedDest = path.resolve(destDir)
  await mkdir(resolvedDest, { recursive: true })

  let cursor = cdOffset
  for (let index = 0; index < totalEntries; index++) {
    if (cursor + 46 > zipBuffer.length || zipBuffer.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error('Invalid ZIP archive: corrupt Central Directory entry.')
    }
    const method = zipBuffer.readUInt16LE(cursor + 10)
    const compressedSize = zipBuffer.readUInt32LE(cursor + 20)
    const nameLen = zipBuffer.readUInt16LE(cursor + 28)
    const extraLen = zipBuffer.readUInt16LE(cursor + 30)
    const commentLen = zipBuffer.readUInt16LE(cursor + 32)
    const externalAttr = zipBuffer.readUInt32LE(cursor + 38)
    const localHeaderOffset = zipBuffer.readUInt32LE(cursor + 42)
    const entryName = zipBuffer.toString('utf8', cursor + 46, cursor + 46 + nameLen)
    cursor += 46 + nameLen + extraLen + commentLen

    // Reject path traversal or absolute paths before touching disk.
    const normalized = entryName.replaceAll('\\', '/')
    if (
      !normalized ||
      normalized.startsWith('/') ||
      /^[A-Za-z]:/.test(normalized) ||
      normalized.split('/').some((part) => part === '..')
    ) {
      throw new Error(`Refusing unsafe ZIP entry path: ${entryName}`)
    }

    const targetPath = path.resolve(resolvedDest, normalized)
    if (targetPath !== resolvedDest && !targetPath.startsWith(`${resolvedDest}${path.sep}`)) {
      throw new Error(`Refusing ZIP entry outside destination: ${entryName}`)
    }

    if (normalized.endsWith('/')) {
      await mkdir(targetPath, { recursive: true })
      continue
    }

    if (
      localHeaderOffset + 30 > zipBuffer.length ||
      zipBuffer.readUInt32LE(localHeaderOffset) !== 0x04034b50
    ) {
      throw new Error(`Invalid ZIP local header for ${entryName}.`)
    }
    const localNameLen = zipBuffer.readUInt16LE(localHeaderOffset + 26)
    const localExtraLen = zipBuffer.readUInt16LE(localHeaderOffset + 28)
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen
    const compressed = zipBuffer.subarray(dataStart, dataStart + compressedSize)

    let data: Buffer
    if (method === 0) {
      data = compressed
    } else if (method === 8) {
      data = inflateRawSync(compressed)
    } else {
      throw new Error(`Unsupported ZIP compression method ${method} for ${entryName}.`)
    }

    await mkdir(path.dirname(targetPath), { recursive: true })
    await writeFile(targetPath, data)
    const unixMode = (externalAttr >>> 16) & 0o777
    if (process.platform !== 'win32' && unixMode !== 0) {
      await chmod(targetPath, unixMode).catch(() => undefined)
    }
  }
}

export async function installAndroidCmdlineTools(
  sdkRoot: string,
  options: {
    readonly platform?: NodeJS.Platform
    readonly arch?: string
    readonly onProgress?: (detail: string) => void
  } = {},
): Promise<void> {
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  options.onProgress?.('Fetching Android SDK Command-line Tools manifest…')
  const manifestRes = await fetch(ANDROID_REPOSITORY_MANIFEST, {
    signal: AbortSignal.timeout(30_000),
  })
  if (!manifestRes.ok) {
    throw new Error(`Could not fetch Android SDK repository manifest (HTTP ${manifestRes.status}).`)
  }
  const archive = parseCmdlineToolsArchive(await manifestRes.text(), platform, arch)

  options.onProgress?.('Downloading Android SDK Command-line Tools…')
  const downloadRes = await fetch(archive.url, {
    signal: AbortSignal.timeout(CMDLINE_DOWNLOAD_TIMEOUT_MS),
  })
  if (!downloadRes.ok) {
    throw new Error(`Could not download Android Command-line Tools (HTTP ${downloadRes.status}).`)
  }
  const zipBuffer = Buffer.from(await downloadRes.arrayBuffer())
  const actualSha1 = createHash('sha1').update(zipBuffer).digest('hex').toLowerCase()
  if (actualSha1 !== archive.sha1) {
    throw new Error(
      `Android Command-line Tools checksum mismatch (expected ${archive.sha1}, got ${actualSha1}).`,
    )
  }

  options.onProgress?.('Extracting Android SDK Command-line Tools…')
  const cmdlineDir = path.join(sdkRoot, 'cmdline-tools')
  const stagingDir = path.join(cmdlineDir, `.staging-${randomUUID()}`)
  const latestDir = path.join(cmdlineDir, 'latest')
  await mkdir(cmdlineDir, { recursive: true })

  try {
    await extractZipToDir(zipBuffer, stagingDir)
    const nested = path.join(stagingDir, 'cmdline-tools')
    const sourceDir = (await pathExists(nested)) ? nested : stagingDir
    // Ensure bin scripts are executable on POSIX even if ZIP lacked mode bits.
    if (platform !== 'win32') {
      const binDir = path.join(sourceDir, 'bin')
      const bins = await readdir(binDir).catch(() => [])
      for (const file of bins) {
        await chmod(path.join(binDir, file), 0o755).catch(() => undefined)
      }
    }
    const backupDir = path.join(cmdlineDir, `.backup-${randomUUID()}`)
    const hadLatest = await pathExists(latestDir)
    if (hadLatest) await rename(latestDir, backupDir)
    try {
      await rename(sourceDir, latestDir)
    } catch (error) {
      if (hadLatest) await rename(backupDir, latestDir).catch(() => undefined)
      throw error
    }
    if (hadLatest) await rm(backupDir, { recursive: true, force: true }).catch(() => undefined)
  } finally {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

export async function runSdkManager(
  sdkRoot: string,
  args: string[],
  options: {
    readonly env: NodeJS.ProcessEnv
    readonly platform?: NodeJS.Platform
    readonly stdin?: string
    readonly timeoutMs?: number
    readonly onOutputLine?: (line: string) => void
  },
): Promise<AndroidCommandResult> {
  const platform = options.platform ?? process.platform
  const binary = sdkmanagerBinaryPath(sdkRoot, platform)
  if (!(await pathExists(binary))) {
    throw new Error(`Android sdkmanager was not found at ${binary}.`)
  }
  return runCommand(binary, [`--sdk_root=${sdkRoot}`, ...args], {
    env: options.env,
    timeoutMs: options.timeoutMs ?? SDKMANAGER_TIMEOUT_MS,
    ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
    ...(options.onOutputLine ? { onOutputLine: options.onOutputLine } : {}),
  })
}

export async function acceptAndroidSdkLicenses(
  sdkRoot: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  const result = await runSdkManager(sdkRoot, ['--licenses'], {
    env,
    platform,
    stdin: 'y\n'.repeat(60),
    timeoutMs: 60_000,
  })
  // sdkmanager --licenses returns 0 once all licenses are accepted.
  if (result.code !== 0 && !result.stdout.includes('All SDK package licenses accepted')) {
    const detail = result.stderr.trim() || result.stdout.trim()
    throw new Error(
      `Could not accept Android SDK licenses (exit ${result.code})${detail ? `: ${detail.slice(-300)}` : ''}`,
    )
  }
}

export async function installAndroidPackages(input: {
  readonly sdkRoot: string
  readonly packages: readonly string[]
  readonly env: NodeJS.ProcessEnv
  readonly platform?: NodeJS.Platform
  readonly onProgress?: (detail: string) => void
}): Promise<void> {
  if (input.packages.length === 0) return
  const platform = input.platform ?? process.platform
  input.onProgress?.(`Installing ${input.packages.join(', ')}…`)
  const result = await runSdkManager(input.sdkRoot, [...input.packages], {
    env: input.env,
    platform,
    stdin: 'y\n'.repeat(20),
    timeoutMs: SDKMANAGER_TIMEOUT_MS,
    onOutputLine: (line) => {
      if (/%|Downloading|Unzipping|Installing/i.test(line)) {
        input.onProgress?.(line.slice(0, 140))
      }
    },
  })
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim()
    throw new Error(
      `Android SDK install failed (exit ${result.code})${detail ? `: ${detail.slice(-400)}` : ''}`,
    )
  }
}

export async function uninstallAndroidSystemImage(input: {
  readonly sdkRoot: string
  readonly packageId: string
  readonly env: NodeJS.ProcessEnv
  readonly platform?: NodeJS.Platform
}): Promise<void> {
  if (!ANDROID_SYSTEM_IMAGE_PATTERN.test(input.packageId)) {
    throw new Error(`Invalid Android system image package "${input.packageId}".`)
  }
  const platform = input.platform ?? process.platform
  const binary = sdkmanagerBinaryPath(input.sdkRoot, platform)
  if (await pathExists(binary)) {
    const result = await runSdkManager(input.sdkRoot, ['--uninstall', input.packageId], {
      env: input.env,
      platform,
      timeoutMs: 120_000,
    })
    if (result.code === 0) return
  }
  // Safe direct directory fallback restricted strictly to the validated 4-segment system-images path.
  const [, apiDir, tagDir, abiDir] = input.packageId.split(';')
  if (!apiDir || !tagDir || !abiDir) return
  const imageDir = path.join(input.sdkRoot, 'system-images', apiDir, tagDir, abiDir)
  await rm(imageDir, { recursive: true, force: true })
}

export function parseAvdDeviceProfiles(stdout: string): SimulatorDeviceModelOption[] {
  const profiles: SimulatorDeviceModelOption[] = []
  let currentId: string | undefined
  let currentName: string | undefined

  const flush = () => {
    if (!currentId) return
    const label = currentName || currentId
    const lower = `${currentId} ${label}`.toLowerCase()
    const isWatchOrTvOrAuto =
      lower.includes('wear') ||
      lower.includes('tv_') ||
      lower.includes('android tv') ||
      lower.includes('automotive') ||
      lower.includes('desktop') ||
      lower.includes('xr')
    if (!isWatchOrTvOrAuto) {
      profiles.push({ value: currentId, label, supported: true })
    }
    currentId = undefined
    currentName = undefined
  }

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.startsWith('---')) {
      flush()
      continue
    }
    const idMatch = /^id:\s*\d+\s+or\s+"([^"]+)"/.exec(line)
    if (idMatch?.[1]) {
      flush()
      currentId = idMatch[1].trim()
      continue
    }
    const nameMatch = /^Name:\s*(.+)$/.exec(line)
    if (nameMatch?.[1]) {
      currentName = nameMatch[1].trim()
    }
  }
  flush()

  // Sort popular Pixel and generic phone profiles to the top.
  const rank = (option: SimulatorDeviceModelOption): number => {
    const id = option.value.toLowerCase()
    if (id === 'pixel_9_pro' || id === 'pixel_9') return 0
    if (id.startsWith('pixel_9')) return 1
    if (id.startsWith('pixel_8')) return 2
    if (id.startsWith('pixel_7')) return 3
    if (id.startsWith('pixel_fold') || id.startsWith('pixel_tablet')) return 4
    if (id.startsWith('pixel_')) return 5
    if (id === 'medium_phone' || id === 'medium_tablet') return 6
    return 10
  }

  return profiles.sort((left, right) => {
    const diff = rank(left) - rank(right)
    if (diff !== 0) return diff
    return left.label.localeCompare(right.label, undefined, { numeric: true })
  })
}

export async function listAndroidDeviceProfiles(
  sdkRoot: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): Promise<SimulatorDeviceModelOption[]> {
  const binary = avdmanagerBinaryPath(sdkRoot, platform)
  if (await pathExists(binary)) {
    const result = await runCommand(binary, ['list', 'device'], { env, timeoutMs: 20_000 })
    if (result.code === 0) {
      const parsed = parseAvdDeviceProfiles(result.stdout)
      if (parsed.length > 0) return parsed
    }
  }
  return [
    { value: 'pixel_9', label: 'Pixel 9', supported: true },
    { value: 'pixel_8', label: 'Pixel 8', supported: true },
    { value: 'medium_phone', label: 'Medium Phone', supported: true },
    { value: 'medium_tablet', label: 'Medium Tablet', supported: true },
  ]
}

export function sanitizeAvdName(raw: string): string {
  const cleaned = raw
    .trim()
    .replaceAll(/\s+/g, '_')
    .replaceAll(/[^A-Za-z0-9._-]/g, '_')
    .replaceAll(/_+/g, '_')
    .replace(/^[^A-Za-z0-9]+/, '')
  return cleaned || 'Android_Emulator'
}

export function avdHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env['ANDROID_AVD_HOME']?.trim()
  if (explicit) return explicit
  const androidUserHome = env['ANDROID_USER_HOME']?.trim()
  if (androidUserHome) return path.join(androidUserHome, 'avd')
  const home = env['HOME'] ?? env['USERPROFILE'] ?? os.homedir()
  return path.join(home, '.android', 'avd')
}

export async function createAndroidAvd(input: {
  readonly sdkRoot: string
  readonly name: string
  readonly packageId: string
  readonly deviceProfile: string
  readonly env: NodeJS.ProcessEnv
  readonly platform?: NodeJS.Platform
}): Promise<string> {
  const name = sanitizeAvdName(input.name)
  if (!ANDROID_AVD_NAME_PATTERN.test(name)) {
    throw new Error(`Invalid Android emulator name "${input.name}".`)
  }
  if (!ANDROID_SYSTEM_IMAGE_PATTERN.test(input.packageId)) {
    throw new Error(`Invalid Android system image "${input.packageId}".`)
  }
  const platform = input.platform ?? process.platform
  const binary = avdmanagerBinaryPath(input.sdkRoot, platform)
  if (!(await pathExists(binary))) {
    throw new Error('Android SDK Command-line Tools are not installed. Install them first.')
  }

  const args = [
    'create',
    'avd',
    '--force',
    '-n',
    name,
    '-k',
    input.packageId,
    ...(input.deviceProfile.trim() ? ['-d', input.deviceProfile.trim()] : []),
  ]
  const result = await runCommand(binary, args, {
    env: input.env,
    stdin: 'no\n',
    timeoutMs: AVD_CMD_TIMEOUT_MS,
  })
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim()
    throw new Error(
      `Could not create Android emulator "${name}" (exit ${result.code})${detail ? `: ${detail.slice(-300)}` : ''}`,
    )
  }

  // Enable host keyboard & hardware GPU acceleration so typing and streaming work reliably.
  const configPath = path.join(avdHomeDir(input.env), `${name}.avd`, 'config.ini')
  if (await pathExists(configPath)) {
    const existing = await readFile(configPath, 'utf8')
    const lines = existing.split(/\r?\n/)
    const setKey = (key: string, value: string) => {
      const prefix = `${key}=`
      const idx = lines.findIndex((line) => line.startsWith(prefix))
      if (idx >= 0) lines[idx] = `${prefix}${value}`
      else lines.push(`${prefix}${value}`)
    }
    setKey('hw.keyboard', 'yes')
    setKey('hw.gpu.enabled', 'yes')
    setKey('hw.gpu.mode', 'auto')
    await writeFile(configPath, `${lines.filter(Boolean).join('\n')}\n`, 'utf8')
  }

  return name
}

export async function deleteAndroidAvd(input: {
  readonly sdkRoot: string | null
  readonly name: string
  readonly env: NodeJS.ProcessEnv
  readonly platform?: NodeJS.Platform
}): Promise<void> {
  const name = input.name.trim()
  if (!ANDROID_AVD_NAME_PATTERN.test(name)) {
    throw new Error(`Invalid Android emulator name "${input.name}".`)
  }
  const platform = input.platform ?? process.platform
  if (input.sdkRoot) {
    const binary = avdmanagerBinaryPath(input.sdkRoot, platform)
    if (await pathExists(binary)) {
      await runCommand(binary, ['delete', 'avd', '-n', name], {
        env: input.env,
        timeoutMs: AVD_CMD_TIMEOUT_MS,
      })
    }
  }
  // Ensure AVD directory and descriptor are cleanly removed even if avdmanager wasn't installed.
  const dir = avdHomeDir(input.env)
  await Promise.all([
    rm(path.join(dir, `${name}.avd`), { recursive: true, force: true }).catch(() => undefined),
    rm(path.join(dir, `${name}.ini`), { force: true }).catch(() => undefined),
  ])
}
