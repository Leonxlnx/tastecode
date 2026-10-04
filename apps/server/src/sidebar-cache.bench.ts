import { afterAll, bench, describe } from 'vitest'
import { Store } from './store.js'

const THREAD_COUNT = 10_000
const BURST_COUNT = 500
const OPTIONS = { iterations: 5, time: 0, warmupIterations: 2, warmupTime: 0 }

function makeStore(prefix: string): Store {
  const store = new Store(':memory:')
  store.addProject('/sidebar-cache')
  for (let index = 0; index < THREAD_COUNT; index += 1) {
    store.addThread({
      id: `${prefix}-${index}`,
      projectPath: '/sidebar-cache',
      provider: 'codex',
      title: `Thread ${index}`,
      createdAt: index,
    })
  }
  store.sidebarThreads()
  return store
}

const unbatchedStore = makeStore('unbatched')
const batchedStore = makeStore('batched')
let unbatchedGeneration = 0
let batchedGeneration = 0

function renameBurst(
  store: Store,
  prefix: string,
  generation: number,
  publishEachUpdate = false,
): void {
  for (let index = 0; index < BURST_COUNT; index += 1) {
    store.renameThread(`${prefix}-${index}`, `Generation ${generation}`)
    if (publishEachUpdate) store.sidebarThreads()
  }
  if (store.sidebarThreads().at(-1)?.title !== `Generation ${generation}`) {
    throw new Error('sidebar cache missed a burst update')
  }
}

afterAll(() => {
  unbatchedStore.close()
  batchedStore.close()
})

describe('many-thread sidebar cache update bursts', () => {
  bench(
    'publishes a 10,000-thread snapshot after every metadata update',
    () => renameBurst(unbatchedStore, 'unbatched', ++unbatchedGeneration, true),
    OPTIONS,
  )

  bench(
    'coalesces 500 metadata updates until the next sidebar read',
    () => renameBurst(batchedStore, 'batched', ++batchedGeneration),
    OPTIONS,
  )
})
