import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { lstat, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { generateReleaseChecksums } from './release-checksums.js'
import {
  desktopDirectory,
  hashFile,
  isMain,
  parseMetadata,
  platformConfig,
  readSmallFile,
  releaseConfig,
  repositoryRoot,
  verifyReleaseDirectory,
  verifyReleasePayload,
} from './release-manifest.js'
import { verifyReleaseCheckout } from './verify-release-input.js'

function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    cwd: repositoryRoot,
    stdio: 'inherit',
    windowsHide: true,
    timeout: 15 * 60 * 1000,
    ...options,
  })
  if (result.error) throw result.error
  if (result.signal || result.status !== 0)
    throw new Error(
      `Package proof command failed: ${path.basename(executable)} (${result.signal ?? result.status})`,
    )
}

async function verifyLicenseTree(source, destination) {
  const destinationStat = await lstat(destination)
  if (!destinationStat.isDirectory() || destinationStat.isSymbolicLink())
    throw new Error('Packaged license directory must not be a link')
  if (
    JSON.stringify((await readdir(source)).sort()) !==
    JSON.stringify((await readdir(destination)).sort())
  )
    throw new Error('Packaged license tree has missing or unexpected files')
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.isDirectory())
      await verifyLicenseTree(path.join(source, entry.name), path.join(destination, entry.name))
    else if (
      !entry.isFile() ||
      (await hashFile(path.join(source, entry.name))) !==
        (await hashFile(path.join(destination, entry.name)))
    )
      throw new Error('Packaged license tree does not match the source')
  }
}

export function packagingAsar() {
  const desktop = createRequire(path.join(desktopDirectory, 'package.json'))
  const builder = createRequire(desktop.resolve('electron-builder'))
  // Use the same archive reader as the pinned packager, including its pnpm dependency context.
  return createRequire(builder.resolve('app-builder-lib'))('@electron/asar')
}

export async function verifyBundledDesignReferences(
  archive,
  source = path.join(repositoryRoot, 'packages', 'design-agent', 'references', 'directions'),
) {
  const asar = packagingAsar()
  asar.uncache(archive)
  const expected = []
  async function collect(directory, relative = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const child = path.join(relative, entry.name)
      if (entry.isDirectory()) await collect(path.join(directory, entry.name), child)
      else if (entry.isFile() && entry.name.endsWith('.webp')) expected.push(child)
      else throw new Error('Unexpected design reference asset')
    }
  }
  await collect(source)
  if (expected.length === 0) throw new Error('No source design references were found')
  const prefix = path.join('node_modules', '@harness', 'design-agent', 'references', 'directions')
  const names = asar
    .listPackage(archive)
    .map((name) => name.replaceAll('\\', '/').replace(/^\//, ''))
  const expectedNames = expected.map((name) => path.join(prefix, name).replaceAll('\\', '/')).sort()
  const archiveNames = names
    .filter((name) => name.startsWith(`${prefix.replaceAll('\\', '/')}/`) && name.endsWith('.webp'))
    .sort()
  if (JSON.stringify(expectedNames) !== JSON.stringify(archiveNames))
    throw new Error('Packaged design reference filenames do not match the source')
  for (const name of expected) {
    const bytes = asar.extractFile(archive, path.join(prefix, name))
    if (
      createHash('sha256').update(bytes).digest('hex') !== (await hashFile(path.join(source, name)))
    )
      throw new Error('Packaged design reference bytes do not match the source')
  }
  return expected.length
}

export async function verifyPackagedResources(
  resources,
  config = releaseConfig,
  sourceRoot = repositoryRoot,
) {
  for (const name of ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_LICENSES.txt']) {
    const source =
      name === 'THIRD_PARTY_LICENSES.txt'
        ? path.join(sourceRoot, 'release', name)
        : path.join(sourceRoot, name)
    if ((await hashFile(source)) !== (await hashFile(path.join(resources, name))))
      throw new Error(`Packaged license does not match the source: ${name}`)
  }
  await verifyLicenseTree(path.join(sourceRoot, 'licenses'), path.join(resources, 'licenses'))
  const updater = parseMetadata(await readSmallFile(path.join(resources, 'app-update.yml')))
  if (
    updater?.provider !== config.publish.provider ||
    updater.url !== config.publish.url ||
    updater.channel !== config.updaterChannel
  )
    throw new Error('Packaged updater does not match the configured feed')
  for (const relative of ['app.asar', path.join('web', 'index.html')]) {
    const entry = await lstat(path.join(resources, relative))
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size === 0)
      throw new Error(`Missing packaged runtime file: ${relative}`)
  }
  await verifyBundledDesignReferences(
    path.join(resources, 'app.asar'),
    path.join(sourceRoot, 'packages', 'design-agent', 'references', 'directions'),
  )
}

export function assertInstallerProofHost(env = process.env) {
  if (env.GITHUB_ACTIONS !== 'true' || env.RUNNER_ENVIRONMENT !== 'github-hosted')
    throw new Error(
      'NSIS install/uninstall proof requires an isolated GitHub-hosted Windows runner',
    )
}

export async function verifyPackageContainers(directory, platform, config = releaseConfig) {
  await verifyReleasePayload(directory, platform, config)
  const detail = platformConfig(platform, config)
  if (platform === 'macos') {
    if (process.platform !== 'darwin' || process.arch !== detail.arch)
      throw new Error('macOS proof must run on Apple Silicon macOS')
    const app = path.join(directory, 'mac-arm64', `${config.productName}.app`)
    await verifyPackagedResources(path.join(app, 'Contents', 'Resources'), config)
    run(process.execPath, [
      path.join(desktopDirectory, 'scripts', 'run-native-binding-proof.js'),
      app,
    ])
    run('/usr/bin/hdiutil', [
      'verify',
      path.join(
        directory,
        detail.artifacts.find((name) => name.endsWith('.dmg')),
      ),
    ])
    run('/usr/bin/unzip', ['-t', path.join(directory, detail.primaryArtifact)])
    return
  }
  if (process.platform !== 'win32' || process.arch !== detail.arch)
    throw new Error('Windows proof must run on Windows x64')
  // NSIS also writes product registry entries and shortcuts outside /D. Never run its smoke
  // test on a developer machine or self-hosted runner with an existing installation.
  assertInstallerProofHost()
  const unpacked = path.join(directory, 'win-unpacked')
  await verifyPackagedResources(path.join(unpacked, 'resources'), config)
  const executables = (await readdir(unpacked)).filter((name) => name.endsWith('.exe'))
  if (executables.length !== 1) throw new Error('Expected one unpacked Windows app executable')
  run(process.execPath, [
    path.join(desktopDirectory, 'scripts', 'run-native-binding-proof.js'),
    path.join(unpacked, executables[0]),
  ])
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'release-install-proof-'))
  const installation = path.join(temporary, 'app')
  const failures = []
  try {
    run(path.join(directory, detail.primaryArtifact), ['/S', `/D=${installation}`])
    await verifyPackagedResources(path.join(installation, 'resources'), config)
    run(process.execPath, [
      path.join(desktopDirectory, 'scripts', 'run-native-binding-proof.js'),
      path.join(installation, executables[0]),
    ])
  } catch (error) {
    failures.push(error)
  }
  try {
    const uninstallers = (
      await readdir(installation).catch((error) => {
        if (error.code === 'ENOENT') return []
        throw error
      })
    ).filter((name) => /^Uninstall.*\.exe$/.test(name))
    if (uninstallers.length !== 1)
      throw new Error('Expected one uninstaller for the isolated Windows install')
    run(path.join(installation, uninstallers[0]), ['/S', `_?=${installation}`])
  } catch (error) {
    failures.push(error)
  }
  try {
    await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch (error) {
    failures.push(error)
  }
  if (failures.length) throw new AggregateError(failures, 'Windows install proof or cleanup failed')
}

export async function buildPackageProof(directory, platform) {
  const approvedSha = verifyReleaseCheckout()
  const detail = platformConfig(platform)
  if (
    (platform === 'windows' ? 'win32' : 'darwin') !== process.platform ||
    detail.arch !== process.arch
  )
    throw new Error('Package proof must run on the target operating system and architecture')
  // Refuse stale output. The license command writes its existing shared report under release/.
  await mkdir(directory)
  const requireDesktop = createRequire(path.join(desktopDirectory, 'package.json'))
  const env = { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' }
  for (const name of Object.keys(env)) {
    if (/^(?:CSC_|WIN_CSC_|APPLE_)/.test(name) && name !== 'CSC_IDENTITY_AUTO_DISCOVERY')
      delete env[name]
  }
  const targets =
    platform === 'windows'
      ? ['--win', 'nsis', '--x64']
      : ['--mac', 'dmg', 'zip', '--arm64', '--config.mac.notarize=false']
  run(
    process.execPath,
    [
      requireDesktop.resolve('electron-builder/cli.js'),
      ...targets,
      '--publish',
      'never',
      `--config.directories.output=${directory}`,
    ],
    { cwd: desktopDirectory, env },
  )
  await verifyPackageContainers(directory, platform)
  verifyReleaseCheckout()
  await generateReleaseChecksums(directory, platform, { approvedSha })
  console.log(
    `Verified ${platform} packaging proof for ${approvedSha}; signing and clean-machine product QA remain separate gates`,
  )
}

if (isMain(import.meta.url)) {
  const [first, second, third] = process.argv.slice(2)
  if (first === '--package' || first === '--containers') {
    if (!second || !third)
      throw new Error(
        'Usage: node verify-release-assets.js <--package|--containers> <directory> <windows|macos>',
      )
    if (first === '--package') await buildPackageProof(path.resolve(second), third)
    else await verifyPackageContainers(path.resolve(second), third)
  } else {
    const names = await verifyReleaseDirectory(path.resolve(first ?? 'release-final'), {
      platform: second ?? 'all',
      approvedSha: process.env.APPROVED_SHA,
    })
    console.log(`Verified exact release manifest (${names.length} assets)`)
  }
}
