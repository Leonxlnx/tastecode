import { spawnSync } from 'node:child_process'
import { constants } from 'node:fs'
import { copyFile, lstat, mkdir, open, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { expectedLinuxArtifactNames } from '../../../tools/scripts/linux-release-shared.js'

const TAG = '[prepare-linux-release]'
const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

export function linuxPreparationPaths(root = workspaceRoot) {
  const releaseDirectory = path.join(root, 'release')
  return {
    privateOutput: path.join(releaseDirectory, '.linux-package'),
    distribution: path.join(releaseDirectory, 'linux-x64'),
    lock: path.join(releaseDirectory, '.linux-prepare.lock'),
  }
}

export function linuxPreparationCommands(root = workspaceRoot) {
  const desktop = path.join(root, 'apps', 'desktop')
  return [
    { command: 'pnpm', args: ['licenses:verify'], cwd: root, phase: 'licenses' },
    {
      command: process.execPath,
      args: [path.join(root, 'tools', 'scripts', 'build-provenance.js')],
      cwd: root,
      phase: 'provenance',
    },
    { command: 'pnpm', args: ['build'], cwd: root, phase: 'build' },
    {
      command: process.execPath,
      args: [path.join(desktop, 'scripts', 'build-preload.js')],
      cwd: desktop,
      phase: 'preload',
    },
    {
      command: 'pnpm',
      args: [
        '--dir',
        desktop,
        'exec',
        'electron-builder',
        '--linux',
        'AppImage',
        'deb',
        '--x64',
        '--config.directories.output=../../release/.linux-package',
      ],
      cwd: root,
      phase: 'package',
    },
  ]
}

function runCommand({ command, args, cwd, phase }) {
  process.stdout.write(`\n${TAG} ${phase}: ${command} ${args.join(' ')}\n`)
  const result = spawnSync(command, args, { cwd, env: process.env, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.signal) throw new Error(`${TAG} ${phase} ended with signal ${result.signal}`)
  if (result.status !== 0) {
    throw new Error(`${TAG} ${phase} exited with status ${result.status ?? 'unknown'}`)
  }
}

export async function stageLinuxDistribution(source, destination, desktopPackage) {
  const expected = expectedLinuxArtifactNames(
    {
      version: desktopPackage.version,
      artifactName: desktopPackage.build?.artifactName,
      productName: desktopPackage.productName,
      name: desktopPackage.name,
    },
    TAG,
  )
  await rm(destination, { recursive: true, force: true })
  await mkdir(destination, { recursive: true })
  for (const name of expected) {
    const sourcePath = path.join(source, name)
    let sourceStat
    try {
      sourceStat = await lstat(sourcePath)
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw new Error(
          `${TAG} packaged artifact is missing from ${source}: ${name}; rerun pnpm --filter @harness/desktop dist:linux`,
        )
      }
      throw error
    }
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || sourceStat.size === 0) {
      throw new Error(`${TAG} packaged artifact must be a nonempty regular file: ${name}`)
    }
    await copyFile(sourcePath, path.join(destination, name), constants.COPYFILE_EXCL)
  }
  return expected
}

export async function withLinuxPreparationLock(lockPath, operation) {
  await mkdir(path.dirname(lockPath), { recursive: true })
  let handle
  try {
    handle = await open(lockPath, 'wx', 0o600)
    try {
      await handle.writeFile(`${process.pid}\n`)
    } catch (error) {
      await handle.close()
      handle = undefined
      await rm(lockPath, { force: true })
      throw error
    }
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    const owner = (await readFile(lockPath, 'utf8').catch(() => '')).trim()
    throw new Error(
      `${TAG} Linux release preparation lock ${lockPath} is held${owner ? ` by process ${owner}` : ''}; ` +
        'if no preparation is active, remove that lock file and retry',
    )
  }
  try {
    return await operation()
  } finally {
    await handle.close()
    await rm(lockPath, { force: true })
  }
}

export async function prepareLinuxRelease({ root = workspaceRoot, run = runCommand } = {}) {
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    throw new Error(`${TAG} requires Linux x64, received ${process.platform} ${process.arch}`)
  }
  const paths = linuxPreparationPaths(root)
  return withLinuxPreparationLock(paths.lock, async () => {
    await rm(paths.privateOutput, { recursive: true, force: true })
    await rm(paths.distribution, { recursive: true, force: true })
    for (const command of linuxPreparationCommands(root)) run(command)

    const desktopPackage = JSON.parse(
      await readFile(path.join(root, 'apps', 'desktop', 'package.json'), 'utf8'),
    )
    const artifacts = await stageLinuxDistribution(
      paths.privateOutput,
      paths.distribution,
      desktopPackage,
    )
    run({
      command: process.execPath,
      args: [
        path.join(root, 'tools', 'scripts', 'linux-release-evidence.js'),
        '--dir',
        paths.distribution,
      ],
      cwd: root,
      phase: 'evidence',
    })
    process.stdout.write(
      `${TAG} prepared manual-update Linux distribution: ${artifacts.join(', ')}\n`,
    )
    return { ...paths, artifacts }
  })
}

const isEntryPoint =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href

if (isEntryPoint) {
  prepareLinuxRelease().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
