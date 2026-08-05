export interface PreviewPlan {
  version: 1
  command: string
  args: string[]
  cwd: string
  url: string
  readyPattern?: string
  viewports: Array<{
    name: string
    width: number
    height: number
  }>
}

export function parsePreviewPlan(value: unknown): PreviewPlan {
  const plan = record(value, 'preview plan')
  if (plan.version !== 1) throw new Error('preview plan version must be 1')
  const url = localUrl(plan.url)
  const readyPattern = optionalString(plan.readyPattern, 'preview readyPattern')
  if (!Array.isArray(plan.viewports) || plan.viewports.length === 0) {
    throw new Error('preview viewports must be a non-empty array')
  }
  const viewports = plan.viewports.map((value, index) => {
    const viewport = record(value, `preview viewports[${index}]`)
    return {
      name: string(viewport.name, `preview viewports[${index}].name`),
      width: dimension(viewport.width, `preview viewports[${index}].width`),
      height: dimension(viewport.height, `preview viewports[${index}].height`),
    }
  })
  if (new Set(viewports.map((viewport) => viewport.name)).size !== viewports.length) {
    throw new Error('preview viewport names must be unique')
  }

  return {
    version: 1,
    command: executable(plan.command),
    args: strings(plan.args, 'preview args'),
    cwd: relativePath(plan.cwd),
    url,
    ...(readyPattern ? { readyPattern } : {}),
    viewports,
  }
}

function localUrl(value: unknown): string {
  const result = new URL(string(value, 'preview url'))
  if (result.protocol !== 'http:' || result.hostname !== '127.0.0.1') {
    throw new Error('preview url must use http://127.0.0.1')
  }
  if (!result.port) throw new Error('preview url must contain an explicit port')
  return result.href
}

function executable(value: unknown): string {
  const result = string(value, 'preview command')
  if (result.includes('/') || result.includes('\\') || /[\s;&|<>]/.test(result)) {
    throw new Error('preview command must be an executable name')
  }
  return result
}

function relativePath(value: unknown): string {
  const result = string(value, 'preview cwd')
  if (/^(?:[a-z]:|[\\/])/i.test(result) || result.split(/[\\/]/).includes('..')) {
    throw new Error('preview cwd must stay inside the workspace')
  }
  return result
}

function dimension(value: unknown, field: string): number {
  if (!Number.isInteger(value) || (value as number) < 240 || (value as number) > 7680) {
    throw new Error(`${field} must be an integer between 240 and 7680`)
  }
  return value as number
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be an object`)
  }
  return value as Record<string, unknown>
}

function string(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field} must be a non-empty string`)
  }
  return value
}

function optionalString(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : string(value, field)
}

function strings(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error(`${field} must be a string array`)
  }
  return value
}
