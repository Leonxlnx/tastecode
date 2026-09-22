import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  createReadStream,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { acceptanceLaunchEnvironment } from './linux-acceptance-environment.js'

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const releaseDirectory = path.join(workspaceRoot, 'release')

export const ACCEPTANCE_VALIDATION_SCRIPTS = ['lint', 'typecheck', 'test']
export const ACCEPTANCE_PREPARATION_ARGS = ['--filter', '@harness/desktop', 'dist:linux']

/**
 * Highest versioned-symbol tag (e.g. `GLIBC_2.28`) in `objdump -T` output.
 * Returns undefined when the binary carries no tags with that prefix.
 */
export function maxSymbolVersion(objdumpOutput, prefix) {
  let highest
  for (const match of objdumpOutput.matchAll(new RegExp(`${prefix}_([0-9.]+)`, 'g'))) {
    const version = match[1]
    if (highest === undefined || compareDottedVersions(version, highest) > 0) {
      highest = version
    }
  }
  return highest
}

export function compareDottedVersions(left, right) {
  const a = left.split('.').map(Number)
  const b = right.split('.').map(Number)
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0)
    if (delta !== 0) return delta
  }
  return 0
}

/**
 * The declared glibc floor from deb depends entries like `libc6 (>= 2.31)`.
 * Returns undefined when no libc6 constraint is declared.
 */
export function declaredLibcFloor(depends) {
  for (const dependency of depends ?? []) {
    const match = /^libc6\s*\(>=\s*([0-9.]+)\)\s*$/.exec(dependency)
    if (match) return match[1]
  }
  return undefined
}

// Every shipped ELF binary a loader resolves at runtime: the Electron
// executable and its bundled shared libraries plus native Node addons. A
// symbol newer than the declared libc6 floor would silently break install on
// older distributions, so the floor is measured rather than assumed. Exported
// for the packaging proof, which applies the same gate to CI-built artifacts.
export function nativeBinaryCandidates(unpackedDirectory, executableName) {
  const candidates = [path.join(unpackedDirectory, executableName)]
  const walk = (directory) => {
    let entries
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(directory, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.(?:node|so(?:\.\d+)*)$/.test(entry.name)) candidates.push(full)
    }
  }
  walk(unpackedDirectory)
  candidates.push(path.join(unpackedDirectory, 'chrome-sandbox'))
  candidates.push(path.join(unpackedDirectory, 'chrome_crashpad_handler'))
  return candidates.filter((candidate) => statSync(candidate, { throwIfNoEntry: false })?.isFile())
}

/**
 * Measure the highest GLIBC symbol version in every shipped ELF binary and
 * throw when one needs more than the deb's declared libc6 floor. objdump must
 * be on PATH — binutils is preinstalled on the qualified Linux hosts and
 * runners. Returns the measured floor per binary for the acceptance report.
 */
export function assertGlibcFloor(unpackedDirectory, executableName, libcFloor, tag) {
  const floors = {}
  for (const binary of nativeBinaryCandidates(unpackedDirectory, executableName)) {
    // The Electron binary's dynamic symbol table alone is several megabytes.
    const symbols = execFileSync('objdump', ['-T', binary], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
    const measured = maxSymbolVersion(symbols, 'GLIBC')
    if (measured === undefined) continue
    const relative = path.relative(unpackedDirectory, binary)
    floors[relative] = measured
    if (compareDottedVersions(measured, libcFloor) > 0) {
      throw new Error(
        `${tag} ${relative} requires GLIBC_${measured}, ` +
          `above the declared deb floor libc6 (>= ${libcFloor})`,
      )
    }
  }
  return floors
}

function block(message) {
  process.stderr.write(`[linux-acceptance] environment blocked: ${message}\n`)
  process.exit(2)
}

function fail(message) {
  throw new Error(`[linux-acceptance] ${message}`)
}

// A missing tool is an environment blocker (exit 2), not a product failure.
function probe(commandName, args) {
  try {
    return command(commandName, args)
  } catch {
    block(`${commandName} is required on PATH`)
  }
}

function command(commandName, args, options = {}) {
  return execFileSync(commandName, args, {
    cwd: workspaceRoot,
    encoding: 'utf8',
    ...options,
  }).trim()
}

function run(commandName, args) {
  process.stdout.write(`\n[linux-acceptance] ${commandName} ${args.join(' ')}\n`)
  const result = spawnSync(commandName, args, {
    cwd: workspaceRoot,
    env: process.env,
    stdio: 'inherit',
  })
  if (result.error) throw result.error
  if (result.signal) fail(`${commandName} ended with signal ${result.signal}`)
  if (result.status !== 0) fail(`${commandName} exited with status ${result.status ?? 'unknown'}`)
}

async function sha256(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

async function main() {
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    block(`requires Linux x64, received ${process.platform} ${process.arch}`)
  }
  if (process.env['XDG_SESSION_TYPE'] !== 'wayland' || !process.env['WAYLAND_DISPLAY']) {
    block('run from a native Wayland desktop session')
  }
  if (!process.env['DBUS_SESSION_BUS_ADDRESS']) {
    block('a user D-Bus session is required for the credential proof')
  }
  const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number)
  if (nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 18)) block('Node >=22.18.0 is required')
  const expectedPnpm = JSON.parse(
    readFileSync(path.join(workspaceRoot, 'package.json'), 'utf8'),
  ).packageManager?.replace(/^pnpm@/, '')
  if (!expectedPnpm) fail('root package.json must declare a pinned packageManager pnpm@<version>')
  const pnpmVersion = probe('pnpm', ['--version'])
  if (pnpmVersion !== expectedPnpm) {
    block(`pnpm ${expectedPnpm} is required, received ${pnpmVersion}`)
  }
  if (probe('git', ['status', '--porcelain'])) block('commit or stash changes before acceptance')

  let osRelease
  try {
    osRelease = readFileSync('/etc/os-release', 'utf8')
  } catch {
    block('/etc/os-release is required to identify the distribution')
  }
  const distribution = /^(?:ID)=(?:"?)([^"\n]+)/m.exec(osRelease)?.[1] ?? 'unknown'
  const distributionVersion = /^(?:VERSION_ID)=(?:"?)([^"\n]+)/m.exec(osRelease)?.[1] ?? 'unknown'
  if (!['pop', 'ubuntu'].includes(distribution) || distributionVersion !== '24.04') {
    block(
      `qualified environments are Pop!_OS or Ubuntu 24.04, received ${distribution} ${distributionVersion}`,
    )
  }
  const desktop = process.env['XDG_CURRENT_DESKTOP'] ?? 'unknown'
  if (!/(?:cosmic|gnome)/i.test(desktop)) block(`requires COSMIC or GNOME, received ${desktop}`)

  const identity = {
    commit: command('git', ['rev-parse', 'HEAD']),
    branch: command('git', ['branch', '--show-current']),
    distribution,
    distributionVersion,
    desktop,
    session: process.env['XDG_SESSION_TYPE'],
    kernel: probe('uname', ['-a']),
    glibc: probe('getconf', ['GNU_LIBC_VERSION']),
    node: process.version,
    pnpm: pnpmVersion,
  }
  process.stdout.write(`[linux-acceptance] ${JSON.stringify(identity)}\n`)

  run('pnpm', ['install', '--frozen-lockfile'])
  for (const script of ACCEPTANCE_VALIDATION_SCRIPTS) run('pnpm', [script])
  run('pnpm', ACCEPTANCE_PREPARATION_ARGS)

  const unpackedDirectory = path.join(releaseDirectory, '.linux-package', 'linux-unpacked')
  const desktopPackage = JSON.parse(
    readFileSync(path.join(workspaceRoot, 'apps/desktop/package.json'), 'utf8'),
  )
  const executableName = desktopPackage.build?.linux?.executableName
  if (typeof executableName !== 'string') {
    fail('apps/desktop/package.json must define build.linux.executableName')
  }
  const executable = path.join(unpackedDirectory, executableName)
  const executableStat = statSync(executable, { throwIfNoEntry: false })
  if (!executableStat?.isFile()) {
    fail(`configured Linux app executable is missing from linux-unpacked: ${executableName}`)
  }
  if ((executableStat.mode & 0o111) === 0) {
    fail(`configured Linux app executable is not executable: ${executableName}`)
  }
  const resources = path.join(unpackedDirectory, 'resources')
  const unpackedDir = statSync(path.join(resources, 'app.asar.unpacked'), {
    throwIfNoEntry: false,
  })
  if (!unpackedDir?.isDirectory()) fail('missing packaged app.asar.unpacked/')
  for (const relativePath of [
    'app.asar',
    'LICENSE',
    'NOTICE',
    'THIRD_PARTY_LICENSES.txt',
    'licenses/npm/napi-keyring-linux-x64-gnu-1.3.0-MIT.txt',
  ]) {
    const resource = statSync(path.join(resources, relativePath), { throwIfNoEntry: false })
    if (!resource?.isFile()) fail(`missing packaged ${relativePath}`)
  }

  // Measure the true glibc floor of every shipped ELF binary and refuse to
  // qualify a package that needs more than the deb declares.
  probe('objdump', ['--version'])
  const libcFloor = declaredLibcFloor(desktopPackage.build?.deb?.depends)
  if (libcFloor === undefined) {
    fail('apps/desktop deb depends must declare a libc6 (>= <version>) floor')
  }
  const glibcFloorByBinary = assertGlibcFloor(
    unpackedDirectory,
    executableName,
    libcFloor,
    '[linux-acceptance]',
  )
  run('pnpm', ['--filter', '@harness/desktop', 'verify:native-bindings', '--', executable])
  run('pnpm', [
    '--filter',
    '@harness/desktop',
    'verify:native-bindings',
    '--',
    '--utility',
    executable,
  ])

  const profile = mkdtempSync(path.join(os.tmpdir(), 'tastecode-linux-acceptance-'))
  const launchEnvironment = acceptanceLaunchEnvironment(profile)
  for (const directory of Object.values(launchEnvironment)) mkdirSync(directory)
  const xdg = Object.fromEntries(
    Object.entries(launchEnvironment).filter(([name]) => name.startsWith('XDG_')),
  )
  const releaseEvidencePath = path.join(
    releaseDirectory,
    'linux-x64',
    'linux-release-evidence.json',
  )
  const releaseEvidence = JSON.parse(readFileSync(releaseEvidencePath, 'utf8'))
  // Cross-check the embedded evidence against values measured in this run —
  // a commit landing between the prepare step and here would otherwise leave
  // the report silently carrying two different commits.
  if (releaseEvidence.commit !== identity.commit) {
    fail(
      `release evidence commit ${releaseEvidence.commit ?? 'missing'} does not match ` +
        `HEAD ${identity.commit}; regenerate evidence for this checkout`,
    )
  }
  if (releaseEvidence.version !== desktopPackage.version) {
    fail(
      `release evidence version ${releaseEvidence.version ?? 'missing'} does not match ` +
        `apps/desktop version ${desktopPackage.version}`,
    )
  }
  for (const artifact of releaseEvidence.artifacts ?? []) {
    const artifactPath = path.join(releaseDirectory, 'linux-x64', artifact.file)
    const measured = statSync(artifactPath, { throwIfNoEntry: false })?.isFile()
      ? await sha256(artifactPath)
      : undefined
    if (measured === undefined) {
      fail(`release artifact named by evidence is missing: ${artifact.file}`)
    }
    if (measured !== artifact.sha256) {
      fail(`release artifact bytes changed after evidence was recorded: ${artifact.file}`)
    }
  }
  const report = {
    status: 'awaiting-manual-desktop-acceptance',
    createdAt: new Date().toISOString(),
    ...identity,
    executable,
    appAsarSha256: await sha256(path.join(resources, 'app.asar')),
    libcFloor,
    glibcFloorByBinary,
    releaseEvidence: {
      artifacts: releaseEvidence.artifacts,
      commit: releaseEvidence.commit,
      updateMode: releaseEvidence.updateMode,
      version: releaseEvidence.version,
    },
    xdg,
    harnessConfigDirectory: launchEnvironment.HARNESS_CONFIG_DIR,
  }
  mkdirSync(releaseDirectory, { recursive: true })
  const reportPath = path.join(releaseDirectory, 'linux-acceptance.json')
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })

  process.stdout.write(`\n[linux-acceptance] automated gates passed: ${reportPath}\n`)
  process.stdout.write(
    `[linux-acceptance] launch: ${Object.entries(launchEnvironment)
      .map(([name, value]) => `${name}=${value}`)
      .join(' ')} ${JSON.stringify(executable)}\n`,
  )
  process.stdout.write(
    '[linux-acceptance] now run the packaged Wayland checklist in Architecture\n',
  )
}

const isEntryPoint =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href

if (isEntryPoint) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
