import { lazy, memo, Suspense } from 'react'
import { ChevronDown, Zap } from 'lucide-react'
import { Menu } from './Menu.js'
import { ProviderIcon } from './ProviderIcon.js'
import {
  getCompactModelName,
  getFriendlyEffortLabel,
  getSelectedChoice,
  getSelectedEffort,
  isFastModeEnabled,
  type ModelSelectorProps,
} from './model-selector-utils.js'
import '../styles/model-selector.css'

const TRIGGER_LABEL = 'Model and reasoning'
const DIALOG_LABEL = 'Model and reasoning'
const ModelSelectorPanel = lazy(() =>
  import('./ModelSelectorPanel.js').then((module) => ({
    default: module.ModelSelectorPanel,
  })),
)

export {
  getCompactModelName,
  getEffortIndexFromPointer,
  getEffortProgressFromPointer,
  getFastModeOffValue,
  getFastServiceTier,
  getFriendlyEffortLabel,
  getNextServiceTierForModel,
  groupModelsBySource,
} from './model-selector-utils.js'
export type { ModelSelectorProps } from './model-selector-utils.js'

export const ModelSelector = memo(function ModelSelector(props: ModelSelectorProps) {
  const choice = getSelectedChoice(props.models, props.modelId)
  const model = choice?.model
  const selectedEffort = getSelectedEffort(model, props.effort)
  const effortLabel = getFriendlyEffortLabel(selectedEffort)
  const fastEnabled = isFastModeEnabled(model, props.serviceTier)

  return (
    <Menu
      align="right"
      disabled={props.disabled}
      label={TRIGGER_LABEL}
      triggerClassName="menutrigger--model-selector"
      panelRole="dialog"
      panelLabel={DIALOG_LABEL}
      panelClassName="model-selector__menu"
      onOpen={props.onOpen}
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
        <Suspense
          fallback={
            <div className="model-selector__loading" role="status">
              Loading models…
            </div>
          }
        >
          <ModelSelectorPanel {...props} />
        </Suspense>
      )}
    </Menu>
  )
})
