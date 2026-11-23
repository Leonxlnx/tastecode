import type { SimulatorHubAccess, SimulatorPlatform } from '@harness/contracts'

export type SimulatorAxElement = {
  readonly id: string
  readonly label: string
  readonly role: string
  /** Normalized 0..1 coordinates in the displayed screen. */
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export type SimulatorFrameSize = {
  readonly width: number
  readonly height: number
}

const AX_ELEMENT_LIMIT = 500

export function withHubTicket(url: string, ticket: string): string {
  const separator = url.includes('?') ? '&' : '?'
  return `${url}${separator}ticket=${encodeURIComponent(ticket)}`
}

export type SimulatorFrameInsets =
  | number
  | {
      readonly top: number
      readonly right: number
      readonly bottom: number
      readonly left: number
    }

export function fitSimulatorFrame(
  aspect: number,
  hostWidth: number,
  hostHeight: number,
  insets: SimulatorFrameInsets = 24,
): SimulatorFrameSize {
  const top = typeof insets === 'number' ? insets : insets.top
  const right = typeof insets === 'number' ? insets : insets.right
  const bottom = typeof insets === 'number' ? insets : insets.bottom
  const left = typeof insets === 'number' ? insets : insets.left
  const availableWidth = Math.max(0, hostWidth - left - right)
  const availableHeight = Math.max(0, hostHeight - top - bottom)
  if (availableWidth === 0 || availableHeight === 0 || !Number.isFinite(aspect) || aspect <= 0) {
    return { width: 0, height: 0 }
  }
  const heightFromWidth = availableWidth / aspect
  if (heightFromWidth <= availableHeight) {
    return { width: Math.floor(availableWidth), height: Math.floor(heightFromWidth) }
  }
  return { width: Math.floor(availableHeight * aspect), height: Math.floor(availableHeight) }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function flattenIosAxTree(roots: readonly unknown[]): SimulatorAxElement[] {
  const first = roots[0]
  const rootFrame = isRecord(first) && isRecord(first['frame']) ? first['frame'] : null
  const screenWidth = Math.max(1, numberOr(rootFrame?.['width'], 1))
  const screenHeight = Math.max(1, numberOr(rootFrame?.['height'], 1))
  const elements: SimulatorAxElement[] = []
  const visit = (node: unknown, nodePath: string) => {
    if (elements.length >= AX_ELEMENT_LIMIT || !isRecord(node) || !isRecord(node['frame'])) return
    const frame = node['frame']
    const width = numberOr(frame['width'], 0)
    const height = numberOr(frame['height'], 0)
    const coversScreen =
      Math.abs(width - screenWidth) < 0.5 && Math.abs(height - screenHeight) < 0.5
    if (!coversScreen && width > 0 && height > 0) {
      elements.push({
        id: typeof node['AXUniqueId'] === 'string' ? node['AXUniqueId'] : nodePath,
        label: typeof node['AXLabel'] === 'string' ? node['AXLabel'] : '',
        role: typeof node['type'] === 'string' ? node['type'] : '',
        x: numberOr(frame['x'], 0) / screenWidth,
        y: numberOr(frame['y'], 0) / screenHeight,
        width: width / screenWidth,
        height: height / screenHeight,
      })
    }
    const children = Array.isArray(node['children']) ? node['children'] : []
    children.forEach((child, index) => visit(child, `${nodePath}.${index}`))
  }
  roots.forEach((root, index) => visit(root, String(index)))
  return elements
}

export async function fetchSimulatorAxTree(
  access: SimulatorHubAccess,
  platform: SimulatorPlatform,
  deviceId: string,
  signal?: AbortSignal,
): Promise<SimulatorAxElement[]> {
  const path =
    platform === 'ios'
      ? `/vendor/serve-sim/helper/${encodeURIComponent(deviceId)}/ax`
      : `/vendor/serve-emu/api/accessibility?device=${encodeURIComponent(deviceId)}`
  const response = await fetch(withHubTicket(`${access.httpBase}${path}`, access.ticket), {
    cache: 'no-store',
    ...(signal ? { signal } : {}),
  })
  if (!response.ok) throw new Error(`Accessibility request failed (${response.status}).`)
  const payload: unknown = await response.json()
  if (platform === 'ios') {
    if (!Array.isArray(payload)) return []
    return flattenIosAxTree(payload)
  }
  if (!isRecord(payload) || !Array.isArray(payload['nodes'])) return []
  const screenObj = isRecord(payload['screen']) ? payload['screen'] : null
  let maxRight = 0
  let maxBottom = 0
  for (const node of payload['nodes']) {
    if (!isRecord(node) || !isRecord(node['bounds'])) continue
    maxRight = Math.max(maxRight, numberOr(node['bounds']['right'], 0))
    maxBottom = Math.max(maxBottom, numberOr(node['bounds']['bottom'], 0))
  }
  const screenWidth = Math.max(
    1,
    numberOr(screenObj?.['width'], numberOr(payload['width'], maxRight > 0 ? maxRight : 1080)),
  )
  const screenHeight = Math.max(
    1,
    numberOr(screenObj?.['height'], numberOr(payload['height'], maxBottom > 0 ? maxBottom : 2400)),
  )
  const elements: SimulatorAxElement[] = []
  for (
    let index = 0;
    index < payload['nodes'].length && elements.length < AX_ELEMENT_LIMIT;
    index++
  ) {
    const node = payload['nodes'][index]
    if (!isRecord(node)) continue
    const bounds = isRecord(node['bounds']) ? node['bounds'] : null
    if (!bounds) continue
    const left = numberOr(bounds['left'], 0)
    const top = numberOr(bounds['top'], 0)
    const right = numberOr(bounds['right'], 0)
    const bottom = numberOr(bounds['bottom'], 0)
    const width = right - left
    const height = bottom - top
    if (width <= 0 || height <= 0) continue
    if (Math.abs(width - screenWidth) < 1 && Math.abs(height - screenHeight) < 1) continue
    const label =
      (typeof node['text'] === 'string' && node['text']) ||
      (typeof node['contentDescription'] === 'string' && node['contentDescription']) ||
      (typeof node['contentDesc'] === 'string' && node['contentDesc']) ||
      ''
    elements.push({
      id:
        typeof node['resourceId'] === 'string' && node['resourceId']
          ? `${node['resourceId']}-${index}`
          : `ax-${index}`,
      label,
      role: typeof node['className'] === 'string' ? node['className'] : '',
      x: left / screenWidth,
      y: top / screenHeight,
      width: width / screenWidth,
      height: height / screenHeight,
    })
  }
  return elements
}

export class SimulatorScreenshotError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'SimulatorScreenshotError'
  }
}

export async function captureSimulatorScreenshot(
  access: SimulatorHubAccess,
  platform: SimulatorPlatform,
  deviceId: string,
  signal?: AbortSignal,
): Promise<Blob> {
  const vendor = platform === 'ios' ? '/vendor/serve-sim' : '/vendor/serve-emu'
  const url = withHubTicket(
    `${access.httpBase}${vendor}/api/screenshot?device=${encodeURIComponent(deviceId)}`,
    access.ticket,
  )
  const response = await fetch(url, {
    method: 'POST',
    cache: 'no-store',
    ...(signal ? { signal } : {}),
  })
  if (!response.ok) {
    throw new SimulatorScreenshotError(
      `Screenshot failed (HTTP ${response.status}).`,
      response.status,
    )
  }
  return response.blob()
}
