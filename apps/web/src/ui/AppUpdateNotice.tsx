import { useEffect, useState } from 'react'
import {
  appUpdateState,
  onAppUpdateState,
  openExternalUrl,
  type AppUpdateState,
} from '../bridge.js'
import { NoticePresence } from './NoticePresence.js'

export function AppUpdateNotice(props: { onReview: () => void }) {
  const [state, setState] = useState<AppUpdateState>()
  const [dismissed, setDismissed] = useState<string>()
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
  // Manual packages (deb) signal through latestVersion: nothing installs
  // in-app, so the only actions are opening the releases page or dismissing.
  const manual = state?.status === 'manual' ? state.latestVersion : undefined
  return (
    <NoticePresence
      className="notice notice--app-update"
      role="status"
      visible={
        (state?.status === 'ready' && state.version !== dismissed) ||
        (manual !== undefined && manual !== dismissed)
      }
      onDismiss={() => setDismissed(state?.status === 'ready' ? state.version : manual)}
      autoDismissPaused
    >
      {manual !== undefined ? (
        <>
          <span className="notice__text">TasteCode {manual} is available to download.</span>
          <button
            className="ghost"
            type="button"
            onClick={() => {
              if (state?.releasesUrl) void openExternalUrl(state.releasesUrl)
            }}
          >
            Download
          </button>
          <button className="ghost" type="button" onClick={() => setDismissed(manual)}>
            Later
          </button>
        </>
      ) : (
        <>
          <span className="notice__text">TasteCode {state?.version} is ready to install.</span>
          <button className="ghost" type="button" onClick={props.onReview}>
            Review update
          </button>
          <button className="ghost" type="button" onClick={() => setDismissed(state?.version)}>
            Later
          </button>
        </>
      )}
    </NoticePresence>
  )
}
