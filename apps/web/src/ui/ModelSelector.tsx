import { useDeferredValue, useState, useSyncExternalStore } from 'react'
import {
  readModelPickerLayout,
  subscribeModelPickerLayout,
} from '../model-picker-layout.js'
import { Check, ChevronDown, Zap } from 'lucide-react'
import {
  filterModelChoicesByQuery,
  resolveReasoningEffort,
  type ModelChoice,
} from '../model-catalog.js'
import { Menu } from './Menu.js'
import { ModelSearchField } from './ModelSearchField.js'
import { ProviderIcon } from './ProviderIcon.js'

const TRIGGER_LABEL = 'Model and reasoning'
const DIALOG_LABEL = 'Model and reasoning'

type ModelSelectorProps = {
  models: ModelChoice[]
  modelId: string | undefined
  effort: string | undefined
  serviceTier: string | undefined
  disabled: boolean
  onModelChange: (id: string) => void
  onEffortChange: (value: string) => void
  onServiceTierChange: (value: string | undefined) => void
}

export function getCompactModelName(displayName: string | undefined): string {
  if (!displayName) return 'Model'
  return displayName
    .replace(/^gpt[-\s]*/i, '')
    .replace(/-/g, ' ')
    .trim()
}

export function getFriendlyEffortLabel(value: string | undefined): string {
  if (!value) return 'Default'
  if (value.toLowerCase() === 'xhigh') return 'Extra High'
  if (value.toLowerCase() === 'xlow') return 'Extra Low'
  return value
    .replace(/[_-]+/g, ' ')
    .replace(/\bx([a-z])/gi, (_, letter: string) => `extra ${letter}`)
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
}

export function getFastServiceTier(
  model: ModelChoice['model'] | undefined,
): { id: string; name: string; description: string } | undefined {
  return model?.serviceTiers.find((tier) => {
    const id = tier.id.trim().toLowerCase()
    const name = tier.name.trim().toLowerCase()
    return id === 'priority' || id === 'fast' || name === 'fast'
  })
}

export function getFastModeOffValue(model: ModelChoice['model'] | undefined): string | undefined {
  const defaultTier = model?.defaultServiceTier ?? undefined
  if (!defaultTier) return undefined
  return defaultTier === getFastServiceTier(model)?.id ? undefined : defaultTier
}

type ModelGroup = {
  key: string
  name: string
  mark: ModelChoice['mark']
  entries: ModelChoice[]
}

function modelSourceKey(entry: ModelChoice): string {
  return `${entry.provider}:${entry.connectionId ?? ''}:${entry.sourceName}`
}

/** One section per source, in catalog order, so a provider's name renders once. */
export function groupModelsBySource(models: ModelChoice[]): ModelGroup[] {
  const groups: ModelGroup[] = []
  for (const entry of models) {
    const key = modelSourceKey(entry)
    const group = groups.find((candidate) => candidate.key === key)
    if (group) group.entries.push(entry)
    else groups.push({ key, name: entry.sourceName, mark: entry.mark, entries: [entry] })
  }
  return groups
}

function getSelectedChoice(
  models: ModelChoice[],
  modelId: string | undefined,
): ModelChoice | undefined {
  return (
    models.find((entry) => entry.key === modelId) ??
    models.find((entry) => entry.model.isDefault) ??
    models[0]
  )
}

function getSelectedEffort(
  model: ModelChoice['model'] | undefined,
  effort: string | undefined,
): string | undefined {
  if (!model) return undefined
  return resolveReasoningEffort({ currentEffort: effort, nextModel: model })
}

function isFastModeEnabled(
  model: ModelChoice['model'] | undefined,
  serviceTier: string | undefined,
): boolean {
  return Boolean(serviceTier && getFastServiceTier(model)?.id === serviceTier)
}

function supportsServiceTier(
  model: ModelChoice['model'] | undefined,
  serviceTier: string | undefined,
): boolean {
  return Boolean(serviceTier && model?.serviceTiers.some((tier) => tier.id === serviceTier))
}

function ProviderModelList(props: {
  models: ModelChoice[]
  selectedChoice: ModelChoice | undefined
  onModelSelect: (choice: ModelChoice) => void
}) {
  const groups = groupModelsBySource(props.models)
  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query)
  const selectedGroupKey = props.selectedChoice
    ? modelSourceKey(props.selectedChoice)
    : groups[0]?.key
  const [activeGroupKey, setActiveGroupKey] = useState(selectedGroupKey)
  const activeGroup =
    groups.find((group) => group.key === activeGroupKey) ??
    groups.find((group) => group.key === selectedGroupKey) ??
    groups[0]
  const filteredEntries = activeGroup
    ? filterModelChoicesByQuery(activeGroup.entries, deferredQuery)
    : []

  return (
    <div className="model-selector__catalog">
      <div className="model-selector__providers" role="group" aria-label="Providers">
        {groups.map((group) => {
          const active = group.key === activeGroup?.key
          return (
            <button
              key={group.key}
              type="button"
              className={`model-selector__provider${active ? ' is-active' : ''}`}
              aria-label={`Show ${group.name} models`}
              aria-pressed={active}
              title={group.name}
              onClick={() => setActiveGroupKey(group.key)}
            >
              <ProviderIcon mark={group.mark} size={18} />
            </button>
          )
        })}
      </div>

      <div
        key={activeGroup?.key}
        className="model-selector__models"
        role="group"
        aria-label={activeGroup ? `${activeGroup.name} models` : 'Models'}
      >
        {activeGroup ? (
          <section className="model-selector__group">
            <div className="model-selector__group-head">
              <p className="model-selector__group-title">{activeGroup.name}</p>
              <ModelSearchField
                className="model-selector__search"
                value={query}
                label={`Search ${activeGroup.name} models`}
                autoFocus
                onChange={setQuery}
              />
            </div>
            {filteredEntries.length > 0 ? (
              filteredEntries.map((entry) => {
                const selected = entry.key === props.selectedChoice?.key
                return (
                  <button
                    key={entry.key}
                    type="button"
                    className={`model-selector__model${selected ? ' is-selected' : ''}`}
                    aria-pressed={selected}
                    aria-label={`Use ${entry.model.displayName} through ${entry.sourceName}`}
                    onClick={() => props.onModelSelect(entry)}
                  >
                    <span className="model-selector__model-name">{entry.model.displayName}</span>
                    {selected ? <Check size={14} aria-hidden /> : null}
                  </button>
                )
              })
            ) : (
              <p className="model-selector__empty" role="status">
                No matching models.
              </p>
            )}
          </section>
        ) : null}
      </div>
    </div>
  )
}

/** The original picker layout: one flat scrolling list, providers as inline
 *  section headings. Default; the provider-rail catalog is opt-in in Settings. */
function FlatModelList(props: {
  models: ModelChoice[]
  selectedChoice: ModelChoice | undefined
  onModelSelect: (choice: ModelChoice) => void
}) {
  return (
    <div
      className="model-selector__models model-selector__models--flat"
      role="group"
      aria-label="Models"
    >
      {groupModelsBySource(props.models).map((group) => (
        <section className="model-selector__group" key={group.key}>
          <p className="model-selector__group-title">
            <ProviderIcon mark={group.mark} size={13} />
            {group.name}
          </p>
          {group.entries.map((entry) => {
            const selected = entry.key === props.selectedChoice?.key
            return (
              <button
                key={entry.key}
                type="button"
                className={`model-selector__model${selected ? ' is-selected' : ''}`}
                aria-pressed={selected}
                aria-label={`Use ${entry.model.displayName} through ${entry.sourceName}`}
                onClick={() => props.onModelSelect(entry)}
              >
                <span className="model-selector__model-name">{entry.model.displayName}</span>
                {selected ? <Check size={14} aria-hidden /> : null}
              </button>
            )
          })}
        </section>
      ))}
    </div>
  )
}

/** Carries fast *intent* across models whose fast tiers use different ids
 *  (Codex 'priority', Cursor 'fast'). Used by the owner when a model changes. */
export function getNextServiceTierForModel(input: {
  nextModel: ModelChoice['model']
  currentModel: ModelChoice['model'] | undefined
  currentServiceTier: string | undefined
}): string | undefined {
  const { nextModel, currentModel, currentServiceTier } = input
  if (isFastModeEnabled(currentModel, currentServiceTier)) {
    return getFastServiceTier(nextModel)?.id ?? getFastModeOffValue(nextModel)
  }
  if (supportsServiceTier(nextModel, currentServiceTier)) {
    return currentServiceTier
  }
  return getFastModeOffValue(nextModel)
}

export function ModelSelector(props: ModelSelectorProps) {
  const pickerLayout = useSyncExternalStore(subscribeModelPickerLayout, readModelPickerLayout)
  const choice = getSelectedChoice(props.models, props.modelId)
  const model = choice?.model
  const selectedEffort = getSelectedEffort(model, props.effort)
  const effortOptions = model?.reasoningEfforts ?? []
  const effortLabel = getFriendlyEffortLabel(selectedEffort)
  const effortLabels = effortOptions.map((value) => getFriendlyEffortLabel(value))
  const selectedEffortIndex =
    selectedEffort === undefined ? -1 : Math.max(0, effortOptions.indexOf(selectedEffort))
  const fastTier = getFastServiceTier(model)
  const fastEnabled = isFastModeEnabled(model, props.serviceTier)

  const commitEffortIndex = (nextIndex: number) => {
    const nextValue = effortOptions[nextIndex]
    if (!nextValue || nextValue === selectedEffort) return
    props.onEffortChange(nextValue)
  }

  // Effort and tier for the new model are the owner's job (App.selectModel):
  // it restores the setup last used with that provider, falling back to the
  // ladder translation. Computing a second answer here raced that restore
  // and overwrote it whenever the two disagreed.
  const handleModelSelect = (nextChoice: ModelChoice) => {
    if (nextChoice.key !== choice?.key) {
      props.onModelChange(nextChoice.key)
    }
  }
  return (
    <Menu
      align="right"
      disabled={props.disabled}
      label={TRIGGER_LABEL}
      triggerClassName="menutrigger--model-selector"
      panelRole="dialog"
      panelLabel={DIALOG_LABEL}
      panelClassName="model-selector__menu"
      trigger={(open) => (
        <span className={`model-selector__trigger${open ? ' is-open' : ''}`}>
          {fastEnabled ? (
            <span className="model-selector__trigger-fast" aria-hidden>
              <Zap size={13} fill="currentColor" />
            </span>
          ) : null}
          <span className="model-selector__trigger-copy">
            <span className="model-selector__trigger-model">
              {choice ? <ProviderIcon mark={choice.mark} size={13} /> : null}
              {getCompactModelName(model?.displayName)}
            </span>
            <span className="model-selector__trigger-effort">{effortLabel}</span>
          </span>
          <span className="model-selector__trigger-chevron" aria-hidden>
            <ChevronDown size={16} />
          </span>
        </span>
      )}
    >
      {() => (
        <div className="model-selector">
          {pickerLayout === 'rail' ? (
            <ProviderModelList
              key={choice ? modelSourceKey(choice) : 'no-model'}
              models={props.models}
              selectedChoice={choice}
              onModelSelect={handleModelSelect}
            />
          ) : (
            <FlatModelList
              models={props.models}
              selectedChoice={choice}
              onModelSelect={handleModelSelect}
            />
          )}

          <div className="model-selector__controls">
            <div className="model-selector__controls-head">
              <span className="model-selector__effort-title">
                Effort: <span>{effortLabel}</span>
              </span>
              {fastTier ? (
                <div className="model-selector__fast-row">
                  <button
                    type="button"
                    className={`model-selector__fast${fastEnabled ? ' is-on' : ''}`}
                    aria-label={fastEnabled ? 'Disable fast mode' : 'Enable fast mode'}
                    aria-pressed={fastEnabled}
                    onClick={() =>
                      props.onServiceTierChange(
                        fastEnabled ? getFastModeOffValue(model) : fastTier.id,
                      )
                    }
                  >
                    <span className="model-selector__fast-icon" aria-hidden>
                      <Zap size={15} />
                    </span>
                  </button>
                </div>
              ) : null}
            </div>

            {effortOptions.length > 0 ? (
              <div
                className="model-selector__effort-options"
                role="radiogroup"
                aria-label="Reasoning effort"
              >
                {effortLabels.map((label, index) => (
                  <button
                    key={label}
                    type="button"
                    role="radio"
                    aria-checked={index === selectedEffortIndex}
                    className={`model-selector__effort-option${index === selectedEffortIndex ? ' is-selected' : ''}`}
                    disabled={props.disabled || effortOptions.length <= 1}
                    onClick={() => commitEffortIndex(index)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      )}
    </Menu>
  )
}
