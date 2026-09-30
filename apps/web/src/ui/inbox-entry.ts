import type { Project, Session } from './Sidebar.js'

/** A thread together with the project it belongs to, as the thread sidebar lists it. */
export type Entry = { project: Project; session: Session }

/** Sessions that are working or waiting on the user cannot be settled or snoozed. */
export function canHide(session: Session): boolean {
  return !['starting', 'working', 'queued', 'approval', 'input'].includes(session.status)
}
