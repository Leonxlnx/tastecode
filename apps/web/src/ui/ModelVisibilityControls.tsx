import type { ModelChoice } from '../model-catalog.js'
import { formatModelName } from './model-selector-utils.js'
import { SettingsRow } from './settings/SettingsLayout.js'
import '../styles/switch.css'

/**
 * All and None for a run of model rows. Each changes every row that differs
 * in one call, never row by row; the one that would change nothing is dimmed.
 * `name` completes "Show all … in model picker", e.g. "Grok models".
 */
export function ModelBulkActions(props: {
  name: string
  groupLabel: string
  choices: readonly ModelChoice[]
  hiddenModels: ReadonlySet<string>
  onModelsVisibilityChange: (keys: readonly string[], visible: boolean) => void
}) {
  const visibleCount = props.choices.filter((choice) => !props.hiddenModels.has(choice.key)).length
  const allVisible = visibleCount === props.choices.length
  const noneVisible = visibleCount === 0

  const setAllVisible = (visible: boolean) => {
    props.onModelsVisibilityChange(
      props.choices
        .filter((choice) => props.hiddenModels.has(choice.key) === visible)
        .map((choice) => choice.key),
      visible,
    )
  }

  return (
    <div className="model-visibility__bulk-actions" role="group" aria-label={props.groupLabel}>
      <button
        type="button"
        aria-label={`Show all ${props.name} in model picker`}
        disabled={allVisible}
        onClick={() => setAllVisible(true)}
      >
        All
      </button>
      <button
        type="button"
        aria-label={`Hide all ${props.name} from model picker`}
        disabled={noneVisible}
        onClick={() => setAllVisible(false)}
      >
        None
      </button>
    </div>
  )
}

/** One model as a leader row whose value is its picker switch; a hidden model's row is muted. */
export function ModelVisibilityRow(props: {
  choice: ModelChoice
  visible: boolean
  onModelVisibilityChange: (key: string, visible: boolean) => void
}) {
  const { choice, visible } = props
  const name = formatModelName(choice.model.displayName)
  return (
    <SettingsRow
      className="model-visibility__model"
      name={name}
      tone={visible ? undefined : 'muted'}
    >
      <button
        className={`switch${visible ? ' is-on' : ''}`}
        type="button"
        role="switch"
        aria-label={`Include ${name} in model picker`}
        aria-checked={visible}
        onClick={() => props.onModelVisibilityChange(choice.key, !visible)}
      >
        <span className="switch__thumb" />
      </button>
    </SettingsRow>
  )
}
