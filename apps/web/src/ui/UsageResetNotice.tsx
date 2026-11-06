import { useState } from 'react'
import { IconClockPause, IconPlayerPlay } from '@tabler/icons-react'
import { NoticeBody } from './Notice.js'
import '../styles/usage-reset.css'

export type UsageResetNoticeProps = {
  resetsAt?: number | undefined
  source: string
  scheduled: boolean
  schedule: () => Promise<void>
  cancel: () => void
}

/** A shelf row in the one notice look (ui/Notice.tsx): resume this chat when usage resets. */
export function UsageResetNotice(props: UsageResetNoticeProps) {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  const date = props.resetsAt === undefined ? undefined : new Date(props.resetsAt)
  const reset = date?.toLocaleString(undefined, {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
  })
  return (
    <div
      className="composer__error-row composer__usage-reset"
      data-notice-tone="info"
      aria-label="Resume at usage reset"
    >
      <NoticeBody
        tone="info"
        icon={<IconClockPause className="notice-icon" size={16} stroke={1.7} aria-hidden />}
        actions={
          <button
            className={`notice-action composer__usage-reset-action${props.scheduled ? ' is-scheduled' : ''}`}
            type="button"
            disabled={saving || !date}
            onClick={() => {
              if (props.scheduled) {
                props.cancel()
                return
              }
              setSaving(true)
              setError(undefined)
              void props
                .schedule()
                .catch(() => setError('Could not schedule a resume. Try again.'))
                .finally(() => setSaving(false))
            }}
          >
            {!props.scheduled && <IconPlayerPlay size={13} aria-hidden />}
            {saving ? 'Snoozing…' : props.scheduled ? 'Cancel auto-resume' : 'Resume at reset'}
          </button>
        }
      >
        <span className="composer__usage-reset-copy" role={props.scheduled ? 'status' : undefined}>
          <strong>
            {props.scheduled ? 'Snoozed until usage resets' : 'Continue when usage resets'}
          </strong>
          <span>
            {date ? (
              <>
                {props.source} · {props.scheduled ? 'Resumes' : 'Resets'}{' '}
                <time dateTime={date.toISOString()} title={date.toLocaleString()}>
                  {reset}
                </time>
              </>
            ) : (
              'This provider has not shared a reset time yet.'
            )}
          </span>
          {date && <span>Keep TasteCode open, or reopen it after the reset.</span>}
          {error && <span role="alert">{error}</span>}
        </span>
      </NoticeBody>
    </div>
  )
}
