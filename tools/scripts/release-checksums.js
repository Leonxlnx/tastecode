import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  checksumName,
  checksumPayloadAssets,
  platformFromChecksumName,
  sha256File,
  verifyReleasePayload,
} from './release-manifest.js'

export async function generateReleaseChecksums(releaseDirectory, platform) {
  const resolvedDirectory = path.resolve(releaseDirectory)
  await verifyReleasePayload(resolvedDirectory, platform)

  const rows = []
  for (const name of checksumPayloadAssets(platform)) {
    const digest = await sha256File(path.join(resolvedDirectory, name))
    rows.push(`${digest}  ${name}`)
  }

  const outputPath = path.join(resolvedDirectory, checksumName(platform))
  await writeFile(outputPath, `${rows.join('\n')}\n`, 'utf8')
  return { outputPath, rows }
}

const isMain =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url

if (isMain) {
  const releaseDirectory = process.argv[2] ?? 'release'
  const requestedOutput = process.argv[3]
  const platform = process.argv[4] ?? platformFromChecksumName(requestedOutput)

  if (requestedOutput && requestedOutput !== checksumName(platform)) {
    throw new Error(`Checksum output for ${platform} must be ${checksumName(platform)}`)
  }

  const { outputPath, rows } = await generateReleaseChecksums(releaseDirectory, platform)
  console.log(`Wrote ${rows.length} checksums to ${outputPath}`)
  console.log(rows.join('\n'))
}
