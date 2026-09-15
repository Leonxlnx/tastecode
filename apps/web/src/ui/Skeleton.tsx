import type { CSSProperties, ReactNode } from 'react'

import '../styles/skeleton.css'

type Size = number | string

function cls(className: string | undefined): string {
  return className ? ` ${className}` : ''
}

function cycle<T>(pattern: readonly T[], index: number): T {
  return pattern[index % pattern.length]!
}

/** One placeholder bar. Sized by the composition it sits in, or inline. */
export function Skeleton(props: {
  className?: string | undefined
  width?: Size | undefined
  height?: Size | undefined
  style?: CSSProperties | undefined
}) {
  const style: CSSProperties = { ...props.style }
  if (props.width !== undefined) style.width = props.width
  if (props.height !== undefined) style.height = props.height
  return <span className={`skeleton${cls(props.className)}`} style={style} aria-hidden />
}

/**
 * A skeleton that is announced as the text it replaced. Assistive tech hears
 * the same status line as before; sighted users see the layout arriving.
 */
export function SkeletonStatus(props: {
  label: string
  className?: string | undefined
  children: ReactNode
}) {
  return (
    <div className={`skeleton-group${cls(props.className)}`} role="status" aria-busy="true">
      <span className="visually-hidden">{props.label}</span>
      {props.children}
    </div>
  )
}

// Fixed width patterns: a placeholder that reshuffles between renders jitters.
const TEXT_WIDTHS: readonly Size[] = ['94%', '82%', '90%', '68%', '96%', '54%']
const ROW_TITLE_WIDTHS: readonly Size[] = ['46%', '62%', '38%', '70%', '54%', '42%']
const ROW_DETAIL_WIDTHS: readonly Size[] = ['72%', '58%', '80%', '50%', '66%', '76%']

/** Lines of body copy. */
export function SkeletonLines(props: {
  lines?: number | undefined
  widths?: readonly Size[] | undefined
  className?: string | undefined
}) {
  const widths = props.widths ?? TEXT_WIDTHS
  return (
    <span className={`skeleton-lines${cls(props.className)}`} aria-hidden>
      {Array.from({ length: props.lines ?? 3 }, (_, index) => (
        <Skeleton key={index} width={cycle(widths, index)} />
      ))}
    </span>
  )
}

/**
 * List rows: optional leading icon, a title, optional detail line and an
 * optional trailing control. Menus, pickers, trees and settings lists.
 */
export function SkeletonRows(props: {
  rows?: number | undefined
  icon?: boolean | 'circle' | undefined
  detail?: boolean | undefined
  control?: boolean | undefined
  density?: 'default' | 'tall' | 'roomy' | undefined
  widths?: readonly Size[] | undefined
  /** Per-row left inset in pixels, cycled; draws a tree's nesting. */
  indents?: readonly number[] | undefined
  className?: string | undefined
}) {
  const widths = props.widths ?? ROW_TITLE_WIDTHS
  const rowClass = `skeleton-row${props.density && props.density !== 'default' ? ` skeleton-row--${props.density}` : ''}`
  const circle = props.icon === 'circle'
  return (
    <div className={`skeleton-rows${cls(props.className)}`} aria-hidden>
      {Array.from({ length: props.rows ?? 4 }, (_, index) => {
        const indent = props.indents ? cycle(props.indents, index) : undefined
        return (
          <div
            className={rowClass}
            key={index}
            style={indent !== undefined ? { paddingLeft: indent } : undefined}
          >
            {props.icon ? (
              <Skeleton
                className={circle ? 'skeleton--circle' : 'skeleton--icon'}
                width={circle ? 16 : undefined}
                height={circle ? 16 : undefined}
              />
            ) : null}
            <span className="skeleton-row__copy">
              <Skeleton className="skeleton-row__title" width={cycle(widths, index)} />
              {props.detail ? (
                <Skeleton
                  className="skeleton-row__detail"
                  width={cycle(ROW_DETAIL_WIDTHS, index)}
                />
              ) : null}
            </span>
            {props.control ? <Skeleton className="skeleton-row__control" /> : null}
          </div>
        )
      })}
    </div>
  )
}

// Indent level and width per line; a zero width is a blank line. Shaped like
// real source: short declarations, nested blocks, a blank between them.
const CODE_LINES: readonly (readonly [indent: number, width: number])[] = [
  [0, 34],
  [0, 58],
  [1, 46],
  [1, 72],
  [2, 38],
  [2, 64],
  [1, 52],
  [0, 22],
  [0, 0],
  [0, 48],
  [1, 66],
  [2, 30],
  [2, 56],
  [1, 40],
  [0, 26],
  [0, 0],
  [0, 42],
  [1, 60],
]
const CODE_INDENT = 16

/** Source or diff lines with an optional line-number gutter. */
export function SkeletonCode(props: {
  lines?: number | undefined
  gutter?: boolean | undefined
  className?: string | undefined
}) {
  return (
    <div className={`skeleton-code${cls(props.className)}`} aria-hidden>
      {Array.from({ length: props.lines ?? 12 }, (_, index) => {
        const [indent, width] = cycle(CODE_LINES, index)
        return (
          <div className="skeleton-code__line" key={index}>
            {props.gutter ? (
              <span className="skeleton-code__gutter">
                <Skeleton />
              </span>
            ) : null}
            {width > 0 ? (
              <Skeleton
                width={`${width}%`}
                style={indent ? { marginLeft: 14 + indent * CODE_INDENT } : undefined}
              />
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

const THREAD_TURNS: readonly { said: Size; reply: readonly Size[] }[] = [
  { said: '34%', reply: ['96%', '88%', '92%', '58%'] },
  { said: '52%', reply: ['90%', '97%', '84%', '93%', '36%'] },
  { said: '28%', reply: ['94%', '78%', '62%'] },
]

/** A transcript: prompt bubbles on the right, reply paragraphs beneath. */
export function ThreadSkeleton(props: { className?: string | undefined }) {
  return (
    <SkeletonStatus
      label="Loading conversation…"
      className={`thread-skeleton${cls(props.className)}`}
    >
      <div className="thread-skeleton__col" aria-hidden>
        {THREAD_TURNS.map((turn, index) => (
          <div className="thread-skeleton__turn" key={index}>
            <Skeleton className="thread-skeleton__said" width={turn.said} />
            <div className="thread-skeleton__reply">
              {turn.reply.map((width, line) => (
                <Skeleton key={line} width={width} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </SkeletonStatus>
  )
}
