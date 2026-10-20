import type { Model } from '@harness/contracts'
import type { NewSessionResult, SessionConfigOption } from './protocol.js'

/**
 * The select an agent offers to pick a session's model. Agents mark it with
 * the `model` category; the option id is theirs (`model` for Devin and
 * Mistral Vibe), so it is read rather than assumed.
 */
export function modelConfigOption(
  session: Pick<NewSessionResult, 'configOptions'>,
): SessionConfigOption | undefined {
  return session.configOptions?.find(
    (option) => option.category === 'model' && (option.type ?? 'select') === 'select' && option.id,
  )
}

/**
 * The models a new session offers, as the agent names them. The config
 * option is preferred because `session/set_config_option` is how a chat
 * applies the choice; the older `models` list answers for agents without one.
 */
export function sessionModels(session: NewSessionResult): Model[] {
  const select = modelConfigOption(session)
  if (select) {
    const values = (select.options ?? []).flatMap((entry) =>
      entry.options ? entry.options : [entry],
    )
    const seen = new Set<string>()
    return values.flatMap((value) => {
      if (!value.value || seen.has(value.value)) return []
      seen.add(value.value)
      return [
        model(value.value, value.name, value.description, value.value === select.currentValue),
      ]
    })
  }
  const listed = session.models
  return (listed?.availableModels ?? []).flatMap((entry) =>
    entry.modelId
      ? [
          model(
            entry.modelId,
            entry.name,
            entry.description,
            entry.modelId === listed?.currentModelId,
          ),
        ]
      : [],
  )
}

function model(
  id: string,
  name: string | undefined,
  description: string | null | undefined,
  isDefault: boolean,
): Model {
  return {
    id,
    displayName: name?.trim() || id,
    ...(description?.trim() ? { description: description.trim() } : {}),
    isDefault,
    reasoningEfforts: [],
    serviceTiers: [],
  }
}
