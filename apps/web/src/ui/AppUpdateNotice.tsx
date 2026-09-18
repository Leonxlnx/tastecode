import { useEffect, useState } from 'react'
import { appUpdateState, onAppUpdateState, type AppUpdateState } from '../bridge.js'
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
  return (
    <NoticePresence
      className="notice notice--app-update"
      role="status"
      visible={state?.status === 'ready' && state.version !== dismissed}
      onDismiss={() => setDismissed(state?.version)}
      autoDismissPaused
    >
      <span className="notice__text">TasteCode {state?.version} is ready to install.</span>
      <button className="ghost" type="button" onClick={props.onReview}>
        Review update
      </button>
      <button className="ghost" type="button" onClick={() => setDismissed(state?.version)}>
        Later
      </button>
    </NoticePresence>
  )
}
