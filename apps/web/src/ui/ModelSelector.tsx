import { useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react'
import { Check, ChevronDown, Zap } from 'lucide-react'
import type { ModelChoice } from '../model-catalog.js'
import { DitherSlider } from './dither-kit/DitherSlider.js'
import { Menu } from './Menu.js'
import { ProviderIcon } from './ProviderIcon.js'

const SLIDER_DITHER_MIN_WIDTH = 44
const SLIDER_DITHER_INSET = 2
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

export function getEffortIndexFromPointer(input: {
  clientX: number
  left: number
  width: number
  stopCount: number
}): number {
  if (input.stopCount <= 1) {
    return 0
  }
  const progress = getEffortProgressFromPointer(input)
  return Math.round(progress * (input.stopCount - 1))
}

export function getEffortProgressFromPointer(input: {
  clientX: number
  left: number
  width: number
}): number {
  const innerWidth = input.width - SLIDER_DITHER_INSET * 2
  if (innerWidth <= SLIDER_DITHER_MIN_WIDTH) return 0
  const travelWidth = innerWidth - SLIDER_DITHER_MIN_WIDTH
  const relativeX = input.clientX - input.left - SLIDER_DITHER_INSET - SLIDER_DITHER_MIN_WIDTH
  return Math.min(1, Math.max(0, relativeX / travelWidth))
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

/** One section per source, in catalog order, so a provider's name renders once. */
export function groupModelsBySource(models: ModelChoice[]): ModelGroup[] {
  const groups: ModelGroup[] = []
  for (const entry of models) {
    const key = `${entry.provider}:${entry.connectionId ?? ''}:${entry.sourceName}`
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
  if (effort && model.reasoningEfforts.includes(effort)) return effort
  return model.defaultReasoningEffort ?? model.reasoningEfforts[0]
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

function getNextServiceTierForModel(input: {
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

function setPointerCaptureSafe(target: HTMLDivElement, pointerId: number) {
  if (typeof target.setPointerCapture === 'function') {
    target.setPointerCapture(pointerId)
  }
}

function releasePointerCaptureSafe(target: HTMLDivElement, pointerId: number) {
  if (typeof target.releasePointerCapture === 'function') {
    target.releasePointerCapture(pointerId)
  }
}

function hasPointerCaptureSafe(target: HTMLDivElement, pointerId: number): boolean {
  return typeof target.hasPointerCapture === 'function' ? target.hasPointerCapture(pointerId) : true
}

function DitherChoiceRow(props: {
  label: string
  ariaLabel?: string
  optionLabels: string[]
  selectedIndex: number
  disabled: boolean
  onPreviewIndex: (index: number | null) => void
  onCommitIndex: (index: number) => void
}) {
  const [pointerIndex, setPointerIndex] = useState<number | null>(null)
  const pointerIndexRef = useRef<number | null>(null)

  const displayIndex = pointerIndex ?? props.selectedIndex
  const displayedLabel =
    props.optionLabels[displayIndex] ?? props.optionLabels[props.selectedIndex] ?? 'Default'
  const selectedProgress =
    displayIndex < 0 || props.optionLabels.length < 2
      ? 0.5
      : displayIndex / (props.optionLabels.length - 1)
  const ditherWidthOffset =
    (1 - selectedProgress) * SLIDER_DITHER_MIN_WIDTH - selectedProgress * SLIDER_DITHER_INSET * 2
  const ditherWidth = `calc(${selectedProgress * 100}% + ${ditherWidthOffset}px)`
  const sliderVars = {
    '--model-selector-slider-width': ditherWidth,
    '--model-selector-slider-inset': `${SLIDER_DITHER_INSET}px`,
  } as CSSProperties

  const previewFromPointer = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const nextIndex = getEffortIndexFromPointer({
      clientX: event.clientX,
      left: rect.left,
      width: rect.width,
      stopCount: props.optionLabels.length,
    })
    if (pointerIndexRef.current !== nextIndex) {
      pointerIndexRef.current = nextIndex
      setPointerIndex(nextIndex)
      props.onPreviewIndex(nextIndex)
    }
  }

  const commitIndex = (nextIndex: number) => {
    if (nextIndex === props.selectedIndex) return
    props.onCommitIndex(nextIndex)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (props.disabled || props.optionLabels.length === 0) return
    let nextIndex = props.selectedIndex < 0 ? 0 : props.selectedIndex
    if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
      nextIndex = Math.max(0, nextIndex - 1)
    } else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
      nextIndex = Math.min(props.optionLabels.length - 1, nextIndex + 1)
    } else if (event.key === 'Home') {
      nextIndex = 0
    } else if (event.key === 'End') {
      nextIndex = props.optionLabels.length - 1
    } else {
      return
    }
    event.preventDefault()
    commitIndex(nextIndex)
  }

  return (
    <div
      role="slider"
      tabIndex={props.disabled ? -1 : 0}
      aria-label={props.ariaLabel ?? props.label}
      aria-disabled={props.disabled}
      aria-valuemin={0}
      aria-valuemax={Math.max(0, props.optionLabels.length - 1)}
      aria-valuenow={Math.max(0, displayIndex)}
      aria-valuetext={displayedLabel}
      className={`model-selector__slider${props.disabled ? ' is-disabled' : ''}${pointerIndex !== null ? ' is-dragging' : ''}`}
      style={sliderVars}
      onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
      }}
      onKeyDown={handleKeyDown}
      onPointerDown={(event) => {
        if (props.disabled) return
        event.preventDefault()
        event.stopPropagation()
        setPointerCaptureSafe(event.currentTarget, event.pointerId)
        previewFromPointer(event)
      }}
      onPointerMove={(event) => {
        if (!props.disabled && hasPointerCaptureSafe(event.currentTarget, event.pointerId)) {
          previewFromPointer(event)
        }
      }}
      onPointerUp={(event) => {
        if (props.disabled || !hasPointerCaptureSafe(event.currentTarget, event.pointerId)) {
          return
        }
        event.preventDefault()
        event.stopPropagation()
        const rect = event.currentTarget.getBoundingClientRect()
        const nextIndex = getEffortIndexFromPointer({
          clientX: event.clientX,
          left: rect.left,
          width: rect.width,
          stopCount: props.optionLabels.length,
        })
        releasePointerCaptureSafe(event.currentTarget, event.pointerId)
        pointerIndexRef.current = null
        requestAnimationFrame(() => {
          commitIndex(nextIndex)
          setPointerIndex(null)
          props.onPreviewIndex(null)
        })
      }}
      onPointerCancel={(event) => {
        if (hasPointerCaptureSafe(event.currentTarget, event.pointerId)) {
          releasePointerCaptureSafe(event.currentTarget, event.pointerId)
        }
        pointerIndexRef.current = null
        setPointerIndex(null)
        props.onPreviewIndex(null)
      }}
    >
      <div className="model-selector__slider-track">
        <div className="model-selector__slider-fill">
          <DitherSlider active={!props.disabled && pointerIndex !== null} />
        </div>
        <div className="model-selector__slider-stops" aria-hidden>
          {props.optionLabels.map((option, index) => (
            <span
              className={`model-selector__slider-stop${index <= displayIndex ? ' is-active' : ''}`}
              style={
                {
                  '--model-selector-stop': index / Math.max(1, props.optionLabels.length - 1),
                } as CSSProperties
              }
              key={option}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

export function ModelSelector(props: ModelSelectorProps) {
  const [previewEffortIndex, setPreviewEffortIndex] = useState<number | null>(null)
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
  const displayedEffortLabel =
    effortLabels[previewEffortIndex ?? selectedEffortIndex] ?? effortLabel

  const commitEffortIndex = (nextIndex: number) => {
    const nextValue = effortOptions[nextIndex]
    if (!nextValue || nextValue === selectedEffort) return
    props.onEffortChange(nextValue)
  }

  const handleModelSelect = (nextChoice: ModelChoice) => {
    const nextModel = nextChoice.model
    if (nextChoice.key !== choice?.key) {
      props.onModelChange(nextChoice.key)
    }

    if (
      nextModel.reasoningEfforts.length > 0 &&
      (!selectedEffort || !nextModel.reasoningEfforts.includes(selectedEffort))
    ) {
      const nextEffort = nextModel.defaultReasoningEffort ?? nextModel.reasoningEfforts[0]
      if (nextEffort && nextEffort !== selectedEffort) {
        props.onEffortChange(nextEffort)
      }
    }

    const nextServiceTier = getNextServiceTierForModel({
      nextModel,
      currentModel: model,
      currentServiceTier: props.serviceTier,
    })
    if (nextServiceTier !== props.serviceTier) {
      props.onServiceTierChange(nextServiceTier)
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
          <div className="model-selector__models" role="group" aria-label="Models">
            {groupModelsBySource(props.models).map((group) => (
              <section className="model-selector__group" key={group.key}>
                <p className="model-selector__group-title">
                  <ProviderIcon mark={group.mark} size={13} />
                  {group.name}
                </p>
                {group.entries.map((entry) => {
                  const selected = entry.key === choice?.key
                  return (
                    <button
                      key={entry.key}
                      type="button"
                      className={`model-selector__model${selected ? ' is-selected' : ''}`}
                      aria-pressed={selected}
                      aria-label={`Use ${entry.model.displayName} through ${entry.sourceName}`}
                      onClick={() => handleModelSelect(entry)}
                    >
                      <span className="model-selector__model-name">{entry.model.displayName}</span>
                      {selected ? <Check size={14} aria-hidden /> : null}
                    </button>
                  )
                })}
              </section>
            ))}
          </div>

          <div className="model-selector__controls">
            <div className="model-selector__controls-head">
              <span className="model-selector__effort-title">
                Effort: <span>{displayedEffortLabel}</span>
              </span>
              {fastTier ? (
                <div className="model-selector__fast-row">
                  {fastTier.description ? (
                    <span className="model-selector__fast-meta">{fastTier.description}</span>
                  ) : null}
                  <button
                    type="button"
                    className={`model-selector__fast${fastEnabled ? ' is-on' : ''}`}
                    aria-label={fastEnabled ? 'Disable fast mode' : 'Enable fast mode'}
                    aria-pressed={fastEnabled}
                    title={fastTier.description}
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
              <DitherChoiceRow
                label="Effort"
                ariaLabel="Reasoning effort"
                optionLabels={effortLabels}
                selectedIndex={selectedEffortIndex}
                disabled={props.disabled || effortOptions.length <= 1}
                onPreviewIndex={setPreviewEffortIndex}
                onCommitIndex={commitEffortIndex}
              />
            ) : null}
          </div>
        </div>
      )}
    </Menu>
  )
}
