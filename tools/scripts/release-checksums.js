import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

const releaseDirectory = path.resolve(process.argv[2] ?? 'release')
const outputName = process.argv[3] ?? 'SHA256SUMS.txt'
const releaseExtensions = new Set(['.exe', '.dmg', '.zip', '.blockmap'])

function isReleaseArtifact(name) {
  if (name === 'beta.yml' || name === 'beta-mac.yml') return true
  return name.startsWith('TasteCode-') && releaseExtensions.has(path.extname(name))
}

const entries = await readdir(releaseDirectory)
const files = []

for (const entry of entries.sort()) {
  const filePath = path.join(releaseDirectory, entry)
  const fileStat = await stat(filePath)

  if (fileStat.isFile() && isReleaseArtifact(entry)) {
    files.push({ entry, filePath })
  }
}

if (files.length === 0) {
  throw new Error(`No release files found in ${releaseDirectory}`)
}

const rows = []

for (const { entry, filePath } of files) {
  const hash = createHash('sha256')

  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', resolve)
  })

  rows.push(`${hash.digest('hex')}  ${entry}`)
}

const outputPath = path.join(releaseDirectory, outputName)
await writeFile(outputPath, `${rows.join('\n')}\n`, 'utf8')
console.log(`Wrote ${rows.length} checksums to ${outputPath}`)
console.log(rows.join('\n'))
