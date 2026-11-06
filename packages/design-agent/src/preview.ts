import { boundedInteger, optionalString, record, string, stringsAllowEmpty } from './parse.js'
import { parsePhaseJson } from './phase-json.js'
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

Existing app: {"version":1,"kind":"command","command":"pnpm","args":["dev","--host","127.0.0.1","--port","5173"],"cwd":".","url":"http://127.0.0.1:5173","readyPattern":"optional output text","viewports":[{"name":"desktop","width":1440,"height":1000},{"name":"mobile","width":390,"height":844}]}

Static files: {"version":1,"kind":"static","entry":"index.html","cwd":".","url":"http://127.0.0.1:4173/","viewports":[{"name":"desktop","width":1440,"height":1000},{"name":"mobile","width":390,"height":844}]}`

/** Enough of Build's file list to name the page; a long list only repeats assets. */
const PREVIEW_BUILD_FILES = 40

/**
 * Build's own file list points Preview at the page this run made. Without it a project that
 * keeps a legacy prototype at its root previewed that prototype, which its AGENTS.md put out of
 * scope, and Review could not judge or repair the real screens (#2193).
 */
function previewTarget(buildFiles: readonly string[]): string {
  const listed = buildFiles.slice(0, PREVIEW_BUILD_FILES)
  const files = listed.length
    ? ` Build reported these files: ${listed.join(', ')}${buildFiles.length > listed.length ? `, and ${buildFiles.length - listed.length} more` : ''}.`
    : ''
  return `Preview the page this Design run built.${files} Point the plan at the page that renders them: a static entry, or the command's url with that page's path (for example http://127.0.0.1:3000/portal.html). Do not preview another page the project also keeps, such as a legacy prototype or a demo, only because it is the root page or the default script. Follow the project's own instructions (AGENTS.md, CLAUDE.md, README) on which screens are current and how they are served; when they are served by a launcher TasteCode cannot run and are plain HTML, use a static plan with that page as its entry.`
}

export function designPreviewPrompt(buildFiles: readonly string[] = []): string {
  return `You are running the Preview Setup phase of TasteCode Design Mode.

Inspect the implemented project's real package scripts and configuration. Choose the existing development or preview command that serves the built page on 127.0.0.1 with an explicit port. Do not install dependencies, start the server yourself, use a shell string, or choose a remote URL. The command is an executable name and args is its argv array. cwd is relative to the current workspace.

${previewTarget(buildFiles)}

TasteCode automatically chooses another free port when the requested one is occupied and reports the actual preview URL. For package scripts, include the supported --port or -p option in args (and npm's -- separator); TasteCode updates that value and sets the PORT environment variable. A custom node server should read process.env.PORT. Do not hardcode the only usable port in a server script or require stopping another project's preview.

Match the project's package manager instead of copying the example: package-lock.json means npm, pnpm-lock.yaml means pnpm, yarn.lock means yarn, and bun.lock or bun.lockb means bun. When the project has no package-manager lockfile, prefer a static plan for plain HTML or the package manager already named by the project's scripts or packageManager field. Never invoke another package manager against an existing install because it may rewrite node_modules or stall Preview while reinstalling dependencies.

For an existing app, use kind command. TasteCode executes only these commands: bun, node, npm, pnpm, yarn. Anything else — npx, python, deno, a path to a binary — is rejected. A package-manager command must run a script that exists in the workspace's package.json; a node command must point at a script file inside the workspace.

For a static-file project with no existing preview script, use kind static and name its HTML entry file. TasteCode serves static projects itself. Do not create a server script or package manifest.

Include one representative desktop viewport and one representative mobile viewport. Use readyPattern only when the command has a stable output fragment that indicates readiness. TasteCode will validate and execute this plan.

${PREVIEW_PROTOCOL}`
}

export function parsePreviewPhaseOutput(text: string): PreviewPlan {
  const plan = parsePreviewPlan(parsePhaseJson(text))
  assertReviewViewports(plan.viewports)
  return plan
}

export function assertReviewViewports(
  viewports: readonly { width: number; height: number }[],
): void {
  if (
    !viewports.some(({ width }) => width >= 1_024) ||
    !viewports.some(({ width }) => width >= 320 && width <= 600)
  ) {
    throw new Error(
      'Design visual review requires both a desktop viewport (at least 1024px) and a mobile viewport (320–600px)',
    )
  }
}

export function parsePreviewPlan(value: unknown): PreviewPlan {
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
    ...(readyPattern ? { readyPattern } : {}),
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

/** Kept in sync with the runner's allowlist. Rejecting here, at parse time,
 *  turns a wrong choice into a correctable validation error instead of a
 *  hard flow failure when the plan is executed. */
const ALLOWED_COMMANDS = new Set(['bun', 'node', 'npm', 'pnpm', 'yarn'])

function executable(value: unknown): string {
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

function relativePath(value: unknown, field: string): string {
  const result = string(value, field)
  if (/^(?:[a-z]:|[\\/])/i.test(result) || result.split(/[\\/]/).includes('..')) {
    throw new Error(`${field} must stay inside the workspace`)
  }
  return result
}

function dimension(value: unknown, minimum: number, maximum: number, field: string): number {
  const result = boundedInteger(value, minimum, maximum)
  if (result === undefined) {
    throw new Error(`${field} must be an integer between ${minimum} and ${maximum}`)
  }
  return result
}
