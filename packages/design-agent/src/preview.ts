import { propertiesWhen } from './properties-when.js'
import {
  boundedInteger,
  type BoundaryValue,
  optionalString,
  record,
  string,
  stringsAllowEmpty,
} from './parse.js'
interface PreviewPlanBase {
  version: 1
  cwd: string
  url: string
  viewports: Array<{
    name: string
    width: number
    height: number
  }>
}

export type PreviewPlan =
  | (PreviewPlanBase & {
      kind: 'command'
      command: string
      args: string[]
      readyPattern?: string
    })
  | (PreviewPlanBase & { kind: 'static'; entry: string })

const PREVIEW_PROTOCOL = `Return the preview plan as JSON only, without Markdown fences:

Existing app: {"version":1,"kind":"command","command":"pnpm","args":["dev","--host","127.0.0.1"],"cwd":".","url":"http://127.0.0.1:5173","readyPattern":"optional output text","viewports":[{"name":"desktop","width":1440,"height":1000},{"name":"mobile","width":390,"height":844}]}

Static files: {"version":1,"kind":"static","entry":"index.html","cwd":".","url":"http://127.0.0.1:4173/","viewports":[{"name":"desktop","width":1440,"height":1000},{"name":"mobile","width":390,"height":844}]}`

export function designPreviewPrompt(): string {
  return `You are running the Preview Setup phase of TasteCode Design Mode.

Inspect the implemented project's real package scripts and configuration. Choose the existing development or preview command that serves the built page on 127.0.0.1 with an explicit port. Do not install dependencies, start the server yourself, use a shell string, or choose a remote URL. The command is an executable name and args is its argv array. cwd is relative to the current workspace.

Match the project's package manager instead of copying the example: package-lock.json means npm, pnpm-lock.yaml means pnpm, yarn.lock means yarn, and bun.lock or bun.lockb means bun. When the project has no package-manager lockfile, prefer a static plan for plain HTML or the package manager already named by the project's scripts or packageManager field. Never invoke another package manager against an existing install because it may rewrite node_modules or stall Preview while reinstalling dependencies.

For an existing app, use kind command. TasteCode executes only these commands: bun, node, npm, pnpm, yarn. Anything else — npx, python, deno, a path to a binary — is rejected. A package-manager command must run a script that exists in the workspace's package.json; a node command must point at a script file inside the workspace.

For a static-file project with no existing preview script, use kind static and name its HTML entry file. TasteCode serves static projects itself. Do not create a server script or package manifest.

Include one representative desktop viewport and one representative mobile viewport. Use readyPattern only when the command has a stable output fragment that indicates readiness. TasteCode will validate and execute this plan.

${PREVIEW_PROTOCOL}`
}

export function parsePreviewPhaseOutput(text: string): PreviewPlan {
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text.trim())
  return parsePreviewPlan(JSON.parse(fenced?.[1] ?? text))
}

export function parsePreviewPlan(value: BoundaryValue): PreviewPlan {
  const plan = record(value, 'preview plan')
  if (plan.version !== 1) throw new Error('preview plan version must be 1')
  const url = localUrl(plan.url)
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
  if (
    new Set(viewports.map((viewport) => `${viewport.width}x${viewport.height}`)).size !==
    viewports.length
  ) {
    throw new Error('preview viewport dimensions must be unique')
  }

  const shared = {
    version: 1,
    cwd: relativePath(plan.cwd, 'preview cwd'),
    url,
    viewports,
  } as const
  if (plan.kind === 'static') {
    if (!new URL(url).pathname.endsWith('/')) {
      throw new Error('static preview url must end with /')
    }
    return {
      ...shared,
      kind: 'static',
      entry: relativePath(plan.entry, 'preview static entry'),
    }
  }
  if (plan.kind !== undefined && plan.kind !== 'command') {
    throw new Error('preview kind must be command or static')
  }
  const readyPattern = optionalString(plan.readyPattern, 'preview readyPattern')
  return {
    ...shared,
    kind: 'command',
    command: executable(plan.command),
    args: stringsAllowEmpty(plan.args, 'preview args'),
    ...propertiesWhen(readyPattern, (readyPattern) => ({ readyPattern })),
  }
}

function localUrl(value: BoundaryValue): string {
  const result = new URL(string(value, 'preview url'))
  if (result.protocol !== 'http:' || result.hostname !== '127.0.0.1') {
    throw new Error('preview url must use http://127.0.0.1')
  }
  if (!result.port) throw new Error('preview url must contain an explicit port')
  return result.href
}

/** Kept in sync with the runner's allowlist. Rejecting here, at parse time,
 *  turns a wrong choice into a correctable validation error instead of a
 *  hard flow failure when the plan is executed. */
const ALLOWED_COMMANDS = new Set(['bun', 'node', 'npm', 'pnpm', 'yarn'])

function executable(value: BoundaryValue): string {
  const result = string(value, 'preview command')
  if (result.includes('/') || result.includes('\\') || /[\s;&|<>]/.test(result)) {
    throw new Error('preview command must be an executable name')
  }
  if (!ALLOWED_COMMANDS.has(result)) {
    throw new Error(
      `preview command must be one of ${[...ALLOWED_COMMANDS].join(', ')} — "${result}" is not executed`,
    )
  }
  return result
}

function relativePath(value: BoundaryValue, field: string): string {
  const result = string(value, field)
  if (/^(?:[a-z]:|[\\/])/i.test(result) || result.split(/[\\/]/).includes('..')) {
    throw new Error(`${field} must stay inside the workspace`)
  }
  return result
}

function dimension(value: BoundaryValue, minimum: number, maximum: number, field: string): number {
  const result = boundedInteger(value, minimum, maximum)
  if (result === undefined) {
    throw new Error(`${field} must be an integer between ${minimum} and ${maximum}`)
  }
  return result
}
