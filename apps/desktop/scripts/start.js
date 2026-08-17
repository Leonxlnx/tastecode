import { execFile, spawn } from 'node:child_process'
import { access, cp, mkdtemp, mkdir, readFile, readdir, rename, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

import { installMacOSIcon } from './macos-icon.js'

const execFileAsync = promisify(execFile)
const here = path.dirname(fileURLToPath(import.meta.url))
const desktopRoot = path.resolve(here, '..')
const workspaceRoot = path.resolve(desktopRoot, '../..')
const require = createRequire(import.meta.url)
const desktopPackage = JSON.parse(await readFile(path.join(desktopRoot, 'package.json'), 'utf8'))
const appName = desktopPackage.productName
const appBundleIdentifier = `${desktopPackage.build.appId}.dev`

async function plistValue(plistPath, key) {
  const { stdout } = await execFileAsync('/usr/bin/plutil', ['-extract', key, 'raw', plistPath])
  return stdout.trim()
}

async function setPlistStrings(plistPath, values) {
  for (const [key, value] of Object.entries(values)) {
    try {
      await execFileAsync('/usr/bin/plutil', ['-replace', key, '-string', value, plistPath])
    } catch {
      await execFileAsync('/usr/bin/plutil', ['-insert', key, '-string', value, plistPath])
    }
  }
}

async function cloneBundle(sourceBundle, destinationDirectory) {
  try {
    // APFS clones avoid a second physical copy of Electron's large framework.
    await execFileAsync('/bin/cp', ['-cR', sourceBundle, destinationDirectory])
  } catch {
    const destinationBundle = path.join(destinationDirectory, path.basename(sourceBundle))
    await rm(destinationBundle, { recursive: true, force: true })
    await cp(sourceBundle, destinationBundle, {
      recursive: true,
      force: false,
      errorOnExist: true,
      preserveTimestamps: true,
    })
  }
}

async function rebrandMacBundle(sourceBundle) {
  const contents = path.join(sourceBundle, 'Contents')
  const appPlist = path.join(contents, 'Info.plist')
  const originalAppName = await plistValue(appPlist, 'CFBundleName')
  const originalExecutable = await plistValue(appPlist, 'CFBundleExecutable')
  const frameworks = path.join(contents, 'Frameworks')
  const helperEntries = (await readdir(frameworks, { withFileTypes: true }))
    .filter(
      (entry) =>
        entry.isDirectory() &&
        entry.name.startsWith(`${originalAppName} Helper`) &&
        entry.name.endsWith('.app'),
    )
    .sort((left, right) => left.name.localeCompare(right.name))

  for (const entry of helperEntries) {
    const originalHelperName = entry.name.slice(0, -'.app'.length)
    const helperSuffix = originalHelperName.slice(originalAppName.length)
    const helperName = `${appName}${helperSuffix}`
    const helperBundle = path.join(frameworks, entry.name)
    const helperPlist = path.join(helperBundle, 'Contents', 'Info.plist')
    const helperRole = helperSuffix.match(/\(([^)]+)\)/)?.[1]
    const helperIdentifier = `${appBundleIdentifier}.helper${helperRole ? `.${helperRole}` : ''}`

    await setPlistStrings(helperPlist, {
      CFBundleDisplayName: helperName,
      CFBundleExecutable: helperName,
      CFBundleIdentifier: helperIdentifier,
      CFBundleName: helperName,
    })
    await rename(
      path.join(helperBundle, 'Contents', 'MacOS', originalHelperName),
      path.join(helperBundle, 'Contents', 'MacOS', helperName),
    )
    await rename(helperBundle, path.join(frameworks, `${helperName}.app`))
  }

  await setPlistStrings(appPlist, {
    CFBundleDisplayName: appName,
    CFBundleExecutable: appName,
    CFBundleIdentifier: appBundleIdentifier,
    CFBundleName: appName,
  })
  await rename(
    path.join(contents, 'MacOS', originalExecutable),
    path.join(contents, 'MacOS', appName),
  )

  const brandedBundle = path.join(path.dirname(sourceBundle), `${appName}.app`)
  await rename(sourceBundle, brandedBundle)
  return brandedBundle
}

export async function developmentElectronExecutable() {
  const electronExecutable = require('electron')
  if (process.platform !== 'darwin') return electronExecutable

  const electronVersion = require('electron/package.json').version
  const cacheKey = `${electronVersion}-${process.arch}-${appName.replaceAll(' ', '-')}-v2`
  const cacheRoot = path.join(workspaceRoot, 'node_modules', '.cache', 'tastecode-electron')
  const cachedDirectory = path.join(cacheRoot, cacheKey)
  const cachedExecutable = path.join(
    cachedDirectory,
    `${appName}.app`,
    'Contents',
    'MacOS',
    appName,
  )

  try {
    await access(cachedExecutable)
    return cachedExecutable
  } catch {
    // The branded development runtime is prepared once per Electron version.
  }

  await mkdir(cacheRoot, { recursive: true })
  const temporaryDirectory = await mkdtemp(path.join(cacheRoot, '.prepare-'))
  const sourceBundle = path.resolve(path.dirname(electronExecutable), '../..')
  console.log(`[desktop] preparing the ${appName} development app`)

  try {
    await cloneBundle(sourceBundle, temporaryDirectory)
    const brandedBundle = await rebrandMacBundle(
      path.join(temporaryDirectory, path.basename(sourceBundle)),
    )
    await installMacOSIcon(brandedBundle)
    try {
      await rename(temporaryDirectory, cachedDirectory)
    } catch (error) {
      if (error?.code !== 'EEXIST' && error?.code !== 'ENOTEMPTY') throw error
      await access(cachedExecutable)
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
    return cachedExecutable
  } catch (error) {
    await rm(temporaryDirectory, { recursive: true, force: true })
    throw error
  }
}

async function start() {
  const executable = await developmentElectronExecutable()
  const child = spawn(executable, [desktopRoot, ...process.argv.slice(2)], {
    cwd: desktopRoot,
    env: process.env,
    stdio: 'inherit',
  })

  child.once('error', (error) => {
    console.error(`[desktop] ${error.message}`)
    process.exitCode = 1
  })
  child.once('exit', (code) => {
    process.exitCode = code ?? 1
  })
}

const isEntryPoint =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href

if (isEntryPoint) await start()
