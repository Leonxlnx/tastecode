export type ProjectChoice = {
  path: string
  name?: string
}

/**
 * Keep folder-only consumers asleep when only chat metadata changed. A folder
 * made for a chat without a project is not a project to choose, so it is left out.
 */
export function createProjectChoiceProjector(): (
  projects: ReadonlyArray<ProjectChoice & { chat?: boolean }>,
) => ReadonlyArray<ProjectChoice> {
  let previous: ProjectChoice[] = []

  return (projects) => {
    let index = 0
    let same = true
    for (const project of projects) {
      if (project.chat) continue
      const prior = previous[index]
      if (prior?.path !== project.path || prior.name !== project.name) {
        same = false
        break
      }
      index += 1
    }
    if (same && index === previous.length) return previous

    previous = []
    for (const project of projects) {
      if (project.chat) continue
      previous.push({
        path: project.path,
        ...(project.name === undefined ? {} : { name: project.name }),
      })
    }
    return previous
  }
}
