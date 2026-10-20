import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import type {
  McpServer,
  McpServerConfig,
  McpTransport,
  ProviderId,
  ResultOf,
} from '@harness/contracts'
import { McpServerConfigSchema, McpTransportSchema } from '@harness/contracts'
import { IconAlertTriangle as AlertTriangle, IconPlus as Plus } from '@tabler/icons-react'
import type { Transport } from '../transport.js'
import { useProviderWatch } from '../provider-watch.js'
import { isComposingKey } from '../shortcuts.js'
import { AppSelect } from './AppSelect.js'
import {
  SettingsEmpty,
  SettingsEntitySkeleton,
  SettingsNotice,
  SettingsPage,
  SettingsSection,
} from './settings/SettingsLayout.js'
import '../styles/switch.css'

type Inventory = ResultOf<'mcp.list'>
type Editor = {
  mode: 'add' | 'edit' | 'hide'
  id: string
  displayName: string
  transport: string
  opener: HTMLButtonElement
}
type OAuthCompletion = {
  serverId: string
  loginId: string
  success: boolean
  error: string | null
}
type PendingOAuth = {
  serverId: string
  loginId: string | undefined
  completion?: OAuthCompletion
}
type Context = { transport: Transport; provider: ProviderId; projectPath: string | undefined }

export function McpSettings(props: {
  transport: Transport
  provider: ProviderId
  providerName: string
  providers?: Array<{ provider: ProviderId; providerName: string }>
  projectPath: string | undefined
  projectName: string | undefined
}) {
  const providers = props.providers?.length
    ? props.providers
    : [{ provider: props.provider, providerName: props.providerName }]
  const initialProvider =
    providers.find((option) => option.provider === props.provider) ?? providers[0]!
  const [provider, setProvider] = useState(initialProvider.provider)
  const availableProviders = providers.map((option) => option.provider).join('\0')

  useEffect(() => {
    if (availableProviders.split('\0').includes(provider)) return
    setProvider(initialProvider.provider)
  }, [availableProviders, initialProvider.provider, provider])

  const selected = providers.find((option) => option.provider === provider) ?? initialProvider
  return (
    <ProviderMcpSettings
      key={selected.provider}
      {...props}
      provider={selected.provider}
      providerName={selected.providerName}
      providerPicker={
        providers.length > 1 ? (
          <div className="mcp-settings__provider">
            <span>Provider</span>
            <AppSelect
              value={selected.provider}
              options={providers.map((option) => ({
                value: option.provider,
                label: option.providerName,
              }))}
              onChange={setProvider}
              ariaLabel="MCP provider"
              className="mcp-settings__provider-select"
              align="right"
            />
          </div>
        ) : null
      }
    />
  )
}

function ProviderMcpSettings(props: {
  transport: Transport
  provider: ProviderId
  providerName: string
  projectPath: string | undefined
  projectName: string | undefined
  providerPicker?: ReactNode
}) {
  useProviderWatch(props.transport, props.provider, props.projectPath, 'mcp')
  const [inventory, setInventory] = useState<Inventory>()
  const [loading, setLoading] = useState(false)
  const [editor, setEditor] = useState<Editor>()
  // Per id: one row settling must not unlock another row still in flight.
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set())
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const inventoryContext = useRef<Context | undefined>(undefined)
  const errorContext = useRef<Context | undefined>(undefined)
  const pendingOAuth = useRef<PendingOAuth | undefined>(undefined)
  const activeContext = useRef({
    transport: props.transport,
    provider: props.provider,
    projectPath: props.projectPath,
  })
  activeContext.current = {
    transport: props.transport,
    provider: props.provider,
    projectPath: props.projectPath,
  }
  const isCurrentContext = () =>
    activeContext.current.transport === props.transport &&
    activeContext.current.provider === props.provider &&
    activeContext.current.projectPath === props.projectPath

  // Generation counter: a slow reply from a previous project must not land
  // on top of the current one's list (or arrive after unmount).
  const refreshGeneration = useRef(0)
  useEffect(
    () => () => {
      refreshGeneration.current += 1
    },
    [],
  )

  const refresh = useCallback(async () => {
    if (!props.projectPath || !isCurrentContext()) return
    const context = {
      transport: props.transport,
      provider: props.provider,
      projectPath: props.projectPath,
    }
    const generation = ++refreshGeneration.current
    setLoading(true)
    try {
      const inventory = await props.transport.request('mcp.list', {
        provider: props.provider,
        projectPath: props.projectPath,
      })
      if (refreshGeneration.current !== generation || !isCurrentContext()) return
      inventoryContext.current = context
      errorContext.current = undefined
      setInventory(inventory)
      setError(undefined)
    } catch (cause) {
      if (refreshGeneration.current !== generation || !isCurrentContext()) return
      errorContext.current = context
      setError(message(cause))
    } finally {
      if (refreshGeneration.current === generation && isCurrentContext()) setLoading(false)
    }
  }, [props.transport, props.provider, props.projectPath])

  const completeOAuth = useCallback(
    (result: OAuthCompletion) => {
      pendingOAuth.current = undefined
      setBusy(without(result.serverId))
      if (result.success) {
        setNotice('MCP sign-in completed.')
        setError(undefined)
        void refresh()
      } else {
        setNotice(undefined)
        setError(result.error ?? 'MCP sign-in failed.')
      }
    },
    [refresh],
  )

  useEffect(() => {
    setInventory(undefined)
    inventoryContext.current = undefined
    errorContext.current = undefined
    setError(undefined)
    // "Server added." must not survive into an unrelated project's panel.
    setNotice(undefined)
    setEditor(undefined)
    pendingOAuth.current = undefined
    setBusy(new Set())
    if (!props.projectPath) {
      setLoading(false)
      return
    }
    void refresh()
    const offOAuth = props.transport.on('mcp.oauth', (result) => {
      if (result.provider !== props.provider || result.projectPath !== props.projectPath) return
      const pending = pendingOAuth.current
      if (pending) {
        if (pending.serverId !== result.serverId) {
          if (result.success) void refresh()
          return
        }
        if (pending.loginId === undefined) {
          pending.completion = result
          return
        }
        if (pending.loginId !== result.loginId) {
          if (result.success) void refresh()
          return
        }
      }
      completeOAuth(result)
    })
    const offChanged = props.transport.on('mcp.changed', ({ provider, projectPath }) => {
      if (provider === props.provider && projectPath === props.projectPath) void refresh()
    })
    let reconnecting = props.transport.state === 'reconnecting'
    const offState = props.transport.onState((state) => {
      if (state === 'reconnecting') reconnecting = true
      else if (state === 'open' && reconnecting) {
        reconnecting = false
        void refresh()
      }
    })
    return () => {
      offOAuth()
      offChanged()
      offState()
    }
  }, [props.transport, props.provider, props.projectPath, refresh, completeOAuth])

  async function applyChange<Result>(
    busyId: string,
    action: () => Promise<Result>,
    success: string,
  ): Promise<boolean> {
    setBusy((current) => new Set(current).add(busyId))
    setError(undefined)
    setNotice(undefined)
    try {
      await action()
      if (!isCurrentContext()) return false
      setNotice(success)
      if (inventory?.capabilities.reload && props.projectPath) {
        try {
          await props.transport.request('mcp.reload', {
            provider: props.provider,
            projectPath: props.projectPath,
          })
          if (!isCurrentContext()) return false
          setNotice(
            `${success} Open chats pick up the change once they finish their current and queued messages.`,
          )
        } catch (cause) {
          if (!isCurrentContext()) return false
          setNotice(`${success} ${message(cause)}`)
        }
      }
      await refresh()
      if (!isCurrentContext()) return false
      return true
    } catch (cause) {
      if (isCurrentContext()) setError(message(cause))
      return false
    } finally {
      if (isCurrentContext()) setBusy(without(busyId))
    }
  }

  async function save(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (!editor || !props.projectPath || busy.has('editor')) return
    const projectPath = props.projectPath
    let server: McpServerConfig
    try {
      server = McpServerConfigSchema.parse(
        editor.mode === 'hide'
          ? {
              id: editor.id.trim(),
              enabled: false,
            }
          : {
              id: editor.id.trim(),
              enabled: true,
              ...(editor.displayName.trim()
                ? {
                    displayName: editor.displayName.trim(),
                  }
                : {}),
              transport: McpTransportSchema.parse(JSON.parse(editor.transport)),
            },
      )
    } catch {
      setError(
        editor.mode === 'hide'
          ? 'Enter a server ID.'
          : 'Enter a server ID and valid transport JSON.',
      )
      return
    }
    const saved = await applyChange(
      'editor',
      () =>
        props.transport.request(editor.mode === 'edit' ? 'mcp.update' : 'mcp.add', {
          provider: props.provider,
          projectPath,
          server,
        }),
      editor.mode === 'hide'
        ? 'Server hidden for this project.'
        : editor.mode === 'add'
          ? 'Server added.'
          : 'Server updated.',
    )
    if (saved) setEditor(undefined)
  }

  function toggle(server: McpServer): void {
    if (!props.projectPath) return
    void applyChange(
      server.id,
      () =>
        server.enabled
          ? props.transport.request('mcp.add', {
              provider: props.provider,
              projectPath: props.projectPath!,
              server: { id: server.id, enabled: false },
            })
          : props.transport.request('mcp.remove', {
              provider: props.provider,
              projectPath: props.projectPath!,
              serverId: server.id,
            }),
      server.enabled ? 'Server disabled for this project.' : 'Project override removed.',
    )
  }

  function remove(server: McpServer): void {
    if (!props.projectPath || !window.confirm(`Remove ${name(server)} from this project?`)) return
    void applyChange(
      server.id,
      () =>
        props.transport.request('mcp.remove', {
          provider: props.provider,
          projectPath: props.projectPath!,
          serverId: server.id,
        }),
      'Server removed.',
    )
  }

  async function signIn(server: McpServer): Promise<void> {
    if (!props.projectPath || pendingOAuth.current) return
    pendingOAuth.current = { serverId: server.id, loginId: undefined }
    setBusy((current) => new Set(current).add(server.id))
    setError(undefined)
    try {
      const result = await props.transport.request('mcp.startOAuth', {
        provider: props.provider,
        projectPath: props.projectPath,
        serverId: server.id,
      })
      if (!isCurrentContext()) return
      const pending = pendingOAuth.current
      if (!pending || pending.serverId !== server.id) return
      pending.loginId = result.loginId
      if (pending.completion?.loginId === result.loginId) {
        completeOAuth(pending.completion)
        return
      }
      delete pending.completion
      const opened = window.open(result.authUrl, '_blank', 'noopener,noreferrer')
      if (!opened) {
        setNotice(`Your browser blocked the sign-in window. Open it yourself: ${result.authUrl}`)
      } else {
        setNotice('Finish signing in in your browser.')
      }
    } catch (cause) {
      if (isCurrentContext()) {
        pendingOAuth.current = undefined
        setBusy(without(server.id))
        setError(message(cause))
      }
    }
  }

  const contextMatches = (context: Context | undefined) =>
    context?.transport === props.transport &&
    context.provider === props.provider &&
    context.projectPath === props.projectPath
  const currentInventory = contextMatches(inventoryContext.current) ? inventory : undefined
  const currentError = currentInventory || contextMatches(errorContext.current) ? error : undefined
  const projectServers =
    currentInventory?.servers.filter((server) => server.scope === 'project') ?? []
  // The provider loads these in every chat whether or not the project adds anything;
  // hiding them made a fully configured provider read as having no MCP servers.
  const inheritedServers =
    currentInventory?.servers.filter((server) => server.scope === 'global') ?? []
  // The provider is still collecting its servers, so an empty list is not final.
  const checking = Boolean(currentInventory?.loading)
  const canHide = currentInventory ? canHideInherited(currentInventory.capabilities) : false
  const loadingInventory =
    Boolean(props.projectPath) &&
    ((loading && !inventory) ||
      (checking && projectServers.length === 0 && inheritedServers.length === 0))
  const projectList = !props.projectPath ? (
    <SettingsEmpty title="Select a project in the sidebar first." />
  ) : loadingInventory ? (
    <SettingsEntitySkeleton label="Loading MCP servers…" />
  ) : !currentInventory ? null : projectServers.length === 0 ? (
    <SettingsEmpty title="No MCP servers have been added to this project." />
  ) : (
    projectServers.map((server) => (
      <ServerRow
        key={server.id}
        server={server}
        capabilities={currentInventory.capabilities}
        busy={busy.has(server.id)}
        onSignIn={() => void signIn(server)}
        onToggle={() => toggle(server)}
        onEdit={(opener) =>
          setEditor({
            mode: 'edit',
            opener,
            id: server.id,
            displayName: server.displayName ?? '',
            transport: JSON.stringify(server.transport, null, 2),
          })
        }
        onRemove={() => remove(server)}
      />
    ))
  )

  return (
    <SettingsPage
      title="MCP servers"
      description={pageDescription(props.providerName, props.projectPath, props.projectName)}
      actions={
        <>
          {props.providerPicker}
          {props.projectPath && canHide ? (
            <button
              className="set-button set-button--quiet"
              type="button"
              disabled={busy.size > 0}
              onClick={(event) =>
                setEditor({
                  mode: 'hide',
                  id: '',
                  displayName: '',
                  transport: '',
                  opener: event.currentTarget,
                })
              }
            >
              Hide server by ID
            </button>
          ) : null}
          {props.projectPath && currentInventory?.capabilities.add ? (
            <button
              className="set-button"
              type="button"
              disabled={busy.size > 0}
              onClick={(event) =>
                setEditor({
                  mode: 'add',
                  opener: event.currentTarget,
                  id: '',
                  displayName: '',
                  transport: '{\n  "type": "http",\n  "url": "https://example.com/mcp"\n}',
                })
              }
            >
              <Plus size={14} aria-hidden />
              Add server
            </button>
          ) : null}
        </>
      }
    >
      {currentError ? (
        <SettingsNotice
          tone="error"
          action={
            <button className="set-button" type="button" onClick={() => void refresh()}>
              Retry
            </button>
          }
        >
          {currentError}
        </SettingsNotice>
      ) : null}
      {currentInventory && !currentInventory.capabilities.inventory ? (
        <SettingsNotice tone="info">
          Servers from {props.providerName}’s own settings are loaded in chats but can’t be listed
          here.
        </SettingsNotice>
      ) : null}
      {checking && !loadingInventory ? (
        <SettingsNotice tone="progress">Checking {props.providerName} MCP servers…</SettingsNotice>
      ) : null}
      {notice ? <SettingsNotice tone="info">{notice}</SettingsNotice> : null}
      {editor ? (
        <ServerEditor
          key={editor.mode === 'edit' ? `edit:${editor.id}` : editor.mode}
          editor={editor}
          busy={busy.has('editor')}
          onChange={setEditor}
          onCancel={() => setEditor(undefined)}
          onSubmit={(event) => void save(event)}
        />
      ) : null}
      {projectList ? (
        <SettingsSection
          label="Project servers"
          note={
            // Once there is a change to apply: above the empty line it read as its lead-in.
            currentInventory?.capabilities.add &&
            !currentInventory.capabilities.reload &&
            (projectServers.length > 0 || notice)
              ? 'Changes apply when you start or resume a session.'
              : undefined
          }
        >
          {projectList}
        </SettingsSection>
      ) : null}
      {currentInventory && inheritedServers.length > 0 ? (
        <SettingsSection
          title={`From ${props.providerName} settings`}
          note={
            <>
              Every {props.providerName} chat in this project loads these. Change them in{' '}
              {props.providerName}
              {canHide ? ', or turn one off for this project only.' : '.'}
            </>
          }
        >
          {inheritedServers.map((server) => (
            <ServerRow
              key={server.id}
              server={server}
              capabilities={currentInventory.capabilities}
              busy={busy.has(server.id)}
              onSignIn={() => void signIn(server)}
              onToggle={() => toggle(server)}
              onEdit={() => undefined}
              onRemove={() => undefined}
            />
          ))}
        </SettingsSection>
      ) : null}
    </SettingsPage>
  )
}

/** The provider and, once a project is open, the project the list belongs to. */
function pageDescription(
  providerName: string,
  projectPath: string | undefined,
  projectName: string | undefined,
): string {
  return projectPath && projectName ? `${providerName} · ${projectName}` : providerName
}

const STARTUP_LABELS = {
  stopped: 'Stopped',
  starting: 'Starting…',
  ready: 'Ready',
  failed: 'Failed',
} satisfies Record<NonNullable<McpServer['startup']>['state'], string>

function serverStatus(server: McpServer): string {
  if (!server.enabled) return 'Disabled'
  return server.startup ? STARTUP_LABELS[server.startup.state] : 'Status unavailable'
}

function ServerRow(props: {
  server: McpServer
  capabilities: Inventory['capabilities']
  busy: boolean
  onSignIn: () => void
  onToggle: () => void
  onEdit: (opener: HTMLButtonElement) => void
  onRemove: () => void
}) {
  const auth = props.server.auth
  const startup = props.server.startup
  const inherited = props.server.scope === 'global'
  const needsOAuth =
    props.capabilities.startOAuth && auth?.status === 'sign_in_required' && auth.method === 'oauth'
  const canToggle =
    props.capabilities.remove &&
    ((!props.server.enabled && props.server.scope === 'project') ||
      (canHideInherited(props.capabilities) && props.server.scope === 'global'))
  // A server can report hundreds of tools; render them only once someone looks.
  const [toolsOpen, setToolsOpen] = useState(false)
  const canEdit =
    props.capabilities.update && props.server.scope === 'project' && props.server.transport
  const canRemove =
    props.capabilities.remove && props.server.scope === 'project' && props.server.enabled
  // Project servers are the page's own list; inherited ones sit under their section.
  const Name = inherited ? 'h3' : 'h2'
  return (
    <article
      className="set-entity mcp-row"
      data-tone={
        !props.server.enabled ? 'muted' : startup?.state === 'failed' ? 'error' : undefined
      }
    >
      <div className="set-entity__main">
        <div className="set-entity__head">
          <Name className="set-entity__name">{props.server.displayName ?? props.server.id}</Name>
          <span className="set-leader" aria-hidden />
          <span className="set-entity__status">{serverStatus(props.server)}</span>
        </div>
        {inherited && !props.server.transport ? (
          props.server.description ? (
            <p className="set-entity__detail">{props.server.description}</p>
          ) : null
        ) : (
          <p className="set-entity__detail set-entity__detail--code">
            {transportLabel(props.server.transport)}
          </p>
        )}
        {startup?.state === 'failed' ? (
          <p className="set-entity__detail set-entity__detail--error" role="alert">
            <AlertTriangle size={13} aria-hidden />
            {startup.message}
          </p>
        ) : null}
        <details
          className="mcp-row__details"
          onToggle={(event) => setToolsOpen(event.currentTarget.open)}
        >
          <summary>
            {props.server.tools.length} tools · {props.server.resources.length} resources ·{' '}
            {props.server.resourceTemplates.length} templates
          </summary>
          {!toolsOpen ? null : props.server.tools.length ? (
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
      <div className="set-entity__actions">
        {needsOAuth ? (
          <button
            className="set-button"
            type="button"
            disabled={props.busy}
            onClick={props.onSignIn}
          >
            Sign in
          </button>
        ) : null}
        {canToggle ? (
          <button
            className={`switch${props.server.enabled ? ' is-on' : ''}`}
            type="button"
            role="switch"
            aria-label={`${props.server.enabled ? 'Disable' : 'Enable'} ${name(props.server)} for this project`}
            aria-checked={props.server.enabled}
            disabled={props.busy}
            onClick={props.onToggle}
          >
            <span className="switch__thumb" />
          </button>
        ) : null}
        {canEdit ? (
          <button
            className="set-button set-button--quiet"
            type="button"
            disabled={props.busy}
            onClick={(event) => props.onEdit(event.currentTarget)}
          >
            Edit
          </button>
        ) : null}
        {canRemove ? (
          <button
            className="set-button set-button--danger"
            type="button"
            disabled={props.busy}
            onClick={props.onRemove}
          >
            Remove
          </button>
        ) : null}
      </div>
    </article>
  )
}

function ServerEditor(props: {
  editor: Editor
  busy: boolean
  onChange: (editor: Editor) => void
  onCancel: () => void
  onSubmit: (event: FormEvent) => void
}) {
  const update = (change: Partial<Editor>) => props.onChange({ ...props.editor, ...change })
  const field = useRef<HTMLInputElement>(null)
  const hiding = props.editor.mode === 'hide'
  const opener = props.editor.opener
  useEffect(() => {
    field.current?.form?.querySelector<HTMLInputElement>('input:not(:disabled)')?.focus()
    return () => {
      if (document.contains(opener)) opener.focus()
    }
  }, [opener])
  return (
    <form
      className="set-form mcp-editor"
      aria-label={`${hiding ? 'Hide inherited' : props.editor.mode === 'add' ? 'Add' : 'Edit'} MCP server`}
      onSubmit={props.onSubmit}
      onKeyDown={(event) => {
        if (isComposingKey(event)) return
        if (event.key === 'Escape' && !props.busy) {
          event.stopPropagation()
          props.onCancel()
        }
      }}
    >
      {hiding ? (
        <p className="set-form__wide set-form__note">
          Enter the ID from your provider's MCP settings. This hides the server in this project and
          keeps the provider's own settings unchanged.
        </p>
      ) : null}
      <label className={hiding ? 'set-form__wide' : undefined}>
        Server ID
        <input
          ref={field}
          className="set-input"
          required
          disabled={props.editor.mode === 'edit'}
          value={props.editor.id}
          onChange={(event) => update({ id: event.target.value })}
        />
      </label>
      {!hiding ? (
        <label>
          Display name
          <input
            className="set-input"
            value={props.editor.displayName}
            onChange={(event) => update({ displayName: event.target.value })}
          />
        </label>
      ) : null}
      {!hiding ? (
        <label className="set-form__wide">
          Transport JSON
          <textarea
            className="set-input mcp-editor__transport"
            required
            spellCheck={false}
            value={props.editor.transport}
            onChange={(event) => update({ transport: event.target.value })}
          />
          <small className="set-form__hint">
            Use stdio or HTTP transport fields. Reference secrets as
            {' { "source": "credential", "credentialRef": "…" }'}.
          </small>
        </label>
      ) : null}
      <footer className="set-form__actions">
        <button
          className="set-button set-button--quiet"
          type="button"
          disabled={props.busy}
          onClick={props.onCancel}
        >
          Cancel
        </button>
        <button className="set-button set-button--primary" type="submit" disabled={props.busy}>
          {props.busy ? 'Saving…' : hiding ? 'Hide server' : 'Save server'}
        </button>
      </footer>
    </form>
  )
}

/** Absent means the rule from before the capability was declared. */
function canHideInherited(capabilities: Inventory['capabilities']): boolean {
  return capabilities.hideInherited ?? (capabilities.add && capabilities.inventory)
}

function name(server: McpServer): string {
  return server.displayName ?? server.id
}

function transportLabel(transport: McpTransport | undefined): string {
  if (!transport) return 'Configuration managed by provider'
  return transport.type === 'http'
    ? transport.url
    : [transport.command, ...(transport.args ?? [])].join(' ')
}

function without(id: string) {
  return (current: ReadonlySet<string>) => {
    const next = new Set(current)
    next.delete(id)
    return next
  }
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
