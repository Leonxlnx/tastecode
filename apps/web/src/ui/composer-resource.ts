export type ComposerResourceKind = 'skill' | 'mcp'

export type ComposerResource = {
  key: string
  kind: ComposerResourceKind
  id: string
  name: string
  description: string
  scope: string
  token: string
  available: boolean
  unavailableReason?: string | undefined
}

export type ComposerResourceTrigger = {
  marker: '/' | '$' | '@'
  query: string
  start: number
  end: number
}

export type ComposerResourcePickerHandle = {
  move: (direction: 1 | -1) => boolean
  selectActive: () => boolean
}

export const COMPOSER_RESOURCE_LIST_ID = 'composer-resource-list'
