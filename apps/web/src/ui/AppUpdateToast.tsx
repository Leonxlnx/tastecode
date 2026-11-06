import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { IconHourglass, IconSparkles } from '@tabler/icons-react'
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
import { NoticeBody } from './Notice.js'
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
  const progress =
    install.phase === 'checking' || install.phase === 'stopping' || install.phase === 'installing'
  return (
    <NoticePresence
      className="notice notice--app-update"
      tone={!asking && progress ? 'progress' : 'info'}
      role="status"
      visible={styled && wanted}
      followComposer={false}
    >
      {asking ? (
        <NoticeBody
          tone="info"
          icon={<IconHourglass className="notice-icon" size={16} stroke={1.7} aria-hidden />}
          actions={
            <>
              <button
                className="notice-action notice-action--danger"
                type="button"
                onClick={() => void stopChatsAndInstall()}
              >
                Stop and update
              </button>
              <button
                ref={waitButton}
                className="notice-action"
                type="button"
                onClick={installWhenChatsFinish}
              >
                When they finish
              </button>
            </>
          }
          onDismiss={closeQuestion}
          dismissLabel="Cancel update"
        >
          {runningLabel(running)}
        </NoticeBody>
      ) : progress ? (
        <NoticeBody tone="progress">
          {install.phase === 'stopping'
            ? `Stopping ${chatCount(running)}…`
            : 'Restarting TasteCode…'}
        </NoticeBody>
      ) : (
        <NoticeBody
          tone="info"
          icon={<IconSparkles className="notice-icon" size={16} stroke={1.7} aria-hidden />}
          actions={
            <button
              className="notice-action notice-action--primary"
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
          }
          onDismiss={dismiss}
          dismissLabel="Dismiss update notice"
        >
          {version ? `TasteCode ${version} is ready` : 'A TasteCode update is ready'}
        </NoticeBody>
      )}
    </NoticePresence>
  )
}
