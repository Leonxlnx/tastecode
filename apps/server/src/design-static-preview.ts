import { randomUUID } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import path from 'node:path'
import type { PreviewPlan } from '@harness/design-agent'
import { parse, type DefaultTreeAdapterTypes } from 'parse5'
import { assertPublicWorkspaceFile, existingWorkspacePath } from './api-workspace-paths.js'

type StaticPlan = Extract<PreviewPlan, { kind: 'static' }>
const MAX_MARKUP_BYTES = 2 * 1024 * 1024
const MAX_MARKUP_NODES = 50_000
const MAX_MARKUP_RESOURCES = 4_096

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
      if (path.extname(file).toLowerCase() === '.html' && statSync(file).size > MAX_MARKUP_BYTES) {
        response.statusCode = 413
        return response.end('Static preview HTML exceeds the 2 MiB limit')
      }
      response.setHeader('content-type', CONTENT_TYPES.get(path.extname(file).toLowerCase())!)
      response.setHeader('x-content-type-options', 'nosniff')
      response.end(request.method === 'HEAD' ? undefined : readFileSync(file))
    } catch {
      response.statusCode = 404
      response.end('Not found')
    }
  })
  try {
    await listen(server, Number(previewUrl.port))
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EADDRINUSE') throw error
    // The OS assigns an unused port atomically when concurrent sites choose the same one.
    await listen(server, 0)
  }
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Static preview has no TCP address')
  previewUrl.port = String(address.port)
  const url = previewUrl.href
  try {
    const response = await fetch(url, {
      headers: { connection: 'close' },
      signal: AbortSignal.timeout(1_000),
    })
    if (!response.ok || response.headers.get('x-harness-preview-id') !== previewId) {
      throw new Error('TasteCode static preview ownership check failed')
    }
    assertMarkupResources(root, { ...plan, url }, await response.text())
  } catch (error) {
    await close(server)
    throw error
  }
  return {
    url,
    viewports: plan.viewports,
    output: () => `TasteCode static preview at ${url}`,
    stop: () => close(server),
  }
}

const RESOURCE_ATTRIBUTES = new Map<string, readonly string[]>([
  ['audio', ['src']],
  ['img', ['src']],
  ['image', ['href']],
  ['script', ['src']],
  ['source', ['src']],
  ['video', ['poster', 'src']],
])
const SRCSET_ELEMENTS = new Set(['img', 'source'])

function assertMarkupResources(root: string, plan: StaticPlan, html: string): void {
  if (Buffer.byteLength(html) > MAX_MARKUP_BYTES)
    throw new Error('static preview HTML is too large')
  const previewUrl = new URL(plan.url)
  const document = parse(html)
  const documentBase = findBaseUrl(document, previewUrl)
  for (const reference of markupResourceReferences(document)) {
    if (reference.startsWith('#')) continue
    let resource: URL
    try {
      resource = new URL(reference, documentBase)
    } catch {
      continue
    }
    if (resource.origin !== previewUrl.origin) continue
    try {
      requestFile(root, plan.entry, previewUrl.pathname, resource.href)
    } catch {
      throw new Error(`static preview resource is unavailable: ${reference.slice(0, 500)}`)
    }
  }
}

function findBaseUrl(document: DefaultTreeAdapterTypes.Document, previewUrl: URL): URL {
  for (const element of elements(document)) {
    if (element.tagName !== 'base') continue
    const href = attribute(element, 'href')
    if (href !== undefined) {
      try {
        return new URL(href, previewUrl)
      } catch {
        return previewUrl
      }
    }
  }
  return previewUrl
}

function markupResourceReferences(document: DefaultTreeAdapterTypes.Document): Set<string> {
  const references = new Set<string>()
  for (const element of elements(document)) {
    const names = RESOURCE_ATTRIBUTES.get(element.tagName)
    for (const name of names ?? []) {
      const value =
        attribute(element, name) ??
        (element.tagName === 'image' && name === 'href'
          ? element.attrs.find(
              (value) =>
                value.name === 'href' && value.namespace === 'http://www.w3.org/1999/xlink',
            )?.value
          : undefined)
      if (value) references.add(value)
    }
    if (SRCSET_ELEMENTS.has(element.tagName)) {
      for (const value of parseSrcset(attribute(element, 'srcset') ?? '')) references.add(value)
    }
    if (
      element.tagName === 'link' &&
      attribute(element, 'rel')
        ?.toLowerCase()
        .split(/\s+/)
        .some((rel) => ['stylesheet', 'icon', 'preload', 'modulepreload'].includes(rel))
    ) {
      const href = attribute(element, 'href')
      if (href) references.add(href)
      if (
        attribute(element, 'as')?.toLowerCase() === 'image' &&
        attribute(element, 'rel')?.toLowerCase().split(/\s+/).includes('preload')
      ) {
        for (const value of parseSrcset(attribute(element, 'imagesrcset') ?? ''))
          references.add(value)
      }
    }
    if (references.size > MAX_MARKUP_RESOURCES) {
      throw new Error('static preview has too many markup resources')
    }
  }
  return references
}

function parseSrcset(value: string): string[] {
  const references: string[] = []
  let position = 0
  while (position < value.length) {
    while (/[\s,]/.test(value[position] ?? '')) position += 1
    const start = position
    while (position < value.length && !/\s/.test(value[position] ?? '')) position += 1
    const token = value.slice(start, position)
    const reference = token.replace(/,+$/, '')
    if (reference) references.push(reference)
    // A trailing comma finishes a candidate with no descriptor. Do not consume
    // the next candidate as though it were the current candidate's descriptor.
    if (token.endsWith(',')) continue
    let parentheses = 0
    while (position < value.length) {
      const character = value[position]
      position += 1
      if (character === '(') parentheses += 1
      if (character === ')') parentheses = Math.max(0, parentheses - 1)
      if (character === ',' && parentheses === 0) break
    }
  }
  return references
}

function* elements(
  node: DefaultTreeAdapterTypes.ParentNode,
): Generator<DefaultTreeAdapterTypes.Element> {
  const pending = [...node.childNodes].reverse()
  let count = 0
  while (pending.length > 0) {
    if (++count > MAX_MARKUP_NODES) throw new Error('static preview has too many markup nodes')
    const child = pending.pop()!
    if ('tagName' in child) yield child
    if ('childNodes' in child) pending.push(...[...child.childNodes].reverse())
  }
}

function attribute(element: DefaultTreeAdapterTypes.Element, name: string): string | undefined {
  return element.attrs.find((value) => value.name === name && !value.namespace)?.value
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
