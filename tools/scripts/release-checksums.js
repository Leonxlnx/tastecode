import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

const releaseDirectory = path.resolve(process.argv[2] ?? 'release')
const includedExtensions = new Set(['.exe', '.dmg', '.zip', '.blockmap', '.yml', '.yaml'])

const entries = await readdir(releaseDirectory)
const files = []

for (const entry of entries.sort()) {
  const filePath = path.join(releaseDirectory, entry)
  const fileStat = await stat(filePath)

  if (fileStat.isFile() && includedExtensions.has(path.extname(entry))) {
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

const outputPath = path.join(releaseDirectory, 'SHA256SUMS.txt')
await writeFile(outputPath, `${rows.join('\n')}\n`, 'utf8')
console.log(`Wrote ${rows.length} checksums to ${outputPath}`)
