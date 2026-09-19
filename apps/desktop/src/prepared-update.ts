import { createReadStream } from 'node:fs'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { UpdateInfo } from 'electron-updater'

export async function withUpdateDirectory<T>(use: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'tastecode-update-'))
  try {
    return await use(directory)
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
  }
}

export async function updateFileHashes(file: string) {
  const sha256 = createHash('sha256')
  const sha512 = createHash('sha512')
  let size = 0
  for await (const chunk of createReadStream(file)) {
    sha256.update(chunk)
    sha512.update(chunk)
    size += chunk.length
  }
  return { sha256: sha256.digest('hex'), sha512: sha512.digest('base64'), size }
}

export async function servePreparedUpdate<T>(
  file: string,
  info: UpdateInfo,
  use: (url: string, prepared: UpdateInfo) => Promise<T>,
): Promise<T> {
  const { size, sha512 } = await updateFileHashes(file)
  if (!size || !(await stat(file)).isFile()) throw new Error('Empty prepared update.')
  const route = `/${randomBytes(32).toString('hex')}/update${path.extname(file)}`
  const server = createServer((request, response) => {
    if (
      request.headers.origin !== undefined ||
      request.url !== route ||
      !['GET', 'HEAD'].includes(request.method ?? '')
    ) {
      response.writeHead(404).end()
      return
    }
    response.writeHead(200, { 'Content-Length': size, 'Content-Type': 'application/octet-stream' })
    if (request.method === 'HEAD') {
      response.end()
      return
    }
    const stream = createReadStream(file)
    stream.on('error', () => response.destroy())
    response.on('close', () => stream.destroy())
    stream.pipe(response)
  })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No update server address.')
    const url = `http://127.0.0.1:${address.port}`
    const assetUrl = `${url}${route}`
    const prepared: UpdateInfo = {
      version: info.version,
      releaseDate: info.releaseDate,
      files: [{ url: assetUrl, size, sha512 }],
      path: assetUrl,
      sha512,
    }
    return await use(url, prepared)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}
