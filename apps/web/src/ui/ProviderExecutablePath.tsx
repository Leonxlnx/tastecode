import { useEffect, useState } from 'react'
import type { Transport } from '../transport.js'
import { EXECUTABLE_PATH_LABEL, executablePathSearchId } from './settings/provider-tuning-search.js'
import '../styles/provider-executable-path.css'

type ExecutablePaths = Readonly<Record<string, string>>

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/** One read for the whole page. A failure only matters once someone opens a field. */
export function useProviderExecutablePaths(transport: Transport) {
  const [paths, setPaths] = useState<ExecutablePaths>()
  const [readError, setReadError] = useState<string>()
  useEffect(() => {
    let current = true
    setPaths(undefined)
    setReadError(undefined)
    void transport.request('providers.executablePaths', {}).then(
      (next) => {
        if (current) setPaths(next)
      },
      (cause: unknown) => {
        if (current) setReadError(errorText(cause))
      },
    )
    return () => {
      current = false
    }
  }, [transport])
  return { paths, readError, setPaths }
}

/** A blank value returns the provider to the desktop's ordinary PATH search. */
export function ProviderExecutablePath(props: {
  source: string
  name: string
  paths: ExecutablePaths | undefined
  readError: string | undefined
  transport: Transport
  onSaved: (paths: ExecutablePaths) => void
}) {
  const saved = props.paths && (props.paths[props.source] ?? '')
  const [open, setOpen] = useState(false)
  /** Undefined until edited, so the field follows what the server has. */
  const [draft, setDraft] = useState<string>()
  const [saveError, setSaveError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const value = draft ?? saved ?? ''
  const error = saveError ?? props.readError

  const save = async () => {
    setBusy(true)
    setSaveError(undefined)
    try {
      const paths = await props.transport.request('providers.updateExecutablePath', {
        source: props.source,
        path: value,
      })
      setDraft(undefined)
      props.onSaved(paths)
    } catch (cause) {
      setSaveError(errorText(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <details
      className="provider-executable"
      open={open}
      data-settings-id={executablePathSearchId(props.source)}
    >
      <summary
        onClick={(event) => {
          event.preventDefault()
          setOpen((current) => !current)
        }}
      >
        {EXECUTABLE_PATH_LABEL}
        {saved ? ' · Custom' : ''}
      </summary>
      {open ? (
        <>
          <p>Leave empty to find {props.name} automatically. Changes apply to new processes.</p>
          <form
            className="provider-executable__form"
            onSubmit={(event) => {
              event.preventDefault()
              void save()
            }}
          >
            <label className="visually-hidden" htmlFor={`executable-${props.source}`}>
              {props.name} executable path
            </label>
            <input
              className="set-input"
              id={`executable-${props.source}`}
              value={value}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Automatic discovery"
              disabled={saved === undefined || busy}
              spellCheck={false}
            />
            <button
              className="set-button"
              type="submit"
              disabled={saved === undefined || busy || value === saved}
            >
              {busy ? 'Saving…' : 'Save'}
            </button>
          </form>
          {error ? (
            <p className="provider-executable__error" role="alert">
              {error}
            </p>
          ) : null}
        </>
      ) : null}
    </details>
  )
}
