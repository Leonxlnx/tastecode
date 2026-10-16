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
