import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

function packagedPaths(argument) {
  const supplied = path.resolve(argument)
  if (process.platform === 'win32' || process.platform === 'linux') {
    return {
      executable: supplied,
      resources: path.join(path.dirname(supplied), 'resources'),
    }
  }
  if (process.platform === 'darwin') {
    const app = supplied.endsWith('.app')
      ? supplied
      : path.resolve(path.dirname(supplied), '..', '..')
    const executable = supplied.endsWith('.app')
      ? singleMacExecutable(path.join(app, 'Contents', 'MacOS'))
      : supplied
    return {
      executable,
      resources: path.join(app, 'Contents', 'Resources'),
    }
  }
  throw new Error('packaged native proof is supported only on Windows, macOS, and Linux')
}

function singleMacExecutable(directory) {
  const candidates = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(directory, entry.name))
  if (candidates.length !== 1) {
    throw new Error(
      `expected one packaged macOS executable in ${directory}, found ${candidates.length}`,
    )
  }
  return candidates[0]
}

// Proves bindings through the shipped launcher instead of ELECTRON_RUN_AS_NODE: a temp
// "farm" re-creates the package layout with resources/app/ (Electron's fallback when
// app.asar is absent) whose main uses utilityProcess.fork on the real proof entry.
function runUtilityLauncherProof(executable, resources) {
  if (process.platform === 'darwin') {
    throw new Error('utility launcher proof is not supported on macOS yet')
  }
  const archive = path.join(resources, 'app.asar')
  const proofEntry = path.join(archive, 'dist', 'native-binding-proof.js')
  const farm = mkdtempSync(path.join(os.tmpdir(), 'tastecode-utility-proof-'))
  const linkOrCopy = (source, target) => {
    try {
      symlinkSync(source, target)
    } catch {
      cpSync(source, target, { recursive: true })
    }
  }
  try {
    const farmExe = path.join(farm, path.basename(executable))
    const unpackedRoot = path.dirname(executable)
    for (const entry of readdirSync(unpackedRoot, { withFileTypes: true })) {
      if (entry.name === 'resources' || entry.name === path.basename(executable)) continue
      linkOrCopy(path.join(unpackedRoot, entry.name), path.join(farm, entry.name))
    }
    copyFileSync(executable, farmExe)
    chmodSync(farmExe, 0o755)
    const farmResources = path.join(farm, 'resources')
    mkdirSync(farmResources)
    for (const entry of readdirSync(resources, { withFileTypes: true })) {
      if (entry.name === 'app.asar') continue
      linkOrCopy(path.join(resources, entry.name), path.join(farmResources, entry.name))
    }
    const farmApp = path.join(farmResources, 'app')
    mkdirSync(farmApp)
    writeFileSync(
      path.join(farmApp, 'package.json'),
      '{"name":"tastecode-utility-proof","version":"0.0.0","main":"main.js"}',
    )
    writeFileSync(
      path.join(farmApp, 'main.js'),
      `const { app, utilityProcess } = require('electron')

const entry = process.env.TASTECODE_NATIVE_PROOF_ENTRY
if (!entry) {
  process.stderr.write('[utility-proof] TASTECODE_NATIVE_PROOF_ENTRY is not set\\n')
  app.exit(2)
}

app.whenReady().then(() => {
  const child = utilityProcess.fork(entry, [], {
    serviceName: 'tastecode-utility-native-proof',
    stdio: 'pipe',
  })
  child.stdout.on('data', (data) => process.stdout.write(data))
  child.stderr.on('data', (data) => process.stderr.write(data))
  child.once('exit', (code) => app.exit(code ?? 1))
})
`,
    )
    const env = { ...process.env, TASTECODE_NATIVE_PROOF_ENTRY: proofEntry }
    delete env.ELECTRON_RUN_AS_NODE
    const result = spawnSync(farmExe, [], {
      env,
      stdio: 'inherit',
      timeout: 120000,
      windowsHide: true,
    })
    if (result.error) throw result.error
    if (result.signal) {
      throw new Error(`utility launcher proof ended with signal ${result.signal}`)
    }
    if (result.status !== 0) process.exitCode = result.status ?? 1
  } finally {
    rmSync(farm, { recursive: true, force: true })
  }
}

const arguments_ = process.argv.slice(2).filter((argument) => argument !== '--')
const utility = arguments_.includes('--utility')
const positional = arguments_.filter((argument) => argument !== '--utility')
if (positional.length !== 1) {
  throw new Error(
    'usage: pnpm --filter @harness/desktop verify:native-bindings [--utility] -- <app-or-exe>',
  )
}
const [argument] = positional
const { executable, resources } = packagedPaths(argument)
const archive = path.join(resources, 'app.asar')
if (!existsSync(executable)) throw new Error(`packaged executable does not exist: ${executable}`)
if (!existsSync(archive)) throw new Error(`packaged app.asar does not exist: ${archive}`)

if (utility) {
  runUtilityLauncherProof(executable, resources)
} else {
  const proof = path.join(archive, 'dist', 'native-binding-proof.js')
  const result = spawnSync(executable, [proof], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: 'inherit',
    windowsHide: true,
  })
  if (result.error) throw result.error
  if (result.signal) throw new Error(`native binding proof ended with signal ${result.signal}`)
  if (result.status !== 0) process.exitCode = result.status ?? 1
}
