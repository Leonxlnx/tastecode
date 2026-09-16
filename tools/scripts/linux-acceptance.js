import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  createReadStream,
  mkdirSync,
  mkdtempSync,
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
  for (const relativePath of [
    'app.asar',
    'app.asar.unpacked',
    'LICENSE',
    'NOTICE',
    'THIRD_PARTY_LICENSES.txt',
    'licenses/npm/napi-keyring-linux-x64-gnu-1.3.0-MIT.txt',
  ]) {
    const resource = statSync(path.join(resources, relativePath), { throwIfNoEntry: false })
    if (!resource?.isFile()) fail(`missing packaged ${relativePath}`)
  }
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
