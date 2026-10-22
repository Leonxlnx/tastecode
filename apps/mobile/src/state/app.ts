import { TasteLink } from '../../modules/tastecode-link'
import { Connection } from '../link/connection'
import { loadPairing, parsePairingLink, savePairing, type Pairing } from '../link/pairing'
import { Store } from '../store'
import { Catalog } from './catalog'
import { Projects } from './projects'
import { ThreadSessions } from './thread-session'

type AppState = {
  connection: Connection
  projects: Projects
  catalog: Catalog
  sessions: ThreadSessions
  pairing: Store<Pairing | undefined>
}

function create(): AppState {
  const connection = new Connection()
  const state = {
    connection,
    projects: new Projects(connection),
    catalog: new Catalog(connection),
    sessions: new ThreadSessions(connection),
    pairing: new Store<Pairing | undefined>(loadPairing()),
  }
  connection.onPairingChange((next) => state.pairing.set(next))
  return state
}

// One link per process. Fast Refresh re-runs this module during development;
// a second Connection would answer the native link's events beside the first.
const holder = globalThis as typeof globalThis & { __tastecode?: AppState }
const state = (holder.__tastecode ??= create())

export const { connection, projects, catalog, sessions, pairing } = state

/** Connects to the paired computer, if there is one. */
export function startLink(): void {
  const current = pairing.get()
  if (current) connection.start(current)
}

/**
 * Pairs with the computer a pairing link names and connects. The pairing
 * secret goes in the first link's handshake; the computer forgets it once used.
 */
export function pairWith(link: string): Pairing {
  const next = parsePairingLink(link)
  // A new computer starts clean: nothing of the previous one's chats remains.
  sessions.clear()
  projects.state.set({ status: 'idle', error: undefined, projects: [], activity: {} })
  catalog.state.set({ status: 'idle', sources: [] })
  catalog.hidden.set(new Set())
  savePairing(next)
  pairing.set(next)
  connection.start(next)
  return next
}

/** Forgets the computer and this phone's key; the computer must pair it again. */
export function forgetComputer(): void {
  connection.stop()
  sessions.clear()
  TasteLink.forgetPairing()
  pairing.set(undefined)
  projects.state.set({ status: 'idle', error: undefined, projects: [], activity: {} })
  catalog.state.set({ status: 'idle', sources: [] })
  catalog.hidden.set(new Set())
}
