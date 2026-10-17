import { useEffect, useRef, useState } from 'react'
import type { ProviderId, ResultOf, Skill } from '@harness/contracts'
import {
  IconAlertTriangle as AlertTriangle,
  IconFolderPlus as FolderPlus,
} from '@tabler/icons-react'
import { pickSkillFolder } from '../bridge.js'
import type { Transport } from '../transport.js'
import { useProviderWatch } from '../provider-watch.js'
import {
  SettingsEmpty,
  SettingsEntitySkeleton,
  SettingsNotice,
  SettingsPage,
} from './settings/SettingsLayout.js'

type Inventory = ResultOf<'skills.list'>
type Context = { transport: Transport; provider: ProviderId; projectPath: string | undefined }

export function SkillsSettings(props: {
  transport: Transport
  provider: ProviderId
  providerName: string
  projectPath: string | undefined
  projectName: string | undefined
}) {
  useProviderWatch(props.transport, props.provider, props.projectPath, 'skills')
  const [inventory, setInventory] = useState<Inventory>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  // Per id: one toggle settling must not unlock another switch still in flight.
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set())
  const [reload, setReload] = useState(0)
  const inventoryGeneration = useRef(0)
  const inventoryContext = useRef<Context | undefined>(undefined)
  const errorContext = useRef<Context | undefined>(undefined)
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

  useEffect(() => {
    if (!props.projectPath) {
      inventoryGeneration.current += 1
      setInventory(undefined)
      inventoryContext.current = undefined
      errorContext.current = undefined
      setLoading(false)
      setError(undefined)
      setBusy(new Set())
      return
    }

    let active = true
    // Ordered: two overlapping refreshes (initial load racing a
    // skills.changed push) must not land out of order.
    const load = async () => {
      const context = {
        transport: props.transport,
        provider: props.provider,
        projectPath: props.projectPath,
      }
      const mine = ++inventoryGeneration.current
      setLoading(true)
      try {
        const next = await props.transport.request('skills.list', {
          provider: props.provider,
          projectPath: props.projectPath!,
        })
        if (active && mine === inventoryGeneration.current) {
          inventoryContext.current = context
          errorContext.current = undefined
          setInventory(next)
          setError(undefined)
        }
      } catch (cause) {
        if (active && mine === inventoryGeneration.current) {
          errorContext.current = context
          setError(message(cause))
        }
      } finally {
        if (active && mine === inventoryGeneration.current) setLoading(false)
      }
    }
    setInventory(undefined)
    inventoryContext.current = undefined
    errorContext.current = undefined
    setError(undefined)
    setBusy(new Set())
    void load()
    const off = props.transport.on('skills.changed', ({ provider, projectPath }) => {
      if (provider === props.provider && projectPath === props.projectPath) void load()
    })
    let reconnecting = props.transport.state === 'reconnecting'
    const offState = props.transport.onState((state) => {
      if (state === 'reconnecting') reconnecting = true
      else if (state === 'open' && reconnecting) {
        reconnecting = false
        void load()
      }
    })
    return () => {
      active = false
      off()
      offState()
    }
  }, [props.transport, props.provider, props.projectPath, reload])

  async function toggle(skill: Skill): Promise<void> {
    if (!props.projectPath) return
    setBusy((current) => new Set(current).add(skill.id))
    setError(undefined)
    try {
      const { enabled } = await props.transport.request('skills.setEnabled', {
        provider: props.provider,
        projectPath: props.projectPath,
        skillId: skill.id,
        enabled: !skill.enabled,
      })
      if (!isCurrentContext()) return
      inventoryGeneration.current += 1
      setLoading(false)
      setInventory((current) =>
        current
          ? {
              ...current,
              skills: current.skills.map((entry) =>
                entry.id === skill.id ? { ...entry, enabled } : entry,
              ),
            }
          : current,
      )
    } catch (cause) {
      if (isCurrentContext()) setError(message(cause))
    } finally {
      if (isCurrentContext()) setBusy(without(skill.id))
    }
  }

  async function install(): Promise<void> {
    if (!props.projectPath) return
    setError(undefined)
    setBusy((current) => new Set(current).add('install'))
    try {
      const folderPath = await pickSkillFolder()
      if (!folderPath || !isCurrentContext()) return
      const { skill } = await props.transport.request('skills.installFromFolder', {
        provider: props.provider,
        projectPath: props.projectPath,
        folderPath,
      })
      if (!isCurrentContext()) return
      inventoryGeneration.current += 1
      setLoading(false)
      setInventory((current) =>
        current
          ? {
              ...current,
              skills: [...current.skills.filter((entry) => entry.id !== skill.id), skill],
            }
          : current,
      )
    } catch (cause) {
      if (isCurrentContext()) setError(message(cause))
    } finally {
      if (isCurrentContext()) setBusy(without('install'))
    }
  }

  const contextMatches = (context: Context | undefined) =>
    context?.transport === props.transport &&
    context.provider === props.provider &&
    context.projectPath === props.projectPath
  const currentInventory = contextMatches(inventoryContext.current) ? inventory : undefined
  const currentError = currentInventory || contextMatches(errorContext.current) ? error : undefined
  const projectSkills = currentInventory?.skills.filter((skill) => skill.scope === 'project') ?? []
  // A background refresh keeps the current list on screen; blanking it
  // to a loading note on every skills.changed push read as flicker.
  const discovering = Boolean(props.projectPath) && loading && !inventory

  return (
    <SettingsPage
      title="Skills"
      description={pageDescription(props.providerName, props.projectPath, props.projectName)}
      actions={
        props.projectPath && currentInventory?.capabilities.install ? (
          <button
            className="set-button"
            type="button"
            disabled={busy.size > 0}
            onClick={() => void install()}
          >
            <FolderPlus size={14} aria-hidden />
            {busy.has('install') ? 'Installing…' : 'Install from folder'}
          </button>
        ) : undefined
      }
    >
      {currentError ? (
        <SettingsNotice
          tone="error"
          action={
            <button className="set-button" type="button" onClick={() => setReload((n) => n + 1)}>
              Retry
            </button>
          }
        >
          {currentError}
        </SettingsNotice>
      ) : null}
      {currentInventory && !currentInventory.capabilities.inventory ? (
        <SettingsNotice tone="info">
          Skills from {props.providerName}’s own settings are loaded in chats but can’t be listed
          here.
        </SettingsNotice>
      ) : null}
      {currentInventory?.errors.length ? (
        <SettingsNotice tone="error">
          Some skills could not be loaded.
          {currentInventory.errors.map((entry) => (
            <span className="set-notice__line" key={`${entry.path}:${entry.message}`}>
              {entry.message} · {entry.path}
            </span>
          ))}
        </SettingsNotice>
      ) : null}
      {!props.projectPath ? (
        <SettingsEmpty title="Select a project in the sidebar first." />
      ) : discovering ? (
        <SettingsEntitySkeleton label="Discovering skills…" />
      ) : !currentInventory?.capabilities.inventory ? null : projectSkills.length ? (
        projectSkills.map((skill) => (
          <SkillRow
            key={skill.id}
            skill={skill}
            configurable={currentInventory.capabilities.configure}
            busy={busy.has(skill.id)}
            onToggle={() => void toggle(skill)}
          />
        ))
      ) : (
        <SettingsEmpty title="No Agent Skills have been imported into this project." />
      )}
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

/**
 * One skill: its name along the leader to its switch (or to its state when
 * the provider does not let TasteCode change it), with what it does, where
 * it lives and anything it is missing underneath.
 */
function SkillRow(props: {
  skill: Skill
  configurable: boolean
  busy: boolean
  onToggle: () => void
}) {
  const name = props.skill.displayName ?? props.skill.name
  const source =
    props.skill.source.type === 'folder' ? props.skill.source.path : 'Managed by provider'
  return (
    <article className="set-entity" data-tone={props.skill.enabled ? undefined : 'muted'}>
      <div className="set-entity__main">
        <div className="set-entity__head">
          <h2 className="set-entity__name">{name}</h2>
          <span className="set-leader" aria-hidden />
          {props.configurable ? null : (
            <span className="set-entity__status">
              {props.skill.enabled ? 'Enabled' : 'Disabled'}
            </span>
          )}
        </div>
        {props.skill.description ? (
          <p className="set-entity__detail">{props.skill.description}</p>
        ) : null}
        <p className="set-entity__detail set-entity__detail--code" title={source}>
          {source}
        </p>
        {props.skill.dependencyErrors.map((entry) => (
          <p
            className="set-entity__detail set-entity__detail--error"
            key={`${entry.dependency}:${entry.message}`}
          >
            <AlertTriangle size={13} aria-hidden />
            <span>
              <strong>{entry.dependency}</strong> · {entry.message}
            </span>
          </p>
        ))}
      </div>
      {props.configurable ? (
        <div className="set-entity__actions">
          <button
            className={`switch${props.skill.enabled ? ' is-on' : ''}`}
            type="button"
            role="switch"
            aria-label={`${props.skill.enabled ? 'Disable' : 'Enable'} ${name}`}
            aria-checked={props.skill.enabled}
            disabled={props.busy}
            onClick={props.onToggle}
          >
            <span className="switch__thumb" />
          </button>
        </div>
      ) : null}
    </article>
  )
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
