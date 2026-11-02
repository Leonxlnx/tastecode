/** The packaged renderer's build-time CSP and socket use the same endpoint. */
export function ownedServerEnvironment(
  inherited: NodeJS.ProcessEnv,
  rendererHtml?: string,
): NodeJS.ProcessEnv {
  if (rendererHtml === undefined) return { ...inherited, HARNESS_RENDERER_ORIGIN: 'file://' }
  const meta = rendererHtml.match(
    /<meta\b[^>]*http-equiv=["']Content-Security-Policy["'][^>]*>/i,
  )?.[0]
  const policy = meta?.match(/\bcontent=(["'])(.*?)\1/is)?.[2]
  const connect = policy?.match(/(?:^|;)\s*connect-src\s+([^;]+)/i)?.[1]
  const endpoints = connect?.split(/\s+/).filter((source) => /^wss?:/.test(source)) ?? []
  if (endpoints.length !== 1) throw new Error('The packaged renderer has no local server endpoint.')
  const url = new URL(endpoints[0]!)
  if (
    url.protocol !== 'ws:' ||
    url.hostname !== '127.0.0.1' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error('The packaged renderer must use a loopback server endpoint.')
  }
  return {
    ...inherited,
    HARNESS_HOST: '127.0.0.1',
    HARNESS_PORT: url.port || '80',
    HARNESS_RENDERER_ORIGIN: 'file://',
  }
}

/**
 * What the server needs to describe and reach the feedback inbox. Only the
 * path of the packaged endpoint file is passed, never the key itself, and an
 * inherited value wins so a maintainer can point a build at another inbox.
 */
export function withFeedbackDetails(
  env: NodeJS.ProcessEnv,
  details: { appVersion: string; feedbackConfig?: string | undefined },
): NodeJS.ProcessEnv {
  return {
    ...env,
    HARNESS_APP_VERSION: details.appVersion,
    ...(details.feedbackConfig && !env['TASTECODE_FEEDBACK_CONFIG']
      ? { TASTECODE_FEEDBACK_CONFIG: details.feedbackConfig }
      : {}),
  }
}

/**
 * Where the server finds the Agent Skills that ship with the app. A packaged
 * build keeps them as real files in its resources folder so agent processes
 * can read them; an unpackaged run leaves the server to find the workspace copy.
 */
export function withDefaultSkills(
  env: NodeJS.ProcessEnv,
  directory: string | undefined,
): NodeJS.ProcessEnv {
  return directory ? { ...env, HARNESS_DEFAULT_SKILLS_DIR: directory } : env
}

export type BuildEdition = 'release' | 'dev'

/**
 * Which providers a packaged build offers, from the `tastecodeEdition` field
 * electron-builder writes into the packaged package.json. Only the dev scripts
 * set it, so a package built any other way, or with a value we do not know,
 * is a release build.
 */
export function packagedEdition(packageJson: { tastecodeEdition?: unknown }): BuildEdition {
  return packageJson.tastecodeEdition === 'dev' ? 'dev' : 'release'
}

/**
 * Hands the build's edition to the server. Applied after the inherited
 * environment, unlike the feedback endpoint, so a variable set on the machine
 * cannot widen a release build. An unpackaged run passes nothing and keeps
 * whatever the developer set.
 */
export function withEdition(
  env: NodeJS.ProcessEnv,
  edition: BuildEdition | undefined,
): NodeJS.ProcessEnv {
  return edition ? { ...env, HARNESS_EDITION: edition } : env
}
