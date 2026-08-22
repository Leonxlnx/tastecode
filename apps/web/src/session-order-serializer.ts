export type SessionOrderProject = {
  path: string
  sessions: ReadonlyArray<{ id: string }>
}

type CachedProjectOrder = {
  sessions: SessionOrderProject['sessions']
  ids: string[]
  seen: number
}

/**
 * Returns JSON only when chat membership or ordering changed.
 *
 * Project state uses structural copies, so an ordinary status change replaces
 * one session array. Rechecking only that array avoids rebuilding and
 * serializing every chat id in a large workspace for an order that is stable.
 */
export function createSessionOrderSerializer(): (
  projects: ReadonlyArray<SessionOrderProject>,
) => string | undefined {
  const cache = new Map<string, CachedProjectOrder>()
  let generation = 0
  let initialized = false

  return (projects) => {
    generation += 1
    let changed = !initialized

    for (const project of projects) {
      const current = cache.get(project.path)
      if (current?.sessions === project.sessions) {
        current.seen = generation
        continue
      }
      if (current && sameSessionIds(current.ids, project.sessions)) {
        current.sessions = project.sessions
        current.seen = generation
        continue
      }
      cache.set(project.path, {
        sessions: project.sessions,
        ids: project.sessions.map((session) => session.id),
        seen: generation,
      })
      changed = true
    }

    for (const [path, project] of cache) {
      if (project.seen === generation) continue
      cache.delete(path)
      changed = true
    }

    if (!changed) return undefined
    initialized = true
    return JSON.stringify(
      Object.fromEntries(projects.map((project) => [project.path, cache.get(project.path)!.ids])),
    )
  }
}

function sameSessionIds(ids: string[], sessions: SessionOrderProject['sessions']): boolean {
  if (ids.length !== sessions.length) return false
  for (let index = 0; index < ids.length; index += 1) {
    if (ids[index] !== sessions[index]?.id) return false
  }
  return true
}
