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

const PREVIEW_PROTOCOL = `Return the preview plan as JSON only, without Markdown fences:

{"version":1,"command":"pnpm","args":["dev","--host","127.0.0.1"],"cwd":".","url":"http://127.0.0.1:5173","readyPattern":"optional output text","viewports":[{"name":"desktop","width":1440,"height":1000},{"name":"mobile","width":390,"height":844}]}`

export function designPreviewPrompt(): string {
  return `You are running the Preview Setup phase of Personal Harness Design Mode.

Inspect the implemented project's real package scripts and configuration. Choose the existing development or preview command that serves the built page on 127.0.0.1 with an explicit port. Do not install dependencies, edit files, start the server, use a shell string, or choose a remote URL. The command is an executable name and args is its argv array. cwd is relative to the current workspace.

Include one representative desktop viewport and one representative mobile viewport. Use readyPattern only when the command has a stable output fragment that indicates readiness. Personal Harness will validate and execute this plan.

${PREVIEW_PROTOCOL}`
}

export function parsePreviewPhaseOutput(text: string): PreviewPlan {
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text.trim())
  return parsePreviewPlan(JSON.parse(fenced?.[1] ?? text))
}

export function parsePreviewPlan(value: unknown): PreviewPlan {
  const plan = record(value, 'preview plan')
  if (plan.version !== 1) throw new Error('preview plan version must be 1')
  const url = localUrl(plan.url)
  const readyPattern = optionalString(plan.readyPattern, 'preview readyPattern')
  if (!Array.isArray(plan.viewports) || plan.viewports.length === 0 || plan.viewports.length > 4) {
    throw new Error('preview viewports must contain between one and four entries')
  }
  const viewports = plan.viewports.map((value, index) => {
    const viewport = record(value, `preview viewports[${index}]`)
    return {
      name: string(viewport.name, `preview viewports[${index}].name`),
      width: dimension(viewport.width, 320, 3_840, `preview viewports[${index}].width`),
      height: dimension(viewport.height, 240, 2_160, `preview viewports[${index}].height`),
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

function dimension(value: unknown, minimum: number, maximum: number, field: string): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${field} must be an integer between ${minimum} and ${maximum}`)
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
