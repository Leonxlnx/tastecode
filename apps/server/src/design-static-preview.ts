import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import path from 'node:path'
import { assertSinglePageHeading, type PreviewPlan } from '@harness/design-agent'
import { assertPublicWorkspaceFile, existingWorkspacePath } from './api-workspace-paths.js'

type StaticPlan = Extract<PreviewPlan, { kind: 'static' }>

const CONTENT_TYPES = new Map([
  ['.avif', 'image/avif'],
  ['.css', 'text/css; charset=utf-8'],
  ['.gif', 'image/gif'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.otf', 'font/otf'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.ttf', 'font/ttf'],
  ['.webp', 'image/webp'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
])

export async function startStaticDesignPreview(root: string, plan: StaticPlan) {
  const previewUrl = new URL(plan.url)
  assertSinglePageHeading(
    readFileSync(requestFile(root, plan.entry, previewUrl.pathname, previewUrl.pathname), 'utf8'),
  )
  const previewId = randomUUID()
  const server = createServer((request, response) => {
    response.setHeader('x-harness-preview-id', previewId)
    response.setHeader('cache-control', 'no-store')
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.statusCode = 405
      return response.end()
    }
    try {
      const file = requestFile(root, plan.entry, previewUrl.pathname, request.url)
      response.setHeader('content-type', CONTENT_TYPES.get(path.extname(file).toLowerCase())!)
      response.setHeader('x-content-type-options', 'nosniff')
      response.end(request.method === 'HEAD' ? undefined : readFileSync(file))
    } catch {
      response.statusCode = 404
      response.end('Not found')
    }
  })
  await listen(server, Number(previewUrl.port))
  try {
    const response = await fetch(plan.url, { signal: AbortSignal.timeout(1_000) })
    if (!response.ok || response.headers.get('x-harness-preview-id') !== previewId) {
      throw new Error('Harness static preview ownership check failed')
    }
  } catch (error) {
    await close(server)
    throw error
  }
  return {
    url: plan.url,
    viewports: plan.viewports,
    output: () => `Harness static preview at ${plan.url}`,
    stop: () => close(server),
  }
}

function requestFile(root: string, entry: string, base: string, requestUrl = '/'): string {
  const pathname = decodeURIComponent(new URL(requestUrl, 'http://127.0.0.1').pathname)
  if (!pathname.startsWith(base)) throw new Error('outside preview path')
  const suffix = pathname.slice(base.length)
  if (suffix.includes('\\')) throw new Error('invalid preview path')
  const relative = suffix ? suffix.split('/').join(path.sep) : entry
  const file = existingWorkspacePath(root, relative, false)
  assertPublicWorkspaceFile(file)
  if (!CONTENT_TYPES.has(path.extname(file).toLowerCase())) throw new Error('unsupported file type')
  return file
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error)
    server.once('error', onError)
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      server.off('error', onError)
      resolve()
    })
  })
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()))
}
