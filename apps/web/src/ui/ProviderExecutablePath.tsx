import { useEffect, useState } from 'react'
import type { Transport } from '../transport.js'
import '../styles/provider-executable-path.css'

/** A blank value returns the provider to the desktop's ordinary PATH search. */
export function ProviderExecutablePath(props: {
  source: string
  name: string
  transport: Transport
  onChanged: () => void
}) {
  const [saved, setSaved] = useState<string>()
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let current = true
    setSaved(undefined)
    setError(undefined)
    void props.transport.request('providers.executablePaths', {}).then(
      (paths) => {
        if (!current) return
        const value = paths[props.source] ?? ''
        setSaved(value)
        setDraft(value)
      },
      (cause: unknown) => {
        if (current) setError(cause instanceof Error ? cause.message : String(cause))
      },
    )
    return () => {
      current = false
    }
  }, [props.source, props.transport])

  const save = async () => {
    setBusy(true)
    setError(undefined)
    try {
      const paths = await props.transport.request('providers.updateExecutablePath', {
        source: props.source,
        path: draft,
      })
      const value = paths[props.source] ?? ''
      setSaved(value)
      setDraft(value)
      props.onChanged()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <details className="provider-executable">
      <summary>Executable path{saved ? ' · Custom' : ''}</summary>
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
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Automatic discovery"
          disabled={saved === undefined || busy}
          spellCheck={false}
        />
        <button
          className="set-button"
          type="submit"
          disabled={saved === undefined || busy || draft === saved}
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
      </form>
      {error ? (
        <p className="provider-executable__error" role="alert">
          {error}
        </p>
      ) : null}
    </details>
  )
}
