import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { verifyReleaseDirectory } from './release-manifest.js'

const isMain =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url

if (isMain) {
  const releaseDirectory = path.resolve(process.argv[2] ?? 'release')
  const platform = process.argv[3] ?? 'all'
  const names = await verifyReleaseDirectory(releaseDirectory, {
    platform,
    exact: true,
  })
  console.log(`Verified exact ${platform} release manifest (${names.length} assets)`)
}
