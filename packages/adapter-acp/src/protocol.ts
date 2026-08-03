/**
 * The Agent Client Protocol, as agents actually speak it.
 *
 * Typed from frames captured off `gemini --experimental-acp` rather than from
 * the published schema alone, because the two disagree in small ways that
 * matter — most notably the update discriminator is `sessionUpdate`, not
 * `type`, and `tool_call` fields sit flat on the update rather than nested.
 *
 * Every field is optional. This is one shape for many independent
 * implementations, so treating anything as guaranteed is how a session dies on
 * an agent that is merely different rather than broken.
 */

export const PROTOCOL_VERSION = 1

export type ContentBlock = {
  type?: string
  text?: string
}

export type InitializeResult = {
  protocolVersion?: number
  agentInfo?: { name?: string; version?: string }
  agentCapabilities?: {
    loadSession?: boolean
    promptCapabilities?: {
      image?: boolean
      audio?: boolean
      embeddedContext?: boolean
    }
  }
  authMethods?: Array<{ id?: string; name?: string; description?: string | null }>
}

export type NewSessionResult = {
  sessionId?: string
  modes?: { currentModeId?: string; availableModes?: Array<{ id?: string; name?: string }> }
}

/** Why a turn ended. `cancelled` is a normal outcome, not an error. */
export type StopReason = 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled'

export type PromptResult = {
  stopReason?: StopReason
}

export type ToolKind =
  'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'think' | 'fetch' | 'other'

export type ToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed'

/**
 * `type` is required here, unlike most of this file, because it is the
 * discriminant — an optional one cannot narrow the union, and every captured
 * frame carried it.
 */
export type ToolCallContent =
  | { type: 'content'; content?: ContentBlock }
  | { type: 'diff'; path?: string; oldText?: string | null; newText?: string }
  | { type: 'terminal'; terminalId?: string }

export type ToolCallFields = {
  toolCallId?: string
  title?: string
  kind?: ToolKind
  status?: ToolCallStatus
  content?: ToolCallContent[]
  locations?: Array<{ path?: string; line?: number }>
  rawInput?: Record<string, unknown>
}

/**
 * One `session/update` payload.
 *
 * Discriminated by `sessionUpdate`. The tool-call variants spread their fields
 * onto this object directly, which is why they are intersected rather than
 * nested.
 */
export type SessionUpdate = Omit<ToolCallFields, 'content'> & {
  sessionUpdate?: string
  /**
   * Overloaded by the protocol: a single block on a text chunk, an array on a
   * tool call. Intersecting the two would cancel out to `never`, so the
   * tool-call field is omitted above and the union declared once here.
   */
  content?: ContentBlock | ToolCallContent[]
  entries?: Array<{ content?: string; status?: string; priority?: string }>
  availableCommands?: Array<{ name?: string; description?: string }>
  currentModeId?: string
}

export type SessionNotification = {
  sessionId?: string
  update?: SessionUpdate
}

/** An agent asking to do something. It blocks until we answer. */
export type PermissionOptionKind = 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always'

export type RequestPermissionParams = {
  sessionId?: string
  toolCall?: ToolCallFields
  options?: Array<{ optionId?: string; name?: string; kind?: PermissionOptionKind }>
}
