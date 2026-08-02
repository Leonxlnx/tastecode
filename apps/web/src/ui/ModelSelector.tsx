import { useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react'
import type { Model } from '@harness/contracts'
import { Check, ChevronDown, Zap } from 'lucide-react'
import { DitherSlider } from './dither-kit/DitherSlider.js'
import { Menu } from './Menu.js'

const SLIDER_DITHER_MIN_WIDTH = 44
const SLIDER_DITHER_INSET = 2
const TRIGGER_LABEL = 'Model and reasoning'
const DIALOG_LABEL = 'Model and reasoning'

type ModelSelectorProps = {
  models: Model[]
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
  if (!value) return 'Automatic'
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
  model: Model | undefined,
): { id: string; name: string; description: string } | undefined {
  return model?.serviceTiers.find((tier) => {
    const id = tier.id.trim().toLowerCase()
    const name = tier.name.trim().toLowerCase()
    return id === 'priority' || id === 'fast' || name === 'fast'
  })
}

export function getFastModeOffValue(model: Model | undefined): string | undefined {
  const defaultTier = model?.defaultServiceTier ?? undefined
  if (!defaultTier) return undefined
  return defaultTier === getFastServiceTier(model)?.id ? undefined : defaultTier
}

function getSelectedModel(models: Model[], modelId: string | undefined): Model | undefined {
  return (
    models.find((entry) => entry.id === modelId) ??
    models.find((entry) => entry.isDefault) ??
    models[0]
  )
}

function getSelectedEffort(
  model: Model | undefined,
  effort: string | undefined,
): string | undefined {
  if (!model) return undefined
  if (effort && model.reasoningEfforts.includes(effort)) return effort
  return model.defaultReasoningEffort ?? model.reasoningEfforts[0]
}

function isFastModeEnabled(model: Model | undefined, serviceTier: string | undefined): boolean {
  return Boolean(serviceTier && getFastServiceTier(model)?.id === serviceTier)
}

function supportsServiceTier(model: Model | undefined, serviceTier: string | undefined): boolean {
  return Boolean(serviceTier && model?.serviceTiers.some((tier) => tier.id === serviceTier))
}

function getNextServiceTierForModel(input: {
  nextModel: Model
  currentModel: Model | undefined
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
  onCommitIndex: (index: number) => void
}) {
  const [pointerIndex, setPointerIndex] = useState<number | null>(null)
  const pointerIndexRef = useRef<number | null>(null)

  const displayIndex = pointerIndex ?? props.selectedIndex
  const displayedLabel =
    props.optionLabels[displayIndex] ?? props.optionLabels[props.selectedIndex] ?? 'Automatic'
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
        })
      }}
      onPointerCancel={(event) => {
        if (hasPointerCaptureSafe(event.currentTarget, event.pointerId)) {
          releasePointerCaptureSafe(event.currentTarget, event.pointerId)
        }
        pointerIndexRef.current = null
        setPointerIndex(null)
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

      <span className="model-selector__slider-value" aria-hidden>
        {displayedLabel}
      </span>
    </div>
  )
}

export function ModelSelector(props: ModelSelectorProps) {
  const model = getSelectedModel(props.models, props.modelId)
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

  const handleModelSelect = (nextModel: Model) => {
    if (nextModel.id !== model?.id) {
      props.onModelChange(nextModel.id)
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
      {(close) => (
        <div className="model-selector">
          <div className="model-selector__models" role="group" aria-label="Models">
            {props.models.map((entry) => {
              const selected = entry.id === model?.id
              return (
                <button
                  key={entry.id}
                  type="button"
                  className={`model-selector__model${selected ? ' is-selected' : ''}`}
                  aria-pressed={selected}
                  aria-label={`Use ${entry.displayName}`}
                  onClick={() => {
                    handleModelSelect(entry)
                    close()
                  }}
                >
                  <span className="model-selector__model-name">{entry.displayName}</span>
                  {selected ? <Check size={14} aria-hidden /> : null}
                </button>
              )
            })}
          </div>

          <div className="model-selector__controls">
            {fastTier ? (
              <div className="model-selector__fast-row">
                <span className="model-selector__fast-meta">1.5× Speed · 2.5× Usage</span>
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

            {effortOptions.length > 0 ? (
              <div className="model-selector__effort">
                <span className="model-selector__effort-title">Effort</span>
                <DitherChoiceRow
                  label="Effort"
                  ariaLabel="Reasoning effort"
                  optionLabels={effortLabels}
                  selectedIndex={selectedEffortIndex}
                  disabled={props.disabled || effortOptions.length <= 1}
                  onCommitIndex={commitEffortIndex}
                />
              </div>
            ) : null}
          </div>
        </div>
      )}
    </Menu>
  )
}
