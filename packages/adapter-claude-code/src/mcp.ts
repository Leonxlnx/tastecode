import type { McpServerConfig as ClaudeMcpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import type { McpConfigValue, McpServerConfig } from '@harness/contracts'
import { validateClaudeMcpServer } from './capabilities.js'

/** Real config travels only on the SDK control stream, after empty ids reserve precedence. */
export function prepareClaudeMcpServers(
  servers: McpServerConfig[],
  credentials: Record<string, string>,
) {
  const configured: Array<[string, ClaudeMcpServerConfig]> = []
  const secrets = new Set<string>()
  const ids = new Set<string>()

  const resolve = (value: McpConfigValue): string => {
    let resolved: string
    if (value.source === 'literal') resolved = value.value
    else {
      const credential = Object.hasOwn(credentials, value.credentialRef)
        ? credentials[value.credentialRef]
        : undefined
      if (!credential) throw new Error(`MCP credential "${value.credentialRef}" is unavailable`)
      resolved = credential
      secrets.add(credential)
    }
    if (resolved.includes('\0'))
      throw new Error('MCP environment and header values cannot contain null bytes')
    return resolved
  }

  for (const server of servers) {
    validateClaudeMcpServer(server)
    if (ids.has(server.id)) throw new Error(`Duplicate MCP server id "${server.id}"`)
    ids.add(server.id)
    const transport = server.transport
    if (transport.type === 'stdio') {
      configured.push([
        server.id,
        {
          type: 'stdio',
          command: transport.command,
          args: transport.args ?? [],
          env: Object.fromEntries(
            Object.entries(transport.environment ?? {}).map(([key, value]) => [
              key,
              resolve(value),
            ]),
          ),
        },
      ])
    } else {
      configured.push([
        server.id,
        {
          type: 'http',
          url: transport.url,
          headers: Object.fromEntries(
            Object.entries(transport.headers ?? {}).map(([key, value]) => [key, resolve(value)]),
          ),
        },
      ])
    }
  }
  const prepared = Object.fromEntries(configured)
  // A credential copied into a command still becomes the MCP child's argv; a URL can
  // expose it in logs or redirects. These fields never accept credential values.
  const metadata = configured
    .flatMap(([id, config]) => {
      if (config.type === 'http') {
        const url = new URL(config.url)
        return [
          id,
          config.url,
          url.username,
          url.password,
          url.pathname,
          url.hash,
          ...url.searchParams.values(),
        ]
      }
      return config.type === 'stdio' ? [id, config.command, ...(config.args ?? [])] : [id]
    })
    .flatMap((value) => {
      try {
        return [value, decodeURIComponent(value)]
      } catch {
        return [value]
      }
    })
  if (
    secretVariants([...secrets]).some((secret) => metadata.some((value) => value.includes(secret)))
  )
    throw new Error(
      'MCP credentials cannot appear in commands, arguments, or URLs. Use credential-backed environment or header fields.',
    )
  return {
    servers: prepared,
    secrets: [...secrets],
  }
}

function secretVariants(secrets: readonly string[]): string[] {
  return [
    ...new Set(
      secrets.flatMap((secret) => {
        const values = [secret, JSON.stringify(secret).slice(1, -1)]
        try {
          values.push(encodeURIComponent(secret))
        } catch {
          /* Raw and JSON forms still redact invalid Unicode. */
        }
        return values
      }),
    ),
  ]
    .filter(Boolean)
    .sort((left, right) => right.length - left.length)
}

/** Each process keeps its own redactor until stderr closes, including across restarts. */
export class ClaudeMcpRedactor {
  readonly #secrets: string[]
  readonly #holdback: number
  #pending = ''

  constructor(secrets: readonly string[] = []) {
    this.#secrets = secretVariants(secrets)
    this.#holdback = Math.max(0, ...this.#secrets.map((secret) => secret.length - 1))
  }

  redact(text: string): string {
    for (const secret of this.#secrets) text = text.replaceAll(secret, '[REDACTED]')
    return text
  }

  push(chunk: string): string {
    const safe = this.redact(this.#pending + chunk)
    const end = Math.max(0, safe.length - this.#holdback)
    this.#pending = safe.slice(end)
    return safe.slice(0, end)
  }

  finish(): string {
    const safe = this.redact(this.#pending)
    this.#pending = ''
    return safe
  }
}
