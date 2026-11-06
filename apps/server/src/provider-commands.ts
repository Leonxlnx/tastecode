/**
 * The CLI each built-in provider runs. providers.ts declares its probes with these, and the
 * executable-path overrides read them here, without loading the probes: the server imports
 * providers.ts lazily, and this module is on its startup path.
 */
export const PROVIDER_COMMANDS = {
  'claude-code': 'claude',
  codex: 'codex',
  grok: 'grok',
  cursor: 'cursor-agent',
  opencode: 'opencode',
  antigravity: 'agy',
  pi: 'pi',
} as const

/** The CLI command a built-in provider runs; undefined for one that runs none. */
export function providerCommand(provider: string): string | undefined {
  return Object.hasOwn(PROVIDER_COMMANDS, provider)
    ? PROVIDER_COMMANDS[provider as keyof typeof PROVIDER_COMMANDS]
    : undefined
}
