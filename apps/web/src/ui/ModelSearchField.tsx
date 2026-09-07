import { useRef } from 'react'
import { IconSearch as Search, IconX as X } from '@tabler/icons-react'
import '../styles/model-search.css'

export function ModelSearchField(props: {
  value: string
  label: string
  placeholder?: string
  className?: string
  autoFocus?: boolean
  onChange: (value: string) => void
  onNavigate?: (edge: 'first' | 'last') => void
}) {
  const input = useRef<HTMLInputElement>(null)

  return (
    <div className={`model-search${props.className ? ` ${props.className}` : ''}`}>
      <Search size={13} aria-hidden />
      <input
        ref={input}
        type="search"
        value={props.value}
        placeholder={props.placeholder ?? 'Search models'}
        aria-label={props.label}
        autoComplete="off"
        autoCapitalize="none"
        autoFocus={props.autoFocus}
        spellCheck={false}
        onChange={(event) => props.onChange(event.currentTarget.value)}
        onKeyDown={(event) => {
          if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && props.onNavigate) {
            event.preventDefault()
            event.stopPropagation()
            props.onNavigate(event.key === 'ArrowDown' ? 'first' : 'last')
            return
          }
          if (event.key !== 'Escape' || !props.value) return
          event.preventDefault()
          event.stopPropagation()
          props.onChange('')
        }}
      />
      {props.value ? (
        <button
          type="button"
          aria-label={`Clear ${props.label}`}
          onClick={() => {
            props.onChange('')
            input.current?.focus()
          }}
        >
          <X size={12} aria-hidden />
        </button>
      ) : null}
    </div>
  )
}
