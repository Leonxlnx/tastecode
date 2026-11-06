import type { ProviderPresentation } from '../provider-presentation.js'
import '../styles/source-identity.css'
import { ProviderIcon } from './ProviderIcon.js'

export function SourceIdentity(props: {
  presentation: ProviderPresentation
  qualifier?: string | undefined
  density?: 'compact' | 'regular' | undefined
  /** A hidden label stays for assistive tech and the tooltip; only the mark shows. */
  label?: 'visible' | 'hidden' | undefined
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
      <span className={props.label === 'hidden' ? 'visually-hidden' : 'source-identity__label'}>
        {props.presentation.label}
      </span>
      {props.qualifier ? (
        <span className="source-identity__qualifier">
          <span aria-hidden>·</span>
          {props.qualifier}
        </span>
      ) : null}
    </span>
  )
}
