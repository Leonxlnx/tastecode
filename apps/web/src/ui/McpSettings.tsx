import { useCallback, useEffect, useState } from 'react'
import type { McpServer, McpTransport, ProviderId, ResultOf } from '@harness/contracts'
import { AlertTriangle } from 'lucide-react'
import type { Transport } from '../transport.js'

type Inventory = ResultOf<'mcp.list'>

export function McpSettings(props: {
  transport: Transport
  provider: ProviderId
  providerName: string
  projectPath: string | undefined
  projectName: string | undefined
}) {
  const [inventory, setInventory] = useState<Inventory>()
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()

  const refresh = useCallback(async () => {
    if (!props.projectPath) return
    try {
      setInventory(
        await props.transport.request('mcp.list', {
          provider: props.provider,
          projectPath: props.projectPath,
        }),
      )
      setError(undefined)
    } catch (cause) {
      setError(message(cause))
    }
  }, [props.transport, props.provider, props.projectPath])

  useEffect(() => {
    setInventory(undefined)
    if (!props.projectPath) return
    void refresh()
    return props.transport.on('mcp.oauth', (result) => {
      if (result.provider !== props.provider || result.projectPath !== props.projectPath) return
      setBusy(undefined)
      if (result.success) {
        setNotice('MCP sign-in completed.')
        setError(undefined)
        void refresh()
      } else {
        setError(result.error ?? 'MCP sign-in failed.')
      }
    })
  }, [props.transport, props.provider, props.projectPath, refresh])

  async function signIn(server: McpServer): Promise<void> {
    if (!props.projectPath) return
    setBusy(server.id)
    setError(undefined)
    try {
      const result = await props.transport.request('mcp.startOAuth', {
        provider: props.provider,
        projectPath: props.projectPath,
        serverId: server.id,
      })
      window.open(result.authUrl, '_blank', 'noopener,noreferrer')
      setNotice('Finish signing in in your browser.')
      setBusy(undefined)
    } catch (cause) {
      setError(message(cause))
      setBusy(undefined)
    }
  }

  const project = props.projectName ?? props.projectPath
  const status = !props.projectPath
    ? 'Select a project in the sidebar first.'
    : !inventory
      ? 'Loading MCP servers…'
      : !inventory.capabilities.inventory
        ? `${props.providerName} does not expose MCP servers here yet.`
        : inventory.servers.length === 0
          ? 'No MCP servers are configured for this project.'
          : undefined

  return (
    <section className="settings__panel mcp-settings" aria-labelledby="settings-mcp">
      <header className="mcp-settings__header">
        <h1 className="settings__title" id="settings-mcp">
          MCP servers
        </h1>
        <p>{project ? `Available in ${project}` : 'Choose a project to inspect its servers.'}</p>
      </header>

      {error ? (
        <p className="mcp-settings__message is-error" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? <p className="mcp-settings__message">{notice}</p> : null}
      {status ? <p className="mcp-settings__empty">{status}</p> : null}
      {inventory?.capabilities.inventory && inventory.servers.length ? (
        <div className="settings__group">
          {inventory.servers.map((server) => (
            <ServerRow
              key={server.id}
              server={server}
              canSignIn={inventory.capabilities.startOAuth}
              busy={busy === server.id}
              onSignIn={() => void signIn(server)}
            />
          ))}
        </div>
      ) : null}
    </section>
  )
}

function ServerRow(props: {
  server: McpServer
  canSignIn: boolean
  busy: boolean
  onSignIn: () => void
}) {
  const needsOAuth =
    props.canSignIn &&
    props.server.auth.status === 'sign_in_required' &&
    props.server.auth.method === 'oauth'
  return (
    <article className={`settings__row mcp-row${props.server.enabled ? '' : ' is-disabled'}`}>
      <div className="settings__row-copy">
        <div className="mcp-row__heading">
          <h2>{props.server.displayName ?? props.server.id}</h2>
          <span>{props.server.scope}</span>
          <span>{props.server.enabled ? props.server.startup.state : 'disabled'}</span>
        </div>
        <p className="mcp-row__transport">{transportLabel(props.server.transport)}</p>
        {props.server.startup.state === 'failed' ? (
          <p className="mcp-row__failure" role="alert">
            <AlertTriangle size={13} aria-hidden />
            {props.server.startup.message}
          </p>
        ) : null}
        <details className="mcp-row__details">
          <summary>
            {props.server.tools.length} tools · {props.server.resources.length} resources ·{' '}
            {props.server.resourceTemplates.length} templates
          </summary>
          {props.server.tools.length ? (
            <ul>
              {props.server.tools.map((tool) => (
                <li key={tool.name}>
                  <strong>{tool.title ?? tool.name}</strong>
                  {tool.description ? ` — ${tool.description}` : ''}
                </li>
              ))}
            </ul>
          ) : (
            <p>No tools reported.</p>
          )}
        </details>
      </div>
      {needsOAuth ? (
        <button
          className="settings__action"
          type="button"
          disabled={props.busy}
          onClick={props.onSignIn}
        >
          Sign in
        </button>
      ) : null}
    </article>
  )
}

function transportLabel(transport: McpTransport | undefined): string {
  if (!transport) return 'Configuration managed by provider'
  return transport.type === 'http'
    ? transport.url
    : [transport.command, ...(transport.args ?? [])].join(' ')
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
