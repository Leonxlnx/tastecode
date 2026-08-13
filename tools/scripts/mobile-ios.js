/**
 * Generate, build, test, or launch the native Harness iOS client.
 *
 * This remains a Node script so the shared repository never depends on a POSIX
 * shell. iOS operations fail clearly on Windows instead of affecting the rest
 * of the monorepo.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

if (process.platform !== 'darwin') {
  console.error('[mobile:ios] Native iOS builds require macOS, Xcode 26 or newer, and XcodeGen.')
  process.exit(1)
}

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const mobileRoot = path.join(repositoryRoot, 'apps', 'mobile')
const projectSpec = path.join(mobileRoot, 'project.yml')
const projectPath = path.join(mobileRoot, 'HarnessMobile.xcodeproj')
const derivedDataPath = path.join(mobileRoot, '.derivedData')
const scheme = 'HarnessMobile'
const mode = process.argv.includes('--test')
  ? 'test'
  : process.argv.includes('--build')
    ? 'build'
    : process.argv.includes('--device')
      ? 'device'
      : 'launch'

if (!existsSync(projectSpec)) {
  console.error(`[mobile:ios] Missing native project spec: ${projectSpec}`)
  process.exit(1)
}

const sdkVersion = commandOutput('xcrun', ['--sdk', 'iphoneos', '--show-sdk-version'])
if (Number.parseInt(sdkVersion, 10) < 26) {
  console.error(`[mobile:ios] iOS SDK 26 or newer is required; active SDK is ${sdkVersion}.`)
  process.exit(1)
}

run('xcodegen', ['generate', '--spec', projectSpec], repositoryRoot)

if (mode === 'device') {
  run('open', [projectPath], repositoryRoot)
  console.log('[mobile:ios] Opened the native project. Select your iPhone and press Run in Xcode.')
  process.exit(0)
}

if (mode === 'build') {
  run(
    'xcodebuild',
    [
      '-project',
      projectPath,
      '-scheme',
      scheme,
      '-configuration',
      'Debug',
      '-destination',
      'generic/platform=iOS',
      '-derivedDataPath',
      derivedDataPath,
      'CODE_SIGNING_ALLOWED=NO',
      'build',
    ],
    repositoryRoot,
  )
  process.exit(0)
}

const simulator = selectSimulator()
if (simulator.state !== 'Booted') {
  const boot = spawnSync('xcrun', ['simctl', 'boot', simulator.udid], { encoding: 'utf8' })
  if (boot.status !== 0 && !`${boot.stderr}`.includes('current state: Booted')) {
    console.error(boot.stderr || boot.stdout)
    process.exit(boot.status ?? 1)
  }
}
run('xcrun', ['simctl', 'bootstatus', simulator.udid, '-b'], repositoryRoot)
if (mode === 'launch') openSimulatorUI(simulator)

const destination = `platform=iOS Simulator,id=${simulator.udid}`
if (mode === 'test') {
  run(
    'xcodebuild',
    [
      '-project',
      projectPath,
      '-scheme',
      scheme,
      '-destination',
      destination,
      '-derivedDataPath',
      derivedDataPath,
      'CODE_SIGNING_ALLOWED=NO',
      'test',
    ],
    repositoryRoot,
  )
  process.exit(0)
}

run(
  'xcodebuild',
  [
    '-project',
    projectPath,
    '-scheme',
    scheme,
    '-configuration',
    'Debug',
    '-destination',
    destination,
    '-derivedDataPath',
    derivedDataPath,
    'CODE_SIGNING_ALLOWED=NO',
    'build',
  ],
  repositoryRoot,
)

const appPath = path.join(
  derivedDataPath,
  'Build',
  'Products',
  'Debug-iphonesimulator',
  'Harness.app',
)
run('xcrun', ['simctl', 'install', simulator.udid, appPath], repositoryRoot)
run('xcrun', ['simctl', 'launch', simulator.udid, 'com.blueemi.Harness'], repositoryRoot)
console.log(`[mobile:ios] Harness is running on ${simulator.name}.`)

function selectSimulator() {
  const raw = commandOutput('xcrun', ['simctl', 'list', 'devices', 'available', '--json'])
  const parsed = JSON.parse(raw)
  const devices = Object.entries(parsed.devices).flatMap(([runtime, runtimeDevices]) =>
    runtimeDevices.map((device) => ({ ...device, runtime })),
  )
  const iPhones = devices.filter((device) => {
    const majorVersion = /\.iOS-(\d+)-/.exec(device.runtime)?.[1]
    return (
      device.isAvailable &&
      /^iPhone\s/.test(device.name) &&
      majorVersion !== undefined &&
      Number.parseInt(majorVersion, 10) >= 26
    )
  })
  const selected = iPhones.find((device) => device.state === 'Booted') ?? iPhones[0]
  if (!selected) {
    console.error('[mobile:ios] No available iOS 26+ iPhone Simulator runtime was found in Xcode.')
    process.exit(1)
  }
  return selected
}

function openSimulatorUI(simulator) {
  const developerPath = process.env.DEVELOPER_DIR?.trim() || commandOutput('xcode-select', ['-p'])
  const simulatorApp = path.join(developerPath, 'Applications', 'Simulator.app')
  if (existsSync(simulatorApp)) {
    tryOpen([simulatorApp], 'Simulator')
    return
  }

  const deviceHubApp = path.join(path.dirname(developerPath), 'Applications', 'DeviceHub.app')
  if (existsSync(deviceHubApp)) {
    console.log(
      `[mobile:ios] Simulator.app is not part of this Xcode; opening ${simulator.name} in Device Hub.`,
    )
    tryOpen(
      ['-a', deviceHubApp, `devices://device/open?id=${encodeURIComponent(simulator.udid)}`],
      'Device Hub',
    )
    return
  }

  console.warn(
    '[mobile:ios] No simulator UI was found in the active Xcode; continuing with the booted simulator.',
  )
}

function tryOpen(args, label) {
  const result = spawnSync('open', args, { cwd: repositoryRoot, encoding: 'utf8' })
  if (!result.error && result.status === 0) return

  const detail = result.error?.message || result.stderr?.trim() || `exit code ${result.status ?? 1}`
  console.warn(`[mobile:ios] Unable to open ${label} (${detail}); continuing with the simulator.`)
}

function commandOutput(command, args) {
  try {
    return execFileSync(command, args, { cwd: repositoryRoot, encoding: 'utf8' }).trim()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[mobile:ios] ${command} failed: ${message}`)
    process.exit(1)
  }
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' })
  if (result.error) {
    console.error(`[mobile:ios] ${command} failed: ${result.error.message}`)
    process.exit(1)
  }
  if (result.status !== 0) process.exit(result.status ?? 1)
}
