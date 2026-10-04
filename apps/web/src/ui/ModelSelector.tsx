import { lazy, memo, Suspense } from 'react'
import { IconChevronDown as ChevronDown, IconBolt as Zap } from '@tabler/icons-react'
import { Menu } from './Menu.js'
import { ProviderIcon } from './ProviderIcon.js'
import { SkeletonRows, SkeletonStatus } from './Skeleton.js'
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
type ModelSelectorPanelModule = typeof import('./ModelSelectorPanel.js')
type ModelSelectorPanelComponent = ModelSelectorPanelModule['ModelSelectorPanel']
type LazyModelSelectorPanelModule = {
  default: ModelSelectorPanelComponent
}

let modelSelectorPanelPromise: Promise<LazyModelSelectorPanelModule> | undefined
let resolvedModelSelectorPanel: ModelSelectorPanelComponent | undefined
const loadModelSelectorPanel = (): Promise<LazyModelSelectorPanelModule> =>
  (modelSelectorPanelPromise ??= import('./ModelSelectorPanel.js').then((module) => {
    resolvedModelSelectorPanel = module.ModelSelectorPanel
    return { default: module.ModelSelectorPanel }
  }))
const ModelSelectorPanel = lazy(loadModelSelectorPanel)

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
      onTriggerIntent={loadModelSelectorPanel}
      trigger={(open) => (
        <span className={`model-selector__trigger${open ? ' is-open' : ''}`}>
          {fastEnabled ? (
            <span className="model-selector__trigger-fast" aria-hidden>
              <Zap size={13} fill="currentColor" />
            </span>
          ) : null}
          <span className="model-selector__trigger-copy">
            <span className="model-selector__trigger-model">
              {choice ? <ProviderIcon mark={choice.mark} size={14} /> : null}
              {getCompactModelName(model?.displayName)}
            </span>
            <span className="model-selector__trigger-effort">{effortLabel}</span>
          </span>
          <span className="model-selector__trigger-chevron" aria-hidden>
            <ChevronDown size={15} />
          </span>
        </span>
      )}
    >
      {() => {
        const ResolvedModelSelectorPanel = resolvedModelSelectorPanel
        if (ResolvedModelSelectorPanel) return <ResolvedModelSelectorPanel {...props} />
        return (
          <Suspense
            fallback={
              <SkeletonStatus label="Loading models…" className="model-selector__loading">
                <SkeletonRows rows={5} icon />
              </SkeletonStatus>
            }
          >
            <ModelSelectorPanel {...props} />
          </Suspense>
        )
      }}
    </Menu>
  )
})
