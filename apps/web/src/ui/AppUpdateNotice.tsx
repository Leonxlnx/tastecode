import { useEffect, useState } from 'react'
import { IconDownload, IconLoader2, IconRefresh } from '@tabler/icons-react'
import {
  appUpdateState,
  checkForAppUpdates,
  installAppUpdate,
  onAppUpdateState,
  openExternalUrl,
  RELEASES_URL,
  type AppUpdateState,
} from '../bridge.js'

export function AppUpdateNotice() {
  const [state, setState] = useState<AppUpdateState>()
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)
  // Manual packages (deb) signal through latestVersion: nothing installs
  // in-app, so the button links to the releases page instead.
  const manual = state?.status === 'manual' ? state.latestVersion : undefined
  const visible =
    !!state &&
    (['downloading', 'ready', 'error'].includes(state.status) || manual !== undefined)
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
  const retry = state.status === 'error' || failed
  const label =
    manual !== undefined
      ? `Download TasteCode ${manual}`
      : retry
        ? 'Retry TasteCode update'
        : downloading
          ? `Downloading TasteCode update${state.progress === undefined ? '' : ` (${state.progress}%)`}`
          : `Restart to update TasteCode${state.version ? ` to ${state.version}` : ''}`
  const act = async () => {
    if (manual !== undefined) {
      void openExternalUrl(state.releasesUrl ?? RELEASES_URL)
      return
    }
    setPending(true)
    setFailed(false)
    try {
      if (retry) await checkForAppUpdates()
      else if (!(await installAppUpdate())) setFailed(true)
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
      aria-busy={downloading || pending}
      title={
        retry ? `${state.error ?? 'The update could not be completed.'} Click to retry.` : label
      }
      disabled={downloading || pending}
      onClick={() => void act()}
    >
      {downloading || pending ? (
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
