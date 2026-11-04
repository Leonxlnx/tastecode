import { createContext } from 'react'
import type { ProviderId } from '@harness/contracts'

/** A model's display name from the catalog, when the app knows the model. */
export type ModelName = (provider: ProviderId, model: string) => string | undefined

/** Names models where the app shows them deep in a view, such as a chat moving to one. */
export const ModelNameContext = createContext<ModelName | undefined>(undefined)
