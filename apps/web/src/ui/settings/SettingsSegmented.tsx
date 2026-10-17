import { useRef, type KeyboardEvent } from 'react'
import '../../styles/settings-system.css'

export type SettingsSegmentedOption = { value: string; label: string; title?: string }

/**
 * A few equal choices side by side, the chosen one raised. It is one radio
 * group: Tab reaches the chosen option, and the arrow keys, Home and End move
 * the choice with the focus.
 */
export function SettingsSegmented(props: {
  ariaLabel: string
  value: string
  options: readonly SettingsSegmentedOption[]
  onChange: (value: string) => void
}) {
  const buttons = useRef<Array<HTMLButtonElement | null>>([])
  const selected = props.options.findIndex((option) => option.value === props.value)
  const focusable = selected >= 0 ? selected : 0

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const count = props.options.length
    let next: number
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % count
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp')
      next = (index - 1 + count) % count
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = count - 1
    else return
    event.preventDefault()
    const option = props.options[next]
    if (!option) return
    buttons.current[next]?.focus()
    if (option.value !== props.value) props.onChange(option.value)
  }

  return (
    <div className="set-segmented" role="radiogroup" aria-label={props.ariaLabel}>
      {props.options.map((option, index) => (
        <button
          key={option.value}
          ref={(element) => {
            buttons.current[index] = element
          }}
          className="set-segmented__option"
          type="button"
          role="radio"
          aria-checked={index === selected}
          tabIndex={index === focusable ? 0 : -1}
          title={option.title}
          onClick={() => {
            if (option.value !== props.value) props.onChange(option.value)
          }}
          onKeyDown={(event) => onKeyDown(event, index)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}
