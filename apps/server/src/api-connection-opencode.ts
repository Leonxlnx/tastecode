import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type {
  ModelConnectionPreset,
  ModelTransport,
  StoredModelConnection,
} from '@harness/contracts'

/**
 * A direct API connection runs on OpenCode with the user's key. Each preset
 * uses OpenCode's own provider id, so its catalog names the models and knows
 * their context windows; a custom endpoint gets a provider of its own.
 */
const PRESET_PROVIDERS = {
  openai: 'openai',
  anthropic: 'anthropic',
  openrouter: 'openrouter',
  kimi: 'moonshotai',
  zai: 'zai',
} as const satisfies Record<Exclude<ModelConnectionPreset, 'custom'>, string>

const CUSTOM_PROVIDER = 'tastecode'

const CUSTOM_PACKAGES = {
  'openai-compatible': '@ai-sdk/openai-compatible',
  'openai-responses': '@ai-sdk/openai',
  'anthropic-messages': '@ai-sdk/anthropic',
} as const satisfies Record<ModelTransport, string>

/** The config reads the key from here; it never appears in the config itself. */
const KEY_VARIABLE = 'TASTECODE_API_KEY'

const DISCOVERY_TIMEOUT_MS = 10_000

/** The user's own config folder, for the shell commands the agent runs. */
const ORIGINAL_CONFIG_VARIABLE = 'TASTECODE_XDG_CONFIG_HOME'

/**
 * OpenCode passes its own environment to every shell command the agent runs.
 * That would hand the key to the model on request, and point git, gh and
 * the like at OpenCode's private config folder. The `shell.env` hook cannot
 * remove a variable, but a value it sets replaces the inherited one, and an
 * empty XDG_CONFIG_HOME means "unset" to the tools that read it.
 */
const SHELL_GUARD_SOURCE = `// Written by TasteCode for API key chats: keeps the key out of the agent's
// shell commands and gives them the user's own config folder back.
export const TasteCodeShellGuard = async () => ({
  'shell.env': async (_input, output) => {
    output.env.${KEY_VARIABLE} = ''
    output.env.XDG_CONFIG_HOME = process.env.${ORIGINAL_CONFIG_VARIABLE} ?? ''
  },
})
`

export function openCodeProvider(connection: StoredModelConnection): string {
  return connection.preset === 'custom' ? CUSTOM_PROVIDER : PRESET_PROVIDERS[connection.preset]
}

/** A model as OpenCode names it: the provider, a slash, then the vendor's own id. */
export function openCodeModelId(connection: StoredModelConnection, model: string): string {
  const provider = openCodeProvider(connection)
  return model.startsWith(`${provider}/`) ? model : `${provider}/${model}`
}

/** The vendor's own id for a model, without OpenCode's provider prefix. */
export function vendorModelId(connection: StoredModelConnection, model: string): string {
  const prefix = `${openCodeProvider(connection)}/`
  return model.startsWith(prefix) ? model.slice(prefix.length) : model
}

/**
 * Only this connection's provider is enabled, so neither the user's other
 * OpenCode providers nor a key in the server's environment can run the chat.
 * The chat's model, or the connection's own, becomes OpenCode's default: a
 * turn without one would otherwise run on the user's global default. It is
 * also declared beside the catalog, where OpenCode would refuse an id it
 * does not know yet.
 */
export function openCodeConnectionConfig(
  connection: StoredModelConnection,
  shellGuard: string,
  options: { models?: readonly string[]; model?: string | undefined } = {},
) {
  const provider = openCodeProvider(connection)
  const model = options.model ?? connection.defaultModel
  const models = [
    ...new Set([...(options.models ?? []), ...(model ? [vendorModelId(connection, model)] : [])]),
  ]
  return {
    enabled_providers: [provider],
    plugin: [shellGuard],
    // OpenCode allows everything by default. Asking lets the chat's access
    // level decide: Full access approves each request, Ask shows it.
    permission: { edit: 'ask', bash: 'ask' },
    ...(model ? { model: openCodeModelId(connection, model) } : {}),
    provider: {
      [provider]: {
        ...(connection.preset === 'custom'
          ? { npm: CUSTOM_PACKAGES[connection.transport], name: connection.displayName }
          : {}),
        options: { baseURL: connection.baseUrl, apiKey: `{env:${KEY_VARIABLE}}` },
        ...(models.length > 0 ? { models: Object.fromEntries(models.map((id) => [id, {}])) } : {}),
      },
    },
  }
}

/**
 * `home` is TasteCode's OpenCode folder for API chats. The user's own OpenCode
 * setup stays out of them: its sign-ins (a ChatGPT login on the same provider
 * id would otherwise run, and bill, the chat instead of the key), its config
 * (an agent pinned to another provider's model fails every turn) and its
 * session history.
 */
export function openCodeConnectionEnvironment(apiKey: string, home: string) {
  return {
    [KEY_VARIABLE]: apiKey,
    OPENCODE_AUTH_CONTENT: '{}',
    OPENCODE_DB: path.join(home, 'sessions.db'),
    XDG_CONFIG_HOME: path.join(home, 'config'),
    [ORIGINAL_CONFIG_VARIABLE]: process.env['XDG_CONFIG_HOME'] ?? '',
  }
}

/** Writes the shell guard plugin when it is missing or stale and returns its file URL. */
export function writeShellGuard(directory: string): string {
  const file = path.join(directory, 'shell-guard.js')
  let current: string | undefined
  try {
    current = readFileSync(file, 'utf8')
  } catch {
    current = undefined
  }
  if (current !== SHELL_GUARD_SOURCE) {
    mkdirSync(directory, { recursive: true })
    writeFileSync(file, SHELL_GUARD_SOURCE)
  }
  return pathToFileURL(file).href
}

/**
 * OpenCode's catalog does not know a custom endpoint, so its models come
 * from the endpoint itself. An endpoint without a model list yields none,
 * and the connection's own model still runs.
 */
export async function listCustomModels(
  connection: StoredModelConnection,
  apiKey: string,
  request: typeof fetch = fetch,
): Promise<string[]> {
  const headers: Record<string, string> =
    connection.transport === 'anthropic-messages'
      ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
      : { authorization: `Bearer ${apiKey}` }
  try {
    const response = await request(`${connection.baseUrl.replace(/\/+$/, '')}/models`, {
      headers,
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    })
    if (!response.ok) return []
    const body: unknown = await response.json()
    const data =
      typeof body === 'object' && body !== null && 'data' in body && Array.isArray(body.data)
        ? (body.data as unknown[])
        : []
    return data.flatMap((entry) =>
      typeof entry === 'object' &&
      entry !== null &&
      'id' in entry &&
      typeof entry.id === 'string' &&
      entry.id.length > 0
        ? [entry.id]
        : [],
    )
  } catch {
    return []
  }
}
