import { constants } from 'node:fs'
import { copyFile, mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { isMain, releaseConfig, verifyReleaseDirectory } from './release-manifest.js'

export async function stageReleaseAssets(
  sourceDirectory,
  destinationDirectory,
  platform,
  { approvedSha, config = releaseConfig } = {},
) {
  const source = path.resolve(sourceDirectory)
  const destination = path.resolve(destinationDirectory)
  if (source === destination) throw new Error('Release staging source and destination must differ')
  const names = await verifyReleaseDirectory(source, {
    platform,
    exact: false,
    approvedSha,
    config,
  })
  await mkdir(destination)
  try {
    for (const name of names)
      await copyFile(path.join(source, name), path.join(destination, name), constants.COPYFILE_EXCL)
    await verifyReleaseDirectory(destination, { platform, approvedSha, config })
    return destination
  } catch (error) {
    await rm(destination, { recursive: true, force: true })
    throw error
  }
}

if (isMain(import.meta.url)) {
  const [source, destination, platform] = process.argv.slice(2)
  if (!source || !destination || !platform)
    throw new Error(
      'Usage: node stage-release-assets.js <source> <new-destination> <windows|macos>',
    )
  console.log(
    `Staged verified assets in ${await stageReleaseAssets(source, destination, platform, { approvedSha: process.env.APPROVED_SHA })}`,
  )
}
