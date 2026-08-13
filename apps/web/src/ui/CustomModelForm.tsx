import { useState, type FormEvent } from 'react'
import { Plus, X } from 'lucide-react'
import type { ProviderId } from '@harness/contracts'
import type { CustomModelInput } from '../model-catalog.js'
import { AppSelect } from './AppSelect.js'

/**
 * One-line entry point for a model id the provider accepts but does not list.
 * Shared by the model picker (compact footer) and Settings -> Models.
 */
export function CustomModelForm(props: {
  providers: { id: ProviderId; name: string }[]
  defaultProvider?: ProviderId | undefined
  /** Hide the provider select and pin the entry to this engine. Used by the
   *  per-provider add rows in Settings, where the provider is already known. */
  fixedProvider?: ProviderId | undefined
  onAdd: (input: CustomModelInput) => void
  onCancel?: (() => void) | undefined
}) {
  const [provider, setProvider] = useState<ProviderId>(
    props.fixedProvider ?? props.defaultProvider ?? props.providers[0]?.id ?? 'codex',
  )
  const [modelId, setModelId] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [error, setError] = useState<string>()
  const submit = (event: FormEvent) => {
    event.preventDefault()
    const id = modelId.trim()
    if (!id) {
      setError('Enter a model id, e.g. qwen-max.')
      return
    }
    props.onAdd({ provider, modelId: id, displayName: displayName.trim() })
    setModelId('')
    setDisplayName('')
    setError(undefined)
  }

  return (
    <form className="custom-model-form" onSubmit={submit}>
      {props.fixedProvider ? null : (
        <div className="custom-model-form__field">
          <span className="custom-model-form__label">Provider</span>
          <AppSelect
            ariaLabel="Provider"
            value={provider}
            onChange={setProvider}
            options={props.providers.map((entry) => ({
              value: entry.id,
              label: entry.name,
            }))}
          />
        </div>
      )}
      <label
        className={`custom-model-form__field${props.fixedProvider ? ' custom-model-form__field--wide' : ''}`}
      >
        <span className="custom-model-form__label">Model id</span>
        <input
          value={modelId}
          placeholder="qwen-max"
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => {
            setModelId(event.target.value)
            if (error) setError(undefined)
          }}
        />
      </label>
      <label className="custom-model-form__field custom-model-form__field--wide">
        <span className="custom-model-form__label">Display name</span>
        <input
          value={displayName}
          placeholder={modelId || 'Qwen Max'}
          onChange={(event) => setDisplayName(event.target.value)}
        />
      </label>
      {error ? (
        <p className="custom-model-form__error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="custom-model-form__actions">
        <button type="submit" className="custom-model-form__submit">
          <Plus size={14} aria-hidden />
          <span>Add model</span>
        </button>
        {props.onCancel ? (
          <button type="button" className="custom-model-form__cancel" onClick={props.onCancel}>
            <X size={14} aria-hidden />
            <span>Cancel</span>
          </button>
        ) : null}
      </div>
    </form>
  )
}
