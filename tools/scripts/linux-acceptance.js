import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { packagedExecutable } from './linux-acceptance-executable.js'

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const releaseDirectory = path.join(workspaceRoot, 'release')

function block(message) {
  process.stderr.write(`[linux-acceptance] environment blocked: ${message}\n`)
  process.exit(2)
}

function fail(message) {
  throw new Error(`[linux-acceptance] ${message}`)
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
if (command('pnpm', ['--version']) !== '11.8.0') block('pnpm 11.8.0 is required')
if (command('git', ['status', '--porcelain'])) block('commit or stash changes before acceptance')

const osRelease = readFileSync('/etc/os-release', 'utf8')
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
  kernel: command('uname', ['-a']),
  glibc: command('getconf', ['GNU_LIBC_VERSION']),
  node: process.version,
  pnpm: '11.8.0',
}
process.stdout.write(`[linux-acceptance] ${JSON.stringify(identity)}\n`)

run('pnpm', ['install', '--frozen-lockfile'])
for (const script of ['lint', 'typecheck', 'test', 'build']) run('pnpm', [script])
run('pnpm', ['--filter', '@harness/desktop', 'dist:linux:dir'])

const unpackedDirectory = path.join(releaseDirectory, 'linux-unpacked')
const executable = packagedExecutable(unpackedDirectory)
const resources = path.join(unpackedDirectory, 'resources')
for (const relativePath of [
  'app.asar',
  'app.asar.unpacked',
  'LICENSE',
  'NOTICE',
  'THIRD_PARTY_LICENSES.txt',
  'licenses/npm/napi-keyring-linux-x64-gnu-1.3.0-MIT.txt',
]) {
  if (!existsSync(path.join(resources, relativePath))) fail(`missing packaged ${relativePath}`)
}
run('pnpm', ['--filter', '@harness/desktop', 'verify:native-bindings', '--', executable])

const profile = mkdtempSync(path.join(os.tmpdir(), 'tastecode-linux-acceptance-'))
for (const name of ['config', 'data', 'state', 'cache']) mkdirSync(path.join(profile, name))
const xdg = {
  XDG_CONFIG_HOME: path.join(profile, 'config'),
  XDG_DATA_HOME: path.join(profile, 'data'),
  XDG_STATE_HOME: path.join(profile, 'state'),
  XDG_CACHE_HOME: path.join(profile, 'cache'),
}
const report = {
  status: 'awaiting-manual-desktop-acceptance',
  createdAt: new Date().toISOString(),
  ...identity,
  executable,
  appAsarSha256: await sha256(path.join(resources, 'app.asar')),
  xdg,
}
mkdirSync(releaseDirectory, { recursive: true })
const reportPath = path.join(releaseDirectory, 'linux-acceptance.json')
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })

process.stdout.write(`\n[linux-acceptance] automated gates passed: ${reportPath}\n`)
process.stdout.write(
  `[linux-acceptance] launch: ${Object.entries(xdg)
    .map(([name, value]) => `${name}=${value}`)
    .join(' ')} ${JSON.stringify(executable)}\n`,
)
process.stdout.write('[linux-acceptance] now run the packaged Wayland checklist in Architecture\n')
