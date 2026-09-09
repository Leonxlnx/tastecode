export type ProjectChoice = {
  path: string
  name?: string
}

/** Keep folder-only consumers asleep when only chat metadata changed. */
export function createProjectChoiceProjector(): (
  projects: ReadonlyArray<ProjectChoice>,
) => ReadonlyArray<ProjectChoice> {
  let previous: ProjectChoice[] = []

  return (projects) => {
    if (
      previous.length === projects.length &&
      previous.every(
        (project, index) =>
          project.path === projects[index]?.path && project.name === projects[index]?.name,
      )
    ) {
      return previous
    }

    previous = projects.map((project) => ({
      path: project.path,
      ...(project.name === undefined ? {} : { name: project.name }),
    }))
    return previous
  }
}
