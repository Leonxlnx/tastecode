import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import {
  IconDownload,
  IconHourglass,
  IconLoader2,
  IconRefresh,
  IconSquare,
  IconX,
} from '@tabler/icons-react'
import {
  appUpdateInstallState,
  cancelAppUpdateInstall,
  chatCount,
  requestAppUpdateInstall,
  stopChatsAndInstall,
  subscribeAppUpdateInstall,
  waitingLabel,
} from '../app-update-install.js'
import {
  appUpdateState,
  checkForAppUpdates,
  onAppUpdateState,
  type AppUpdateState,
} from '../bridge.js'
import { Menu, MenuItem } from './Menu.js'

export function AppUpdateNotice() {
  const [state, setState] = useState<AppUpdateState>()
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)
  // A click that turns the button into the waiting one keeps the keyboard there.
  const [focusWaiting, setFocusWaiting] = useState(false)
  const install = useSyncExternalStore(
    subscribeAppUpdateInstall,
    appUpdateInstallState,
    appUpdateInstallState,
  )
  const visible = !!state && ['downloading', 'preparing', 'ready', 'error'].includes(state.status)
  useEffect(() => {
    if (visible) void import('../styles/app-update.css')
  }, [visible])
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
  if (!state || !visible) return null
  const downloading = state.status === 'downloading'
  // Verifying the installer and preparing it for the system updater follows the
  // last byte; on macOS it takes about 20 seconds.
  const preparing = state.status === 'preparing'
  const installFailed = install.phase === 'idle' && install.failed === true
  const retry = state.status === 'error' || failed || installFailed
  if (state.status === 'ready' && install.phase === 'waiting') {
    return <AppUpdateWaiting running={install.running} focusOnMount={focusWaiting} />
  }
  const stopping = install.phase === 'stopping'
  const busy =
    downloading ||
    preparing ||
    pending ||
    install.phase === 'checking' ||
    stopping ||
    install.phase === 'installing'
  const label = retry
    ? 'Retry TasteCode update'
    : downloading
      ? `Downloading TasteCode update${state.progress === undefined ? '' : ` (${state.progress}%)`}`
      : preparing
        ? 'Preparing TasteCode update'
        : stopping
          ? `Stopping ${chatCount(install.running)} to update TasteCode`
          : `Restart to update TasteCode${state.version ? ` to ${state.version}` : ''}`
  const act = async (focused: boolean) => {
    setPending(true)
    setFailed(false)
    setFocusWaiting(focused)
    try {
      if (retry) {
        cancelAppUpdateInstall()
        await checkForAppUpdates()
      } else await requestAppUpdateInstall()
    } catch {
      setFailed(true)
    } finally {
      setPending(false)
    }
  }
  return (
    <button
      type="button"
      className="account-update"
      data-state={retry ? 'error' : state.status}
      aria-label={label}
      aria-busy={busy}
      title={
        retry ? `${state.error ?? 'The update could not be completed.'} Click to retry.` : label
      }
      disabled={busy}
      onClick={(event) => void act(document.activeElement === event.currentTarget)}
    >
      {busy ? (
        <IconLoader2 size={16} className="spinner" aria-hidden />
      ) : retry ? (
        <IconRefresh size={16} aria-hidden />
      ) : (
        <IconDownload size={16} aria-hidden />
      )}
      {downloading && state.progress !== undefined ? <span>{state.progress}%</span> : null}
    </button>
  )
}

/**
 * The update waits for running chats. The button keeps its place and shows
 * how many; its menu installs now (after one confirmation, since that stops
 * them) or puts the install off.
 */
function AppUpdateWaiting(props: { running: number; focusOnMount: boolean }) {
  const [confirming, setConfirming] = useState(false)
  const icon = useRef<SVGSVGElement>(null)
  // Only the click that started the wait moves focus, once.
  const focusOnMount = useRef(props.focusOnMount)
  const label = waitingLabel(props.running)
  useLayoutEffect(() => {
    if (focusOnMount.current) icon.current?.closest('button')?.focus()
  }, [])
  return (
    <Menu
      drop="up"
      align="right"
      label={`${label}. Update options`}
      triggerTitle={label}
      triggerClassName="account-update"
      panelClassName="menu--compact app-update-menu"
      onOpen={() => setConfirming(false)}
      trigger={() => (
        <>
          <IconHourglass ref={icon} size={16} aria-hidden />
          <span>{props.running}</span>
        </>
      )}
    >
      {(close) =>
        confirming ? (
          <WaitingChoices key="confirm" heading="Install now">
            <MenuItem
              className="menu__item--danger"
              icon={<IconSquare size={14} aria-hidden />}
              title={`Stop ${chatCount(props.running)} and install`}
              onClick={() => {
                close()
                void stopChatsAndInstall()
              }}
            />
            <MenuItem
              icon={<IconHourglass size={14} aria-hidden />}
              title="Keep waiting"
              onClick={() => setConfirming(false)}
            />
          </WaitingChoices>
        ) : (
          <WaitingChoices key="choose" heading={label}>
            <MenuItem
              icon={<IconDownload size={14} aria-hidden />}
              title="Install now"
              detail={`Stops ${chatCount(props.running)} first`}
              onClick={() => setConfirming(true)}
            />
            <MenuItem
              icon={<IconX size={14} aria-hidden />}
              title="Install later"
              onClick={() => {
                close()
                cancelAppUpdateInstall()
              }}
            />
          </WaitingChoices>
        )
      }
    </Menu>
  )
}

/** One step of the menu. A step that replaces the clicked item takes the focus it lost. */
function WaitingChoices(props: { heading: string; children: ReactNode }) {
  const heading = useRef<HTMLParagraphElement>(null)
  useLayoutEffect(() => {
    const panel = heading.current?.parentElement
    if (!panel || panel.contains(document.activeElement)) return
    if (panel.getAttribute('data-popup-state') !== 'open') return
    panel.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
  }, [])
  return (
    <>
      <p ref={heading} className="menu__group">
        {props.heading}
      </p>
      {props.children}
    </>
  )
}
