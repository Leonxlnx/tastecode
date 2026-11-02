import { useDeferredValue, useId, useMemo, useState, type ReactNode } from 'react'
import { IconChevronRight as ChevronRight } from '@tabler/icons-react'
import {
  filterModelChoicesByQuery,
  groupModelChoicesByLab,
  type ModelChoice,
  type ModelLabGroup,
} from '../model-catalog.js'
import { ModelSearchField } from './ModelSearchField.js'
import { ModelBulkActions, ModelVisibilityRow } from './ModelVisibilityControls.js'
import { SettingsRow, SettingsSection } from './settings/SettingsLayout.js'
import '../styles/model-lab-section.css'

/** A source that lists more models than this is grouped by lab, collapsed and searchable. */
export const LARGE_MODEL_SOURCE_ROWS = 20

const NO_LABS: ReadonlySet<string> = new Set()

function toggled(keys: ReadonlySet<string>, key: string): ReadonlySet<string> {
  const next = new Set(keys)
  if (!next.delete(key)) next.add(key)
  return next
}

/** Labs with a model in the picker first, then the source's own order; the rows without a lab stay last. */
function orderLabs(groups: readonly ModelLabGroup[], hidden: ReadonlySet<string>): string[] {
  const shown = (group: ModelLabGroup) =>
    group.lab !== undefined && group.choices.some((choice) => !hidden.has(choice.key))
  return [...groups.filter(shown), ...groups.filter((group) => !shown(group))].map(
    (group) => group.key,
  )
}

/**
 * The lab order, settled when the set of labs changes rather than on every
 * switch, so a lab never jumps away while its rows are being toggled.
 */
function useLabOrder(groups: readonly ModelLabGroup[], hidden: ReadonlySet<string>) {
  const labs = groups.map((group) => group.key).join('\n')
  const [settled, setSettled] = useState(() => ({ labs, order: orderLabs(groups, hidden) }))
  if (settled.labs === labs) return settled.order
  const next = { labs, order: orderLabs(groups, hidden) }
  setSettled(next)
  return next.order
}

/**
 * A source with more models than one list can carry: how many reach the
 * picker, a search, and one collapsed group per lab. Only open groups render
 * their rows. All and None act on the rows listed under them: the whole
 * source, or its matches while a search runs.
 */
export function ModelLabSection(props: {
  title: ReactNode
  source: string
  choices: ModelChoice[]
  hiddenModels: ReadonlySet<string>
  onModelVisibilityChange: (key: string, visible: boolean) => void
  onModelsVisibilityChange: (keys: readonly string[], visible: boolean) => void
}) {
  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query)
  const searching = deferredQuery.trim().length > 0
  // Labs opened by hand; during a search every lab with a hit is open unless
  // it was closed for that search.
  const [opened, setOpened] = useState(NO_LABS)
  const [closedHits, setClosedHits] = useState(NO_LABS)

  const groups = useMemo(() => groupModelChoicesByLab(props.choices), [props.choices])
  const order = useLabOrder(groups, props.hiddenModels)
  const listedGroups = useMemo(() => {
    const byKey = new Map(groups.map((group) => [group.key, group]))
    const ordered = order.flatMap((key) => byKey.get(key) ?? [])
    if (!searching) return ordered
    const hits = new Set(
      filterModelChoicesByQuery(props.choices, deferredQuery).map((choice) => choice.key),
    )
    return ordered.flatMap((group) => {
      const choices = group.choices.filter((choice) => hits.has(choice.key))
      return choices.length > 0 ? [{ ...group, choices }] : []
    })
  }, [groups, order, searching, deferredQuery, props.choices])
  const listed = searching ? listedGroups.flatMap((group) => group.choices) : props.choices
  const shownCount = props.choices.filter((choice) => !props.hiddenModels.has(choice.key)).length
  const onlyGroup = groups.length === 1

  return (
    <SettingsSection
      title={props.title}
      note={`${shownCount} of ${props.choices.length} shown in the model picker.`}
      action={
        <ModelBulkActions
          name={searching ? `matching ${props.source} models` : `${props.source} models`}
          groupLabel={`${props.source} model visibility`}
          choices={listed}
          hiddenModels={props.hiddenModels}
          onModelsVisibilityChange={props.onModelsVisibilityChange}
        />
      }
    >
      <ModelSearchField
        className="model-labs__search"
        label={`Search ${props.source} models`}
        value={query}
        onChange={(next) => {
          setQuery(next)
          setClosedHits(NO_LABS)
        }}
      />
      {listedGroups.length === 0 ? (
        <p className="model-labs__empty">
          No {props.source} models match “{deferredQuery.trim()}”.
        </p>
      ) : (
        listedGroups.map((group) => (
          <ModelLab
            key={group.key}
            source={props.source}
            group={group}
            only={onlyGroup}
            searching={searching}
            open={searching ? !closedHits.has(group.key) : opened.has(group.key)}
            onToggle={() =>
              (searching ? setClosedHits : setOpened)((keys) => toggled(keys, group.key))
            }
            hiddenModels={props.hiddenModels}
            onModelVisibilityChange={props.onModelVisibilityChange}
            onModelsVisibilityChange={props.onModelsVisibilityChange}
          />
        ))
      )}
    </SettingsSection>
  )
}

/**
 * One lab: a disclosure row with how many of its models are shown, then its
 * rows while open. The rows that name no lab close the list as "Other", or as
 * "All models" when no row names one.
 */
function ModelLab(props: {
  source: string
  group: ModelLabGroup
  /** The source's only group, whose All and None would repeat the source's own. */
  only: boolean
  searching: boolean
  open: boolean
  onToggle: () => void
  hiddenModels: ReadonlySet<string>
  onModelVisibilityChange: (key: string, visible: boolean) => void
  onModelsVisibilityChange: (keys: readonly string[], visible: boolean) => void
}) {
  const rowsId = useId()
  const { choices, lab } = props.group
  const shown = choices.filter((choice) => !props.hiddenModels.has(choice.key)).length
  const label = lab ?? (props.only ? 'All models' : 'Other')
  const rowsLabel = lab ? `${lab} models` : props.only ? label : 'Other models'
  const models = lab ? `${lab} models from ${props.source}` : `other ${props.source} models`

  return (
    <div className="model-lab" data-open={props.open || undefined}>
      <SettingsRow
        className="model-lab__head"
        tone={shown === 0 ? 'muted' : undefined}
        name={
          <button
            className="model-lab__toggle"
            type="button"
            aria-expanded={props.open}
            aria-controls={props.open ? rowsId : undefined}
            onClick={props.onToggle}
          >
            <ChevronRight className="model-lab__chevron" size={14} aria-hidden />
            {label}
          </button>
        }
      >
        <span className="model-lab__count">
          {shown} of {choices.length}
        </span>
        {props.open && !props.only ? (
          <ModelBulkActions
            name={props.searching ? `matching ${models}` : models}
            groupLabel={`Visibility of ${models}`}
            choices={choices}
            hiddenModels={props.hiddenModels}
            onModelsVisibilityChange={props.onModelsVisibilityChange}
          />
        ) : null}
      </SettingsRow>
      {props.open ? (
        <div className="model-lab__rows" id={rowsId} role="group" aria-label={rowsLabel}>
          {choices.map((choice) => (
            <ModelVisibilityRow
              key={choice.key}
              choice={choice}
              visible={!props.hiddenModels.has(choice.key)}
              onModelVisibilityChange={props.onModelVisibilityChange}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}
