import {
  useDeferredValue,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
} from 'react'
import { IconCheck as Check, IconBolt as Zap } from '@tabler/icons-react'
import { performAppHaptic, prepareAppHaptics } from '../haptics.js'
import { readModelPickerLayout, subscribeModelPickerLayout } from '../model-picker-layout.js'
import { filterModelChoicesByQuery, type ModelChoice } from '../model-catalog.js'
import { DitherSlider } from './dither-kit/DitherSlider.js'
import { ModelSearchField } from './ModelSearchField.js'
import { ProviderIcon } from './ProviderIcon.js'
import { SourceIdentity } from './SourceIdentity.js'
import {
  SLIDER_DITHER_INSET,
  SLIDER_DITHER_MIN_WIDTH,
  getEffortIndexFromPointer,
  getFastModeOffValue,
  getFastServiceTier,
  getFriendlyEffortLabel,
  getSelectedChoice,
  getSelectedEffort,
  groupModelsBySource,
  isFastModeEnabled,
  modelSourceKey,
  type ModelSelectorProps,
} from './model-selector-utils.js'
import '../styles/model-selector-menu.css'

function ProviderModelList(props: {
  models: ModelChoice[]
  selectedChoice: ModelChoice | undefined
  onModelSelect: (choice: ModelChoice) => void
}) {
  const catalog = useRef<HTMLDivElement>(null)
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
  const searching = deferredQuery.trim().length > 0
  const filteredGroups = searching
    ? groupModelsBySource(filterModelChoicesByQuery(props.models, deferredQuery))
    : groups
  const visibleGroup =
    filteredGroups.find((group) => group.key === activeGroup?.key) ??
    filteredGroups[0] ??
    activeGroup
  const filteredEntries = searching
    ? (filteredGroups.find((group) => group.key === visibleGroup?.key)?.entries ?? [])
    : (visibleGroup?.entries ?? [])
  const focusResult = (edge: 'first' | 'last') => focusModelResult(catalog.current, edge)

  return (
    <div className="model-selector__catalog" ref={catalog}>
      <div className="model-selector__providers" role="group" aria-label="Providers">
        {groups.map((group) => {
          const active = group.key === visibleGroup?.key
          return (
            <button
              key={group.key}
              type="button"
              className={`model-selector__provider${active ? ' is-active' : ''}`}
              aria-label={`Show ${group.name} models`}
              aria-pressed={active}
              title={group.name}
              onClick={() => {
                setActiveGroupKey(group.key)
                setQuery('')
              }}
            >
              <ProviderIcon mark={group.mark} size={18} />
            </button>
          )
        })}
      </div>

      <div
        className="model-selector__models"
        role="group"
        aria-label={visibleGroup ? `${visibleGroup.name} models` : 'Models'}
      >
        {visibleGroup ? (
          <section className="model-selector__group">
            <div className="model-selector__group-head">
              <p className="model-selector__group-title">
                <SourceIdentity
                  presentation={{ label: visibleGroup.name, mark: visibleGroup.mark }}
                />
              </p>
              <ModelSearchField
                className="model-selector__search"
                value={query}
                label="Search models"
                autoFocus
                onChange={setQuery}
                onNavigate={focusResult}
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
  const list = useRef<HTMLDivElement>(null)
  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query)
  const groups = groupModelsBySource(filterModelChoicesByQuery(props.models, deferredQuery))

  return (
    <div
      className="model-selector__models model-selector__models--flat"
      role="group"
      aria-label="Models"
      ref={list}
    >
      <div className="model-selector__flat-head">
        <ModelSearchField
          className="model-selector__search"
          value={query}
          label="Search models"
          autoFocus
          onChange={setQuery}
          onNavigate={(edge) => focusModelResult(list.current, edge)}
        />
      </div>
      {groups.map((group) => (
        <section className="model-selector__group" key={group.key}>
          <p className="model-selector__group-title">
            <SourceIdentity
              presentation={{ label: group.name, mark: group.mark }}
              density="compact"
            />
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
      {groups.length === 0 ? (
        <p className="model-selector__empty" role="status">
          No matching models.
        </p>
      ) : null}
    </div>
  )
}

function focusModelResult(container: HTMLElement | null, edge: 'first' | 'last'): void {
  const results = container?.querySelectorAll<HTMLButtonElement>('.model-selector__model')
  const index = edge === 'first' ? 0 : (results?.length ?? 0) - 1
  results?.[index]?.focus()
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
      const previousIndex = pointerIndexRef.current ?? displayIndex
      pointerIndexRef.current = nextIndex
      setPointerIndex(nextIndex)
      props.onPreviewIndex(nextIndex)
      if (nextIndex !== previousIndex) performAppHaptic('alignment')
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
      onPointerEnter={() => {
        if (!props.disabled) prepareAppHaptics()
      }}
      onKeyDown={handleKeyDown}
      onPointerDown={(event) => {
        if (props.disabled) return
        event.preventDefault()
        event.stopPropagation()
        prepareAppHaptics()
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
          // Capture can be lost without a pointercancel — a re-render under
          // the drag, the menu closing mid-gesture. Leaving the preview state
          // set showed an effort the composer was not going to send.
          if (pointerIndexRef.current !== null) {
            pointerIndexRef.current = null
            setPointerIndex(null)
            props.onPreviewIndex(null)
          }
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

export function ModelSelectorPanel(props: ModelSelectorProps) {
  const [previewEffortIndex, setPreviewEffortIndex] = useState<number | null>(null)
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
  const displayedEffortLabel =
    effortLabels[previewEffortIndex ?? selectedEffortIndex] ?? effortLabel

  const commitEffortIndex = (nextIndex: number) => {
    const nextValue = effortOptions[nextIndex]
    if (!nextValue || nextValue === selectedEffort) return
    props.onEffortChange(nextValue)
  }

  const handleModelSelect = (nextChoice: ModelChoice) => {
    if (nextChoice.key !== choice?.key) props.onModelChange(nextChoice.key)
  }

  return (
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

      {effortOptions.length > 0 || fastTier ? (
        <div
          className={`model-selector__controls${effortOptions.length === 0 ? ' is-fast-only' : ''}`}
        >
          <div className="model-selector__controls-head">
            {effortOptions.length > 0 ? (
              <span className="model-selector__effort-title">
                Effort: <span>{displayedEffortLabel}</span>
              </span>
            ) : null}
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
      ) : null}
    </div>
  )
}
