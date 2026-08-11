import { useEffect, useRef, useState } from 'react'
import type { ProviderId, ResultOf, Skill } from '@harness/contracts'
import { AlertTriangle, FolderPlus } from 'lucide-react'
import { pickSkillFolder } from '../bridge.js'
import type { Transport } from '../transport.js'

type Inventory = ResultOf<'skills.list'>

export function SkillsSettings(props: {
  transport: Transport
  provider: ProviderId
  providerName: string
  projectPath: string | undefined
  projectName: string | undefined
}) {
  const [inventory, setInventory] = useState<Inventory>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState<string>()
  const [reload, setReload] = useState(0)
  const inventoryGeneration = useRef(0)
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
      setLoading(false)
      setError(undefined)
      setBusy(undefined)
      return
    }

    let active = true
    // Ordered: two overlapping refreshes (initial load racing a
    // skills.changed push) must not land out of order.
    const load = async () => {
      const mine = ++inventoryGeneration.current
      setLoading(true)
      try {
        const next = await props.transport.request('skills.list', {
          provider: props.provider,
          projectPath: props.projectPath!,
        })
        if (active && mine === inventoryGeneration.current) {
          setInventory(next)
          setError(undefined)
        }
      } catch (cause) {
        if (active && mine === inventoryGeneration.current) setError(message(cause))
      } finally {
        if (active && mine === inventoryGeneration.current) setLoading(false)
      }
    }
    setInventory(undefined)
    setError(undefined)
    setBusy(undefined)
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
    setBusy(skill.id)
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
      if (isCurrentContext()) setBusy(undefined)
    }
  }

  async function install(): Promise<void> {
    if (!props.projectPath) return
    setError(undefined)
    try {
      const folderPath = await pickSkillFolder()
      if (!folderPath || !isCurrentContext()) return
      setBusy('install')
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
      if (isCurrentContext()) setBusy(undefined)
    }
  }

  const project = props.projectName ?? props.projectPath
  const status = !props.projectPath
    ? 'Select a project in the sidebar first.'
    : // A background refresh keeps the current list on screen; blanking it
      // to a loading note on every skills.changed push read as flicker.
      loading && !inventory
      ? 'Discovering skills…'
      : !inventory
        ? undefined
        : !inventory.capabilities.inventory
          ? `${props.providerName} does not expose Agent Skills here yet.`
          : inventory.skills.length === 0
            ? 'No skills were discovered for this project.'
            : undefined

  return (
    <section className="settings__panel skills-settings" aria-labelledby="settings-skills">
      <header className="skills-settings__header">
        <div>
          <h1 className="settings__title" id="settings-skills">
            Agent Skills
          </h1>
          <p>{project ? `Available in ${project}` : 'Choose a project to manage its skills.'}</p>
        </div>
        {props.projectPath && inventory?.capabilities.install ? (
          <button
            className="settings__action"
            type="button"
            disabled={busy !== undefined}
            onClick={() => void install()}
          >
            <FolderPlus size={14} aria-hidden />
            {busy === 'install' ? 'Installing…' : 'Install from folder'}
          </button>
        ) : null}
      </header>

      {error ? (
        <p className="skills-settings__error" role="alert">
          {error}{' '}
          <button
            className="settings__action"
            type="button"
            onClick={() => setReload((n) => n + 1)}
          >
            Retry
          </button>
        </p>
      ) : null}
      {status ? <p className="skills-settings__empty">{status}</p> : null}
      {inventory?.errors.length ? (
        <div className="skills-settings__error" role="alert">
          <strong>Some skills could not be loaded</strong>
          {inventory.errors.map((entry) => (
            <p key={`${entry.path}:${entry.message}`}>
              {entry.message} · {entry.path}
            </p>
          ))}
        </div>
      ) : null}
      {inventory?.capabilities.inventory && inventory.skills.length ? (
        <div className="settings__group">
          {inventory.skills.map((skill) => (
            <SkillRow
              key={skill.id}
              skill={skill}
              configurable={inventory.capabilities.configure}
              busy={busy === skill.id}
              onToggle={() => void toggle(skill)}
            />
          ))}
        </div>
      ) : null}
    </section>
  )
}

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
    <article className={`settings__row skill-row${props.skill.enabled ? '' : ' is-disabled'}`}>
      <div className="settings__row-copy">
        <div className="skill-row__heading">
          <h2>{name}</h2>
          <span>{props.skill.scope === 'project' ? 'Project' : props.skill.scope}</span>
          <span>{props.skill.enabled ? 'Enabled' : 'Disabled'}</span>
        </div>
        <p className="skill-row__description">{props.skill.description}</p>
        <p className="skill-row__source" title={source}>
          {source}
        </p>
        {props.skill.dependencyErrors.map((entry) => (
          <p className="skill-row__dependency" key={`${entry.dependency}:${entry.message}`}>
            <AlertTriangle size={13} aria-hidden />
            <strong>{entry.dependency}</strong> · {entry.message}
          </p>
        ))}
      </div>
      {props.configurable ? (
        <div className="settings__row-control">
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

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
