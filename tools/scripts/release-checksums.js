import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  assertCommitSha,
  checksumPayloadAssets,
  hashFile,
  isMain,
  platformConfig,
  releaseConfig,
  verifyReleaseDirectory,
  verifyReleasePayload,
} from './release-manifest.js'
import { verifyReleaseCheckout } from './verify-release-input.js'

export async function generateReleaseChecksums(
  directory,
  platform,
  { approvedSha, config = releaseConfig } = {},
) {
  assertCommitSha(approvedSha)
  const detail = platformConfig(platform, config)
  await verifyReleasePayload(directory, platform, config)
  const provenance = {
    schemaVersion: 1,
    approvedSha,
    version: config.version,
    configSha256: config.configSha256,
    platform,
    proofOnly: true,
  }
  await writeFile(
    path.join(directory, detail.provenance),
    `${JSON.stringify(provenance, null, 2)}\n`,
    { flag: 'wx' },
  )
  const rows = []
  for (const name of checksumPayloadAssets(platform, config))
    rows.push(`${await hashFile(path.join(directory, name))}  ${name}`)
  await writeFile(path.join(directory, detail.checksums), `${rows.join('\n')}\n`, { flag: 'wx' })
  await verifyReleaseDirectory(directory, { platform, exact: false, approvedSha, config })
  return rows
}

if (isMain(import.meta.url)) {
  const [directory, platform] = process.argv.slice(2)
  if (!directory || !platform)
    throw new Error('Usage: node release-checksums.js <directory> <windows|macos>')
  const approvedSha = verifyReleaseCheckout()
  const rows = await generateReleaseChecksums(path.resolve(directory), platform, { approvedSha })
  console.log(
    `Verified ${rows.length} checksums for ${platform} at ${approvedSha}; unsigned packaging proof only`,
  )
}
