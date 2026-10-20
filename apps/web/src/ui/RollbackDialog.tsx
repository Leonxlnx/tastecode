import { IconX as X } from '@tabler/icons-react'
import {
  type CSSProperties,
  Fragment,
  type KeyboardEvent,
  type ReactNode,
  useId,
  useLayoutEffect,
  useRef,
} from 'react'
import { useDialogFocus } from './dialog-focus.js'
import '../styles/rollback.css'

export type Checkpoint = {
  id: number
  seq: number
  label: string
  createdAt: number
}

type Cut =
  | { state: 'unpicked'; firstGone: number }
  | { state: 'loading'; firstGone: number }
  | { state: 'picked'; firstGone: number; files: string[] }

function placeCut(
  checkpoints: Checkpoint[],
  inspection: { checkpoint: Checkpoint; files: string[] } | undefined,
  loadingId: number | undefined,
): Cut {
  const loading = checkpoints.findIndex((checkpoint) => checkpoint.id === loadingId)
  if (loading >= 0) return { state: 'loading', firstGone: loading }
  const picked = checkpoints.findIndex((checkpoint) => checkpoint.id === inspection?.checkpoint.id)
  if (inspection && picked >= 0)
    return { state: 'picked', firstGone: picked, files: inspection.files }
  return { state: 'unpicked', firstGone: checkpoints.length }
}

function filesBack(files: string[]): ReactNode {
  if (files.length === 0) return 'Files stay as they are'
  const shown = files.length > 3 ? files.slice(0, 2) : files
  const names: ReactNode[] = shown.map((file) => <b key={file}>{file}</b>)
  if (shown.length < files.length) names.push(`${files.length - shown.length} more files`)
  return (
    <>
      {names.map((name, index) => (
        <Fragment key={index}>
          {index === 0 ? null : index === names.length - 1 ? ' and ' : ', '}
          {name}
        </Fragment>
      ))}{' '}
      go back too
    </>
  )
}

export function RollbackDialog(props: {
  checkpoints: Checkpoint[]
  inspection: { checkpoint: Checkpoint; files: string[] } | undefined
  loadingId: number | undefined
  restoring: boolean
  onInspect: (checkpoint: Checkpoint) => void
  onRestore: () => void
  onClose: () => void
}) {
  const cut = placeCut(props.checkpoints, props.inspection, props.loadingId)
  const dialog = useDialogFocus<HTMLDivElement>(props.onClose)
  const titleId = useId()
  const sheet = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const prompts = useRef<(HTMLButtonElement | null)[]>([])
  const opened = useRef(false)

  const moveNotchesWithScroll = () =>
    sheet.current?.style.setProperty('--rollback-scroll', `${list.current?.scrollTop ?? 0}px`)

  useLayoutEffect(() => {
    const scroller = list.current
    if (!scroller) return
    const prompt = prompts.current[cut.firstGone]
    if (!prompt) scroller.scrollTop = scroller.scrollHeight
    else if (opened.current) prompt.scrollIntoView({ block: 'nearest' })
    else scroller.scrollTop = prompt.offsetTop - (scroller.clientHeight - prompt.offsetHeight) / 2
    opened.current = true
    moveNotchesWithScroll()
  }, [cut.firstGone])

  const pick = (index: number, focus = false) => {
    const checkpoint = props.checkpoints[index]
    if (!checkpoint || index === cut.firstGone || props.restoring) return
    props.onInspect(checkpoint)
    if (focus) prompts.current[index]?.focus()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0
    if (step && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      event.preventDefault()
      pick(cut.firstGone + step, prompts.current.includes(event.target as HTMLButtonElement))
    }
    dialog.onKeyDown(event)
  }

  return (
    <div
      className="sheet"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onKeyDown={onKeyDown}
    >
      <button className="sheet__scrim" onClick={props.onClose} aria-label="Close checkpoints" />
      <div className="sheet__panel rollback" ref={dialog.panel} tabIndex={-1}>
        <div
          className="rollback__sheet"
          ref={sheet}
          style={{ '--rollback-cut': cut.firstGone } as CSSProperties}
        >
          <header className="sheet__head">
            <h2 className="sheet__title" id={titleId}>
              Restore
            </h2>
            <button className="icon-btn icon-btn--always" onClick={props.onClose} title="Close">
              <X size={13} aria-hidden />
            </button>
          </header>

          <div className="rollback__list" ref={list} onScroll={moveNotchesWithScroll}>
            <ol className="rollback__chat">
              {props.checkpoints.map((checkpoint, index) => (
                <li
                  className={`rollback__row${index >= cut.firstGone ? ' is-gone' : ''}`}
                  key={checkpoint.id}
                >
                  <button
                    ref={(element) => {
                      prompts.current[index] = element
                    }}
                    className="rollback__prompt"
                    aria-label={`Before “${checkpoint.label}”`}
                    aria-pressed={index === cut.firstGone}
                    title={new Date(checkpoint.createdAt).toLocaleString()}
                    tabIndex={
                      index === Math.min(cut.firstGone, props.checkpoints.length - 1) ? 0 : -1
                    }
                    disabled={props.restoring}
                    onClick={() => pick(index)}
                  >
                    {checkpoint.label}
                  </button>
                </li>
              ))}
            </ol>
            <div
              className={`rollback__cut is-${cut.state}`}
              role="status"
              aria-busy={cut.state === 'loading'}
            >
              {cut.state === 'loading' ? (
                <span className="visually-hidden">Loading files</span>
              ) : (
                <span
                  className="rollback__files"
                  title={cut.state === 'picked' ? cut.files.join('\n') || undefined : undefined}
                >
                  {cut.state === 'picked' ? filesBack(cut.files) : 'Pick a prompt to go back to'}
                </span>
              )}
              <span className="rollback__dots" aria-hidden />
            </div>
          </div>

          <footer className="rollback__foot">
            <button className="ghost" onClick={props.onClose} disabled={props.restoring}>
              Cancel
            </button>
            <button
              className="btn"
              onClick={props.onRestore}
              disabled={cut.state !== 'picked' || props.restoring}
            >
              {props.restoring ? 'Restoring…' : 'Restore'}
            </button>
          </footer>
        </div>
      </div>
    </div>
  )
}
