import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { McpServer, ProviderCommand, ProviderId, ResultOf, Skill } from '@harness/contracts'
import { IconBox as Box, IconServer as Server, IconSlash as Slash } from '@tabler/icons-react'
import type { AppCommand } from '../app-commands.js'
import { providerDisplayName } from '../provider-presentation.js'
import type { Transport } from '../transport.js'
import '../styles/composer-resource-picker.css'
import { SkeletonRows, SkeletonStatus } from './Skeleton.js'
import {
  COMPOSER_RESOURCE_LIST_ID,
  composerResourceListLabel,
  type ComposerResource,
  type ComposerResourceMarker,
  type ComposerResourcePickerHandle,
  type ComposerResourceTrigger,
} from './composer-resource.js'

export type { ComposerResource } from './composer-resource.js'

type Inventory = {
  skills?: ResultOf<'skills.list'>
  mcp?: ResultOf<'mcp.list'>
  commands?: ResultOf<'commands.list'>
}
type InventorySource = keyof Inventory
type MenuEntry = {
  resource: ComposerResource
  /** Lowercase names that rank as a name match; the first one is the primary name. */
  names: readonly string[]
  /** Lowercase text searched last, built once per inventory instead of per key. */
  haystack: string
}
type MenuRow = { resource: ComposerResource; rank: number }
type MarkerMenu = {
  /** The inventories this marker lists, so `@` never waits for commands. */
  sources: readonly InventorySource[]
  /** Fills "No … match", "No more … are available" and "… has no … for this project". */
  noun: string
  browse: string
}

const INVENTORY_SOURCES: readonly InventorySource[] = ['skills', 'mcp', 'commands']
const SOURCE_LABELS = {
  skills: 'skills',
  mcp: 'MCP servers',
  commands: 'commands',
} satisfies Record<InventorySource, string>
const MARKER_MENUS = {
  '/': {
    sources: ['commands', 'skills'],
    noun: 'commands or skills',
    browse: 'Choose a project to browse commands and skills.',
  },
  $: { sources: ['skills'], noun: 'skills', browse: 'Choose a project to browse skills.' },
  '@': { sources: ['mcp'], noun: 'MCP servers', browse: 'Choose a project to browse MCP servers.' },
} satisfies Record<ComposerResourceMarker, MarkerMenu>
const NO_SOURCES: ReadonlySet<InventorySource> = new Set()
const NO_APP_COMMANDS: readonly AppCommand[] = []
// Name widths for placeholder rows while the first inventory arrives.
const RESOURCE_SKELETON_WIDTHS = [108, 76, 132, 92]

export const ComposerResourcePicker = forwardRef<
  ComposerResourcePickerHandle,
  {
    transport: Transport
    provider: ProviderId
    projectPath: string | undefined
    /** The open chat, so the provider can answer from its live session. */
    threadId?: string | undefined
    /** TasteCode's own commands, listed before the provider's under `/`. */
    appCommands?: readonly AppCommand[] | undefined
    trigger: ComposerResourceTrigger | undefined
    selectedKeys: ReadonlySet<string>
    onSelect: (resource: ComposerResource) => void
  }
>(function ComposerResourcePicker(props, ref) {
  const [inventory, setInventory] = useState<Inventory>({})
  const [loading, setLoading] = useState<ReadonlySet<InventorySource>>(NO_SOURCES)
  const [failed, setFailed] = useState<ReadonlySet<InventorySource>>(NO_SOURCES)
  const [activeIndex, setActiveIndex] = useState(-1)
  const [revision, setRevision] = useState(0)
  const loaded = useRef(new Map<InventorySource, string>())
  const generations = useRef<Record<InventorySource, number>>({ skills: 0, mcp: 0, commands: 0 })
  const list = useRef<HTMLDivElement>(null)
  const open = props.trigger !== undefined
  const marker = props.trigger?.marker ?? '/'
  const contextKey = `${props.provider}\u0000${props.projectPath ?? ''}`
  // A chat's own session may know more commands than the project at large.
  const commandsKey = `${contextKey}\u0000${props.threadId ?? ''}`

  useEffect(
    () => () => {
      for (const source of INVENTORY_SOURCES) generations.current[source] += 1
    },
    [],
  )

  useEffect(() => {
    for (const source of INVENTORY_SOURCES) generations.current[source] += 1
    loaded.current.clear()
    setInventory({})
    setLoading(NO_SOURCES)
    setFailed(NO_SOURCES)
  }, [props.transport, props.provider, props.projectPath])

  useEffect(() => {
    const invalidate = (sources: readonly InventorySource[]) => {
      for (const source of sources) loaded.current.delete(source)
      setRevision((current) => current + 1)
    }
    const forThisProject =
      (sources: readonly InventorySource[]) =>
      ({ provider, projectPath }: { provider: ProviderId; projectPath: string }) => {
        if (provider === props.provider && projectPath === props.projectPath) invalidate(sources)
      }
    const offSkills = props.transport.on('skills.changed', forThisProject(['skills']))
    const offMcp = props.transport.on('mcp.changed', forThisProject(['mcp']))
    const offCommands = props.transport.on('commands.changed', forThisProject(['commands']))
    let reconnecting = props.transport.state === 'reconnecting'
    const offState = props.transport.onState((state) => {
      if (state === 'reconnecting') reconnecting = true
      else if (state === 'open' && reconnecting) {
        reconnecting = false
        invalidate(INVENTORY_SOURCES)
      }
    })
    return () => {
      offSkills()
      offMcp()
      offCommands()
      offState()
    }
  }, [props.transport, props.provider, props.projectPath])

  useEffect(() => {
    const projectPath = props.projectPath
    if (!open || !projectPath) return
    for (const source of markerMenu(marker).sources) {
      const key = source === 'commands' ? commandsKey : contextKey
      if (loaded.current.get(source) === key) continue
      loaded.current.set(source, key)
      const generation = ++generations.current[source]
      setLoading((current) => withSource(current, source, true))
      setFailed((current) => withSource(current, source, false))
      const settle = (next: Inventory | undefined) => {
        if (generations.current[source] !== generation) return
        if (next) setInventory((current) => ({ ...current, ...next }))
        else loaded.current.delete(source)
        setFailed((current) => withSource(current, source, next === undefined))
        setLoading((current) => withSource(current, source, false))
      }
      const params = { provider: props.provider, projectPath }
      const request =
        source === 'skills'
          ? props.transport.request('skills.list', params).then((skills) => ({ skills }))
          : source === 'mcp'
            ? props.transport.request('mcp.list', params).then((mcp) => ({ mcp }))
            : props.transport
                .request('commands.list', {
                  ...params,
                  ...(props.threadId ? { threadId: props.threadId } : {}),
                })
                .then(
                  (commands) => ({ commands }),
                  // A server from before provider commands has none to offer.
                  (error: unknown) => {
                    if (isUnknownMethod(error))
                      return { commands: { commands: [], loading: false } }
                    throw error
                  },
                )
      request.then(settle, () => settle(undefined))
    }
  }, [
    open,
    marker,
    contextKey,
    commandsKey,
    props.transport,
    props.provider,
    props.projectPath,
    props.threadId,
    revision,
  ])

  const ownCommands = props.appCommands ?? NO_APP_COMMANDS
  const entries = useMemo(() => menuEntries(inventory, ownCommands), [inventory, ownCommands])
  const markerEntries = entries[marker]
  const query = props.trigger?.query.trim().toLocaleLowerCase() ?? ''
  const filtered = useMemo(
    () => rankedRows(markerEntries, query, props.selectedKeys),
    [markerEntries, query, props.selectedKeys],
  )
  const resourceSignature = filtered
    .map(({ resource }) => `${resource.key}:${resource.available ? '1' : '0'}`)
    .join('\u0000')
  const resolvedActiveIndex = filtered[activeIndex]?.resource.available
    ? activeIndex
    : firstAvailable(filtered)

  useLayoutEffect(() => {
    setActiveIndex(firstAvailable(filtered))
  }, [props.trigger?.marker, props.trigger?.query, resourceSignature])

  useEffect(() => {
    if (resolvedActiveIndex < 0) return
    list.current
      ?.querySelector<HTMLElement>(`[data-index="${resolvedActiveIndex}"]`)
      ?.scrollIntoView?.({ block: 'nearest' })
  }, [resolvedActiveIndex])

  useImperativeHandle(
    ref,
    () => ({
      move(direction) {
        const available = filtered.flatMap(({ resource }, index) =>
          resource.available ? [index] : [],
        )
        if (!open || available.length === 0) return false
        const current = available.indexOf(resolvedActiveIndex)
        const next =
          current < 0
            ? direction > 0
              ? 0
              : available.length - 1
            : (current + direction + available.length) % available.length
        setActiveIndex(available[next]!)
        return true
      },
      selectActive(key = 'Enter') {
        const resource = filtered[resolvedActiveIndex]?.resource
        if (!open || !resource?.available) return false
        if (key === 'Enter' && runsAsTyped(resource, props.trigger)) return 'run'
        props.onSelect(resource)
        return 'selected'
      },
    }),
    [filtered, open, props.onSelect, props.trigger, resolvedActiveIndex],
  )

  if (!props.trigger) return null

  const labels = composerResourceListLabel(marker)
  const { sources, noun, browse } = markerMenu(marker)
  const commandsPending = marker === '/' && inventory.commands?.loading === true
  const pending =
    Boolean(props.projectPath) && (commandsPending || sources.some((source) => loading.has(source)))
  const failedSources = props.projectPath ? sources.filter((source) => failed.has(source)) : []
  const status = !props.projectPath
    ? filtered.length === 0
      ? browse
      : undefined
    : pending || filtered.length > 0
      ? undefined
      : query
        ? `No ${noun} match “${props.trigger.query}”.`
        : markerEntries.length > 0
          ? `No more ${noun} are available.`
          : `${providerDisplayName(props.provider)} has no ${noun} for this project.`
  const message =
    failedSources.length > 0
      ? `Couldn’t load ${joinLabels(failedSources.map((source) => SOURCE_LABELS[source]))}.`
      : status

  return (
    <div
      className="composer-resource-picker"
      onMouseDown={(event) => {
        if (
          event.target instanceof Element &&
          event.target.closest('.composer-resource-picker__option')
        ) {
          event.preventDefault()
        }
      }}
    >
      <div
        ref={list}
        id={COMPOSER_RESOURCE_LIST_ID}
        className="composer-resource-picker__list"
        role="listbox"
        aria-label={labels.label}
      >
        {filtered.map(({ resource }, index) => {
          const Icon =
            resource.icon ??
            (resource.kind === 'mcp'
              ? Server
              : resource.kind === 'command' && resource.commandKind !== 'skill'
                ? Slash
                : Box)
          const selected = index === resolvedActiveIndex
          return (
            <button
              type="button"
              role="option"
              aria-selected={selected}
              aria-disabled={!resource.available}
              className={`composer-resource-picker__option${selected ? ' is-active' : ''}${resource.available ? '' : ' is-unavailable'}`}
              data-index={index}
              key={resource.key}
              title={
                resource.kind === 'command' && resource.argumentHint
                  ? `${resource.token} ${resource.argumentHint}`
                  : undefined
              }
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => {
                if (resource.available) props.onSelect(resource)
              }}
            >
              <Icon size={15} strokeWidth={1.7} aria-hidden />
              <span className="composer-resource-picker__copy">
                <span className="composer-resource-picker__name">{resource.name}</span>
                <span className="composer-resource-picker__description">
                  {resource.unavailableReason
                    ? `${resource.description} · ${resource.unavailableReason}`
                    : resource.description}
                </span>
              </span>
            </button>
          )
        })}
        {message ? (
          <p className="composer-resource-picker__status" role="status">
            {message}
          </p>
        ) : pending ? (
          <SkeletonStatus label={labels.loading}>
            <SkeletonRows
              rows={filtered.length > 0 ? 2 : 4}
              icon
              widths={RESOURCE_SKELETON_WIDTHS}
            />
          </SkeletonStatus>
        ) : null}
      </div>
    </div>
  )
})

function markerMenu(marker: ComposerResourceMarker): MarkerMenu {
  return MARKER_MENUS[marker]
}

/** Builds each marker's rows once per inventory; typing only filters them. */
function menuEntries(inventory: Inventory, ownCommands: readonly AppCommand[]) {
  const commands: MenuEntry[] = []
  const commandNames = new Set<string>()
  // TasteCode's own commands come first and keep their names: a provider
  // command called the same is left out here, but still runs typed in full
  // whenever TasteCode does not handle that name itself.
  const addCommand = (resource: ComposerResource) => {
    const name = lowercase(resource.id)
    if (commandNames.has(name)) return
    const aliases = resource.aliases?.filter((alias) => !commandNames.has(lowercase(alias)))
    const names = [name, ...(aliases ?? []).map(lowercase)]
    for (const entry of names) commandNames.add(entry)
    commands.push(
      menuEntry(
        aliases?.length === resource.aliases?.length ? resource : { ...resource, aliases },
        names,
      ),
    )
  }
  for (const command of ownCommands) addCommand(appCommandResource(command))
  const providerCommands = [...(inventory.commands?.commands ?? [])]
  // The provider's own order, but its commands before its skills.
  providerCommands.sort((left, right) => commandOrder(left) - commandOrder(right))
  for (const command of providerCommands) addCommand(commandResource(command))
  const skills = (inventory.skills?.skills ?? []).map((skill) =>
    menuEntry(skillResource(skill), [skill.displayName ?? skill.name, skill.name].map(lowercase)),
  )
  // A skill the provider also lists as a command runs as that command.
  const slashSkills = skills.filter((entry) => !entry.names.some((name) => commandNames.has(name)))
  return {
    '/': [...commands, ...slashSkills],
    $: skills,
    '@': (inventory.mcp?.servers ?? []).map((server) =>
      menuEntry(mcpResource(server), [server.displayName ?? server.id, server.id].map(lowercase)),
    ),
  }
}

function menuEntry(resource: ComposerResource, names: string[]): MenuEntry {
  return {
    resource,
    names,
    haystack: lowercase(
      `${resource.name} ${resource.id} ${resource.description} ${resource.scope} ${resource.kind}`,
    ),
  }
}

/**
 * Exact names first, then names and aliases that start with the query, then
 * names that contain it, then everything else that mentions it. Equal ranks
 * keep the menu's order.
 */
function rankedRows(
  entries: readonly MenuEntry[],
  query: string,
  selectedKeys: ReadonlySet<string>,
): MenuRow[] {
  const rows: MenuRow[] = []
  for (const entry of entries) {
    if (selectedKeys.has(entry.resource.key)) continue
    if (query === '') {
      rows.push({ resource: entry.resource, rank: 0 })
      continue
    }
    const [primary = '', ...others] = entry.names
    let rank = -1
    let alias: string | undefined
    if (entry.names.includes(query)) {
      rank = 0
      if (primary !== query) alias = others.find((name) => name === query)
    } else if (primary.startsWith(query)) rank = 1
    else if ((alias = others.find((name) => name.startsWith(query))) !== undefined) rank = 2
    else if (entry.names.some((name) => name.includes(query))) rank = 3
    else if (entry.haystack.includes(query)) rank = 4
    if (rank < 0) continue
    rows.push({ resource: withTypedAlias(entry.resource, alias), rank })
  }
  return rows.sort((left, right) => left.rank - right.rank)
}

/** A command found by its alias is inserted under the name being typed. */
function withTypedAlias(resource: ComposerResource, alias: string | undefined): ComposerResource {
  if (resource.kind !== 'command' || alias === undefined) return resource
  const typed = resource.aliases?.find((name) => lowercase(name) === alias)
  return typed === undefined ? resource : { ...resource, token: `/${typed}` }
}

function runsAsTyped(
  resource: ComposerResource,
  trigger: ComposerResourceTrigger | undefined,
): boolean {
  if (resource.kind !== 'command' || !resource.runsAsTyped || !trigger) return false
  return trigger.query === resource.id || (resource.aliases?.includes(trigger.query) ?? false)
}

function commandResource(command: ProviderCommand): ComposerResource {
  return {
    key: `command:${command.name}`,
    kind: 'command',
    id: command.name,
    name: `/${command.name}`,
    description: command.description.trim() || (command.kind === 'skill' ? 'Skill' : 'Command'),
    scope: command.kind === 'skill' ? 'Skill' : 'Command',
    token: `/${command.name}`,
    available: true,
    commandKind: command.kind ?? 'command',
    ...(command.aliases?.length ? { aliases: command.aliases } : {}),
    ...(command.argumentHint ? { argumentHint: command.argumentHint } : {}),
    // A command without an argument hint takes no input, so its bare name runs
    // as typed. A skill always waits for the task it should work on.
    runsAsTyped: command.argumentHint === undefined && command.kind !== 'skill',
  }
}

function appCommandResource(command: AppCommand): ComposerResource {
  return {
    key: `app:${command.name}`,
    kind: 'command',
    id: command.name,
    name: `/${command.name}`,
    description: command.description,
    scope: 'TasteCode',
    token: `/${command.name}`,
    available: true,
    commandKind: 'command',
    ...(command.aliases?.length ? { aliases: command.aliases } : {}),
    ...(command.argumentHint ? { argumentHint: command.argumentHint } : {}),
    // TasteCode handles the bare name too, so Enter on it runs at once.
    runsAsTyped: true,
    icon: command.icon,
  }
}

function commandOrder(command: ProviderCommand): number {
  return command.kind === 'skill' ? 1 : 0
}

function skillResource(skill: Skill): ComposerResource {
  const dependency = skill.dependencyErrors[0]?.message
  const unavailableReason = !skill.enabled ? 'Disabled' : dependency
  return {
    key: `skill:${skill.id}`,
    kind: 'skill',
    id: skill.id,
    name: skill.displayName ?? skill.name,
    description: skill.description,
    scope: skillScope(skill.scope),
    token: skill.name.startsWith('$') ? skill.name : `$${skill.name}`,
    available: unavailableReason === undefined,
    ...(unavailableReason ? { unavailableReason } : {}),
  }
}

function mcpResource(server: McpServer): ComposerResource {
  const unavailableReason = !server.enabled
    ? 'Disabled'
    : server.auth?.status === 'sign_in_required'
      ? 'Sign in required'
      : server.startup?.state === 'failed'
        ? server.startup.message
        : undefined
  return {
    key: `mcp:${server.id}`,
    kind: 'mcp',
    id: server.id,
    name: server.displayName ?? server.id,
    description:
      server.description?.trim() ||
      (server.tools.length > 0
        ? `${server.tools.length} ${server.tools.length === 1 ? 'tool' : 'tools'} available`
        : 'Configured MCP server'),
    scope: server.scope === 'project' ? 'Project' : 'Personal',
    token: server.id.startsWith('@') ? server.id : `@${server.id}`,
    available: unavailableReason === undefined,
    ...(unavailableReason ? { unavailableReason } : {}),
  }
}

function skillScope(scope: Skill['scope']): string {
  switch (scope) {
    case 'project':
      return 'Project'
    case 'user':
      return 'Personal'
    case 'system':
      return 'System'
    case 'admin':
      return 'Admin'
  }
}

function firstAvailable(rows: readonly MenuRow[]): number {
  return rows.findIndex(({ resource }) => resource.available)
}

function withSource(
  current: ReadonlySet<InventorySource>,
  source: InventorySource,
  present: boolean,
): ReadonlySet<InventorySource> {
  if (current.has(source) === present) return current
  const next = new Set(current)
  if (present) next.add(source)
  else next.delete(source)
  return next
}

function isUnknownMethod(error: unknown): boolean {
  return error instanceof Error && /^unknown method\b/i.test(error.message)
}

function lowercase(value: string): string {
  return value.toLocaleLowerCase()
}

function joinLabels(labels: string[]): string {
  if (labels.length < 2) return labels[0] ?? 'resources'
  return `${labels.slice(0, -1).join(', ')} and ${labels.at(-1)}`
}
