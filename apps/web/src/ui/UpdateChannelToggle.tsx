import { setAppUpdateChannel, type AppUpdateChannel } from '../bridge.js'

/** The beta opt-in. It follows the desktop updater's state, so the switch moves
 *  once the desktop process has saved the choice. */
export function UpdateChannelToggle(props: { channel: AppUpdateChannel }) {
  const beta = props.channel === 'beta'
  return (
    <button
      className={`switch${beta ? ' is-on' : ''}`}
      type="button"
      role="switch"
      aria-label="Beta updates"
      aria-checked={beta}
      onClick={() => void setAppUpdateChannel(beta ? 'stable' : 'beta').catch(() => {})}
    >
      <span className="switch__thumb" />
    </button>
  )
}
