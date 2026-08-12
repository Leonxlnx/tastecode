import type { ProviderPresentation } from '../provider-presentation.js'
import { ProviderIcon } from './ProviderIcon.js'

export function SourceIdentity(props: {
  presentation: ProviderPresentation
  qualifier?: string | undefined
  density?: 'compact' | 'regular' | undefined
  className?: string | undefined
}) {
  const density = props.density ?? 'regular'
  const title = props.qualifier
    ? `${props.presentation.label} · ${props.qualifier}`
    : props.presentation.label

  return (
    <span
      className={`source-identity source-identity--${density}${props.className ? ` ${props.className}` : ''}`}
      title={title}
    >
      <span className="source-identity__mark" aria-hidden>
        <ProviderIcon mark={props.presentation.mark} size={density === 'compact' ? 11 : 15} />
      </span>
      <span className="source-identity__label">{props.presentation.label}</span>
      {props.qualifier ? (
        <span className="source-identity__qualifier">
          <span aria-hidden>·</span>
          {props.qualifier}
        </span>
      ) : null}
    </span>
  )
}
