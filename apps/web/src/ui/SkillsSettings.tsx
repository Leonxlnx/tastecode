import { useEffect, useState } from 'react'
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

  useEffect(() => {
    if (!props.projectPath) {
      setInventory(undefined)
      setLoading(false)
      return
    }

    let active = true
    const load = async () => {
      setLoading(true)
      try {
        const next = await props.transport.request('skills.list', {
          provider: props.provider,
          projectPath: props.projectPath!,
        })
        if (active) {
          setInventory(next)
          setError(undefined)
        }
      } catch (cause) {
        if (active) setError(message(cause))
      } finally {
        if (active) setLoading(false)
      }
    }
    setInventory(undefined)
    setError(undefined)
    void load()
    const off = props.transport.on('skills.changed', ({ provider, projectPath }) => {
      if (provider === props.provider && projectPath === props.projectPath) void load()
    })
    return () => {
      active = false
      off()
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
      setError(message(cause))
    } finally {
      setBusy(undefined)
    }
  }

  async function install(): Promise<void> {
    if (!props.projectPath) return
    const folderPath = await pickSkillFolder()
    if (!folderPath) return
    setBusy('install')
    setError(undefined)
    try {
      const { skill } = await props.transport.request('skills.installFromFolder', {
        provider: props.provider,
        projectPath: props.projectPath,
        folderPath,
      })
      setInventory((current) =>
        current
          ? {
              ...current,
              skills: [...current.skills.filter((entry) => entry.id !== skill.id), skill],
            }
          : current,
      )
    } catch (cause) {
      setError(message(cause))
    } finally {
      setBusy(undefined)
    }
  }

  const project = props.projectName ?? props.projectPath
  const status = !props.projectPath
    ? 'Select a project in the sidebar first.'
    : loading
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
