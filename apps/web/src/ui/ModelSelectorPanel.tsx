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
import { ModelSearchField } from './ModelSearchField.js'
import { ProviderIcon } from './ProviderIcon.js'
import { SourceIdentity } from './SourceIdentity.js'
import {
  SLIDER_DITHER_INSET,
  SLIDER_DITHER_MIN_WIDTH,
  getEffortIndexFromPointer,
  getEffortProgressFromPointer,
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

/** Where `getEffortProgressFromPointer` puts the first and last stop, so the
 *  drawn stops and knob sit exactly where the pointer maths expects them. */
const EFFORT_RAIL_INSET = SLIDER_DITHER_INSET + SLIDER_DITHER_MIN_WIDTH / 2
/** A press has to travel this far before the knob starts following it, so a
 *  plain click glides to its stop instead of flashing the drag bubble. */
const EFFORT_DRAG_THRESHOLD = 3
/** A press this close to the knob centre grabs the knob where it was held. */
const EFFORT_KNOB_GRAB_RADIUS = 12

type EffortGesture = {
  pointerId: number
  startX: number
  /** Knob centre minus press position, kept for the whole drag so a grabbed
   *  knob does not jump to centre itself under the pointer. */
  grabOffset: number
  dragging: boolean
}

function effortProgress(index: number, stopCount: number): number {
  return index < 0 || stopCount < 2 ? 0.5 : index / (stopCount - 1)
}

function EffortRail(props: {
  label: string
  ariaLabel?: string
  optionLabels: string[]
  selectedIndex: number
  disabled: boolean
  onPreviewIndex: (index: number | null) => void
  onCommitIndex: (index: number) => void
}) {
  const [pointerIndex, setPointerIndex] = useState<number | null>(null)
  const [dragging, setDragging] = useState(false)
  const pointerIndexRef = useRef<number | null>(null)
  const gesture = useRef<EffortGesture | null>(null)

  const stopCount = props.optionLabels.length
  const displayIndex = pointerIndex ?? props.selectedIndex
  const displayedLabel =
    props.optionLabels[displayIndex] ?? props.optionLabels[props.selectedIndex] ?? 'Default'
  // The knob, fill and bubble all read this one progress value and move by
  // transform. A drag overrides it with a continuous --effort-drag-p that is
  // written straight to the element, so following the pointer re-renders
  // only when the nearest stop changes.
  const railVars = {
    '--effort-p': effortProgress(displayIndex, stopCount),
    '--effort-inset': `${EFFORT_RAIL_INSET}px`,
  } as CSSProperties

  const stops = props.optionLabels.map((option, index) => (
    <span
      className="model-selector__slider-stop"
      style={{ '--model-selector-stop': effortProgress(index, stopCount) } as CSSProperties}
      key={option}
    />
  ))

  const pointerX = (event: PointerEvent<HTMLDivElement>) =>
    event.clientX + (gesture.current?.grabOffset ?? 0)

  const indexAtPointer = (event: PointerEvent<HTMLDivElement>, rect: DOMRect) =>
    getEffortIndexFromPointer({
      clientX: pointerX(event),
      left: rect.left,
      width: rect.width,
      stopCount,
      currentIndex: pointerIndexRef.current,
    })

  const previewIndex = (nextIndex: number) => {
    if (pointerIndexRef.current === nextIndex) return
    const previousIndex = pointerIndexRef.current ?? displayIndex
    pointerIndexRef.current = nextIndex
    setPointerIndex(nextIndex)
    props.onPreviewIndex(nextIndex)
    if (nextIndex !== previousIndex) performAppHaptic('alignment')
  }

  const endGesture = (target: HTMLDivElement) => {
    gesture.current = null
    target.style.removeProperty('--effort-drag-p')
    pointerIndexRef.current = null
    setPointerIndex(null)
    setDragging(false)
    props.onPreviewIndex(null)
  }

  const commitIndex = (nextIndex: number) => {
    if (nextIndex === props.selectedIndex) return
    props.onCommitIndex(nextIndex)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // A key press is keyboard use again, so the knob's focus ring returns.
    delete event.currentTarget.dataset.pointerFocus
    if (props.disabled || stopCount === 0) return
    let nextIndex = props.selectedIndex < 0 ? 0 : props.selectedIndex
    if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
      nextIndex = Math.max(0, nextIndex - 1)
    } else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
      nextIndex = Math.min(stopCount - 1, nextIndex + 1)
    } else if (event.key === 'Home') {
      nextIndex = 0
    } else if (event.key === 'End') {
      nextIndex = stopCount - 1
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
      aria-valuemax={Math.max(0, stopCount - 1)}
      aria-valuenow={Math.max(0, displayIndex)}
      aria-valuetext={displayedLabel}
      className={`model-selector__slider${props.disabled ? ' is-disabled' : ''}${pointerIndex !== null ? ' is-pressed' : ''}${dragging ? ' is-dragging' : ''}`}
      style={railVars}
      onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
      }}
      onPointerEnter={() => {
        if (!props.disabled) prepareAppHaptics()
      }}
      onKeyDown={handleKeyDown}
      onBlur={(event) => {
        delete event.currentTarget.dataset.pointerFocus
      }}
      onPointerDown={(event) => {
        if (props.disabled) return
        event.preventDefault()
        event.stopPropagation()
        // preventDefault also cancels the browser's focus-on-press, which left
        // focus in the model search: arrow keys after a click typed there
        // instead of moving the effort.
        event.currentTarget.focus({ preventScroll: true })
        // Focus moved here from the search field still matches :focus-visible,
        // which ringed the knob after every click. Mark it as pointer focus.
        event.currentTarget.dataset.pointerFocus = ''
        prepareAppHaptics()
        setPointerCaptureSafe(event.currentTarget, event.pointerId)
        const rect = event.currentTarget.getBoundingClientRect()
        const knobX =
          rect.left +
          EFFORT_RAIL_INSET +
          effortProgress(displayIndex, stopCount) * (rect.width - EFFORT_RAIL_INSET * 2)
        gesture.current = {
          pointerId: event.pointerId,
          startX: event.clientX,
          grabOffset:
            Math.abs(event.clientX - knobX) <= EFFORT_KNOB_GRAB_RADIUS ? knobX - event.clientX : 0,
          dragging: false,
        }
        // A press anywhere on the rail moves the knob to that stop right away;
        // releasing without a drag keeps it there.
        previewIndex(indexAtPointer(event, rect))
      }}
      onPointerMove={(event) => {
        const active = gesture.current
        const target = event.currentTarget
        if (
          props.disabled ||
          !active ||
          active.pointerId !== event.pointerId ||
          !hasPointerCaptureSafe(target, event.pointerId)
        ) {
          return
        }
        if (!active.dragging) {
          if (Math.abs(event.clientX - active.startX) < EFFORT_DRAG_THRESHOLD) return
          active.dragging = true
          setDragging(true)
        }
        const rect = target.getBoundingClientRect()
        const progress = getEffortProgressFromPointer({
          clientX: pointerX(event),
          left: rect.left,
          width: rect.width,
        })
        target.style.setProperty('--effort-drag-p', String(progress))
        previewIndex(indexAtPointer(event, rect))
      }}
      onPointerUp={(event) => {
        const target = event.currentTarget
        if (props.disabled || !gesture.current || !hasPointerCaptureSafe(target, event.pointerId)) {
          // Capture can be lost without a pointercancel — a re-render under
          // the drag, the menu closing mid-gesture. Leaving the preview state
          // set showed an effort the composer was not going to send.
          if (gesture.current || pointerIndexRef.current !== null) endGesture(target)
          return
        }
        event.preventDefault()
        event.stopPropagation()
        const nextIndex = indexAtPointer(event, target.getBoundingClientRect())
        releasePointerCaptureSafe(target, event.pointerId)
        // Dropping the drag position and committing land in the same frame,
        // so the knob settles from where it was let go to the chosen stop.
        endGesture(target)
        commitIndex(nextIndex)
      }}
      onPointerCancel={(event) => {
        if (hasPointerCaptureSafe(event.currentTarget, event.pointerId)) {
          releasePointerCaptureSafe(event.currentTarget, event.pointerId)
        }
        endGesture(event.currentTarget)
      }}
    >
      <div className="model-selector__slider-rail" aria-hidden>
        <div className="model-selector__slider-fill" />
      </div>
      <div className="model-selector__slider-stops" aria-hidden>
        {stops}
      </div>
      <div
        className="model-selector__slider-stops model-selector__slider-stops--passed"
        aria-hidden
      >
        <div className="model-selector__slider-stops-inner">{stops}</div>
      </div>
      <span className="model-selector__slider-knob" aria-hidden />
      <span className="model-selector__slider-bubble" aria-hidden>
        {displayedLabel}
      </span>
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
            <EffortRail
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
