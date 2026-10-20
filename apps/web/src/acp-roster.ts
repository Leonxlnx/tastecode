/**
 * The ACP agents the user added under Settings › Providers, in the order they
 * were added. The library offers every agent the server knows; only these get
 * a row, an account check and a place in the model picker.
 */
const ACP_ROSTER_KEY = 'harness.acpRoster.v1'

/** Undefined until the roster is first saved, so it can start from the agents already in use. */
export function readAcpRoster(): readonly string[] | undefined {
  try {
    const raw = localStorage.getItem(ACP_ROSTER_KEY)
    if (raw === null) return undefined
    const stored: unknown = JSON.parse(raw)
    if (!Array.isArray(stored)) return []
    return [...new Set(stored.filter((id): id is string => typeof id === 'string'))]
  } catch {
    return []
  }
}

/** The agents with a chat in any project, which a roster saved for the first time keeps. */
export function acpAgentsInUse(
  projects: readonly { sessions: readonly { provider: string; agent?: string | undefined }[] }[],
): string[] {
  const agents = projects.flatMap((project) =>
    project.sessions.flatMap((session) =>
      session.provider === 'acp' && session.agent ? [session.agent] : [],
    ),
  )
  return [...new Set(agents)]
}

export function writeAcpRoster(roster: readonly string[]): void {
  try {
    localStorage.setItem(ACP_ROSTER_KEY, JSON.stringify(roster))
  } catch {
    // The roster still changes for this run when storage is full or blocked.
  }
}
