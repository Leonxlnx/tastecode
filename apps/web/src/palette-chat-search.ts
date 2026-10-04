import type { PaletteCommand, PaletteDeferredSearch } from './ui/CommandPalette.js'
import type { Project } from './ui/Sidebar.js'

type Session = Project['sessions'][number]
type SearchableText = {
  title: string
  projectDetail: string
  projectPath: string
  text: string
}
export type PaletteChatSearchCache = WeakMap<Session, SearchableText>

export function createPaletteChatSearchCache(): PaletteChatSearchCache {
  return new WeakMap()
}

/**
 * Search chat rows without first allocating one command object per saved chat.
 * The palette only materializes the bounded results it can display.
 */
export function createPaletteChatSearch(
  projects: readonly Project[] | (() => readonly Project[]),
  projectName: (project: Project) => string,
  selectSession: (threadId: string) => void,
  cache = createPaletteChatSearchCache(),
): PaletteDeferredSearch {
  return (terms, limit) => {
    if (limit <= 0) return []
    const matches: PaletteCommand[] = []
    const currentProjects = typeof projects === 'function' ? projects() : projects
    for (const project of currentProjects) {
      const detail = projectName(project)
      for (const session of project.sessions) {
        if (terms.length > 0) {
          const text = searchableText(cache, session, detail, project.path)
          if (!terms.every((term) => text.includes(term))) continue
        }
        matches.push({
          id: `chat-${session.id}`,
          title: session.title,
          detail,
          group: 'Chats',
          keywords: `${project.path} open session conversation`,
          run: () => selectSession(session.id),
        })
        if (matches.length >= limit) return matches
      }
    }
    return matches
  }
}

function searchableText(
  cache: PaletteChatSearchCache,
  session: Session,
  projectDetail: string,
  projectPath: string,
): string {
  const cached = cache.get(session)
  if (
    cached?.title === session.title &&
    cached.projectDetail === projectDetail &&
    cached.projectPath === projectPath
  ) {
    return cached.text
  }

  const text =
    `${session.title} ${projectDetail} Chats ${projectPath} open session conversation`.toLowerCase()
  cache.set(session, {
    title: session.title,
    projectDetail,
    projectPath,
    text,
  })
  return text
}
