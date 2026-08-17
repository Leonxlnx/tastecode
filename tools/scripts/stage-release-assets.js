import { copyFile, mkdir, readdir } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { releaseAssets, verifyReleaseDirectory } from './release-manifest.js'

export async function stageReleaseAssets(sourceDirectory, destinationDirectory, platform) {
  const source = path.resolve(sourceDirectory)
  const destination = path.resolve(destinationDirectory)
  if (source === destination) throw new Error('Release staging source and destination must differ')

  await verifyReleaseDirectory(source, { platform, exact: false })
  await mkdir(destination, { recursive: true })

  const existing = await readdir(destination)
  if (existing.length > 0) throw new Error(`Release staging directory is not empty: ${destination}`)

  for (const name of releaseAssets(platform)) {
    await copyFile(path.join(source, name), path.join(destination, name))
  }

  await verifyReleaseDirectory(destination, { platform, exact: true })
  return destination
}

const isMain =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url

if (isMain) {
  const source = process.argv[2] ?? 'release'
  const destination = process.argv[3]
  const platform = process.argv[4]
  if (!destination || !platform) {
    throw new Error('Usage: node stage-release-assets.js <source> <destination> <platform>')
  }

  const staged = await stageReleaseAssets(source, destination, platform)
  console.log(`Staged verified ${platform} release assets in ${staged}`)
}
