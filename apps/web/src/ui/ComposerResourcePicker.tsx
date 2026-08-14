import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { McpServer, ProviderId, ResultOf, Skill } from '@harness/contracts'
import { Box, Server } from 'lucide-react'
import type { Transport } from '../transport.js'

type SkillsInventory = ResultOf<'skills.list'>
type McpInventory = ResultOf<'mcp.list'>

export type ComposerResourceKind = 'skill' | 'mcp'

export type ComposerResource = {
  key: string
  kind: ComposerResourceKind
  id: string
  name: string
  description: string
  scope: string
  token: string
  available: boolean
  unavailableReason?: string | undefined
}

export type ComposerResourceTrigger = {
  marker: '$' | '@'
  query: string
  start: number
  end: number
}

export type ComposerResourcePickerHandle = {
  move: (direction: 1 | -1) => boolean
  selectActive: () => boolean
}

export const COMPOSER_RESOURCE_LIST_ID = 'composer-resource-list'

export const ComposerResourcePicker = forwardRef<
  ComposerResourcePickerHandle,
  {
    transport: Transport
    provider: ProviderId
    projectPath: string | undefined
    trigger: ComposerResourceTrigger | undefined
    selectedKeys: ReadonlySet<string>
    onSelect: (resource: ComposerResource) => void
  }
>(function ComposerResourcePicker(props, ref) {
  const [skills, setSkills] = useState<SkillsInventory>()
  const [mcp, setMcp] = useState<McpInventory>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const [activeIndex, setActiveIndex] = useState(-1)
  const [revision, setRevision] = useState(0)
  const loadedContext = useRef<string | undefined>(undefined)
  const inventoryGeneration = useRef(0)
  const list = useRef<HTMLDivElement>(null)
  const open = props.trigger !== undefined
  const contextKey = `${props.provider}\u0000${props.projectPath ?? ''}`

  useEffect(
    () => () => {
      inventoryGeneration.current += 1
    },
    [],
  )

  useEffect(() => {
    inventoryGeneration.current += 1
    loadedContext.current = undefined
    setSkills(undefined)
    setMcp(undefined)
    setLoading(false)
    setError(undefined)
  }, [props.transport, props.provider, props.projectPath])

  useEffect(() => {
    const invalidate = () => {
      loadedContext.current = undefined
      setRevision((current) => current + 1)
    }
    const offSkills = props.transport.on('skills.changed', ({ provider, projectPath }) => {
      if (provider === props.provider && projectPath === props.projectPath) invalidate()
    })
    const offMcp = props.transport.on('mcp.changed', ({ provider, projectPath }) => {
      if (provider === props.provider && projectPath === props.projectPath) invalidate()
    })
    let reconnecting = props.transport.state === 'reconnecting'
    const offState = props.transport.onState((state) => {
      if (state === 'reconnecting') reconnecting = true
      else if (state === 'open' && reconnecting) {
        reconnecting = false
        invalidate()
      }
    })
    return () => {
      offSkills()
      offMcp()
      offState()
    }
  }, [props.transport, props.provider, props.projectPath])

  useEffect(() => {
    if (!open || !props.projectPath || loadedContext.current === contextKey) return
    loadedContext.current = contextKey
    const generation = ++inventoryGeneration.current
    setLoading(true)
    setError(undefined)

    void Promise.allSettled([
      props.transport.request('skills.list', {
        provider: props.provider,
        projectPath: props.projectPath,
      }),
      props.transport.request('mcp.list', {
        provider: props.provider,
        projectPath: props.projectPath,
      }),
    ]).then(([skillsResult, mcpResult]) => {
      if (inventoryGeneration.current !== generation) return
      if (skillsResult.status === 'fulfilled') setSkills(skillsResult.value)
      if (mcpResult.status === 'fulfilled') setMcp(mcpResult.value)

      const failed = [
        skillsResult.status === 'rejected' ? 'skills' : undefined,
        mcpResult.status === 'rejected' ? 'MCP servers' : undefined,
      ].filter((value): value is string => value !== undefined)
      if (failed.length > 0) loadedContext.current = undefined
      setError(failed.length > 0 ? `Couldn’t load ${joinLabels(failed)}.` : undefined)
      setLoading(false)
    })
  }, [open, contextKey, props.transport, props.provider, props.projectPath, revision])

  const resources = useMemo(
    () => [
      ...(skills?.capabilities.inventory
        ? skills.skills.filter((skill) => skill.scope === 'project').map(skillResource)
        : []),
      ...(mcp?.capabilities.inventory
        ? mcp.servers.filter((server) => server.scope === 'project').map(mcpResource)
        : []),
    ],
    [skills, mcp],
  )
  const query = props.trigger?.query.trim().toLocaleLowerCase() ?? ''
  const filtered = useMemo(
    () =>
      resources.filter((resource) => {
        if (props.selectedKeys.has(resource.key)) return false
        if (query === '') return true
        return `${resource.name} ${resource.id} ${resource.description} ${resource.scope} ${resource.kind}`
          .toLocaleLowerCase()
          .includes(query)
      }),
    [resources, props.selectedKeys, query],
  )
  const resourceSignature = filtered
    .map((resource) => `${resource.key}:${resource.available ? '1' : '0'}`)
    .join('\u0000')
  const resolvedActiveIndex = filtered[activeIndex]?.available
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
        const available = filtered.flatMap((resource, index) => (resource.available ? [index] : []))
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
      selectActive() {
        const resource = filtered[resolvedActiveIndex]
        if (!open || !resource?.available) return false
        props.onSelect(resource)
        return true
      },
    }),
    [filtered, open, props.onSelect, resolvedActiveIndex],
  )

  if (!props.trigger) return null

  const status = !props.projectPath
    ? 'Choose a project to browse skills and MCP servers.'
    : loading && resources.length === 0
      ? 'Loading skills and MCP servers…'
      : filtered.length === 0
        ? query
          ? `No skills or MCP servers match “${props.trigger.query}”.`
          : 'No more skills or MCP servers are available.'
        : undefined
  const message = error ?? status

  return (
    <div
      className="composer-resource-picker"
      onMouseDown={(event) => {
        if ((event.target as Element).closest('.composer-resource-picker__option')) {
          event.preventDefault()
        }
      }}
    >
      <div
        ref={list}
        id={COMPOSER_RESOURCE_LIST_ID}
        className="composer-resource-picker__list"
        role="listbox"
        aria-label="Skills and MCP servers"
      >
        {filtered.map((resource, index) => {
          const Icon = resource.kind === 'skill' ? Box : Server
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
              onMouseEnter={() => {
                if (resource.available) setActiveIndex(index)
              }}
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
        ) : null}
      </div>
    </div>
  )
})

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
    : server.auth.status === 'sign_in_required'
      ? 'Sign in required'
      : server.startup.state === 'failed'
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

function firstAvailable(resources: ComposerResource[]): number {
  return resources.findIndex((resource) => resource.available)
}

function joinLabels(labels: string[]): string {
  if (labels.length < 2) return labels[0] ?? 'resources'
  return `${labels.slice(0, -1).join(', ')} and ${labels.at(-1)}`
}
