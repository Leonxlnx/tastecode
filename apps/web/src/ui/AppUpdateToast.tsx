import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { IconHourglass, IconLoader2, IconSparkles, IconX } from '@tabler/icons-react'
import {
  appUpdateInstallState,
  cancelAppUpdateInstall,
  chatCount,
  installWhenChatsFinish,
  requestAppUpdateInstall,
  runningLabel,
  stopChatsAndInstall,
  subscribeAppUpdateInstall,
} from '../app-update-install.js'
import { appUpdateState, onAppUpdateState, type AppUpdateState } from '../bridge.js'
import { NoticePresence } from './NoticePresence.js'

const DISMISSED_KEY = 'harness.appUpdate.dismissedVersion'
let stylesLoaded = false

function readDismissed(): string | undefined {
  try {
    return localStorage.getItem(DISMISSED_KEY) ?? undefined
  } catch {
    return undefined
  }
}

function useAppUpdateState(): AppUpdateState | undefined {
  const [state, setState] = useState<AppUpdateState>()
  useEffect(() => {
    let initial = true
    const off = onAppUpdateState((next) => {
      initial = false
      setState(next)
    })
    void appUpdateState()
      .then((next) => {
        if (initial) setState(next)
      })
      .catch(() => {})
    return () => {
      initial = false
      off()
    }
  }, [])
  return state
}

/**
 * The good news, once per version: an update has downloaded, with Update right
 * there. The sidebar's update button stays either way, so closing this loses
 * nothing. Nothing installs by itself from here.
 *
 * Update while chats run asks here, whichever button was clicked (Settings
 * asks in its own row): stop them and restart now, or install by itself once
 * they finish. Closing the question stops nothing.
 */
export function AppUpdateToast(props: {
  /** Settings is open and asks in its own row. */
  hidden?: boolean
  /** Another notice holds this spot; the good news can wait, a question cannot. */
  quiet?: boolean
}) {
  const state = useAppUpdateState()
  const install = useSyncExternalStore(
    subscribeAppUpdateInstall,
    appUpdateInstallState,
    appUpdateInstallState,
  )
  const [dismissed, setDismissed] = useState(readDismissed)
  // Set by Update here, or by the question; keeps progress in view until the
  // restart, and ends when the install goes back to idle or waits.
  const [engaged, setEngaged] = useState(false)
  const ready = state?.status === 'ready'
  const version = state?.version
  const asking = install.phase === 'confirming'
  const settled = install.phase === 'idle' || install.phase === 'waiting'
  // The question takes the keyboard from the button that asked it, onto the
  // choice that stops nothing, and gives it back when it closes.
  const focusWait = useRef(false)
  const returnFocus = useRef<HTMLElement | null>(null)
  const wait = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    if (asking) setEngaged(true)
    else if (settled) {
      setEngaged(false)
      focusWait.current = false
    }
  }, [asking, settled])

  const news =
    !props.quiet && install.phase === 'idle' && !install.failed && dismissed !== (version ?? '')
  const wanted = ready && !props.hidden && (asking || engaged || news)
  // Updates are rare, so the styles stay out of the startup sheet, and the
  // notice waits for them rather than flash unstyled.
  const [styled, setStyled] = useState(stylesLoaded)
  useEffect(() => {
    if (!wanted || styled) return
    let live = true
    const done = () => {
      stylesLoaded = true
      if (live) setStyled(true)
    }
    import('./app-update-toast.css').then(done, done)
    return () => {
      live = false
    }
  }, [wanted, styled])

  // The notice may mount after the question opens (styles, or it was closed).
  const waitButton = (element: HTMLButtonElement | null) => {
    wait.current = element
    if (!element || !focusWait.current) return
    focusWait.current = false
    element.focus()
  }
  useLayoutEffect(() => {
    if (!asking) {
      focusWait.current = false
      return
    }
    // The sidebar's button stays in place while the question is open.
    const active = document.activeElement
    if (!(active instanceof HTMLElement) || !active.closest('.account-update')) return
    returnFocus.current = active
    if (wait.current) wait.current.focus()
    else focusWait.current = true
  }, [asking])

  const dismiss = () => {
    const seen = version ?? ''
    setDismissed(seen)
    try {
      localStorage.setItem(DISMISSED_KEY, seen)
    } catch {
      /* Keep the dismissal for this window when storage is unavailable. */
    }
  }
  const closeQuestion = () => {
    cancelAppUpdateInstall()
    dismiss()
    const back = returnFocus.current
    returnFocus.current = null
    if (back?.isConnected) back.focus()
  }

  const running = 'running' in install ? install.running : 0
  return (
    <NoticePresence className="notice notice--app-update" role="status" visible={styled && wanted}>
      {asking ? (
        <>
          <IconHourglass size={16} stroke={1.7} aria-hidden />
          <span className="notice__text">{runningLabel(running)}</span>
          <button
            className="app-update-toast__action app-update-toast__action--danger"
            type="button"
            onClick={() => void stopChatsAndInstall()}
          >
            Stop and update
          </button>
          <button
            ref={waitButton}
            className="app-update-toast__action"
            type="button"
            onClick={installWhenChatsFinish}
          >
            When they finish
          </button>
          <button
            className="app-update-toast__close"
            type="button"
            aria-label="Cancel update"
            onClick={closeQuestion}
          >
            <IconX size={15} stroke={1.7} aria-hidden />
          </button>
        </>
      ) : install.phase === 'checking' ||
        install.phase === 'stopping' ||
        install.phase === 'installing' ? (
        <>
          <IconLoader2 size={16} stroke={1.7} className="spinner" aria-hidden />
          <span className="notice__text">
            {install.phase === 'stopping'
              ? `Stopping ${chatCount(install.running)}…`
              : 'Restarting TasteCode…'}
          </span>
        </>
      ) : (
        <>
          <IconSparkles size={16} stroke={1.7} aria-hidden />
          <span className="notice__text">
            {version ? `TasteCode ${version} is ready` : 'A TasteCode update is ready'}
          </span>
          <button
            className="app-update-toast__update"
            type="button"
            onClick={(event) => {
              // This button gives way to the question, if there is one.
              focusWait.current = document.activeElement === event.currentTarget
              returnFocus.current = null
              setEngaged(true)
              void requestAppUpdateInstall()
            }}
          >
            Update
          </button>
          <button
            className="app-update-toast__close"
            type="button"
            aria-label="Dismiss update notice"
            onClick={dismiss}
          >
            <IconX size={15} stroke={1.7} aria-hidden />
          </button>
        </>
      )}
    </NoticePresence>
  )
}
