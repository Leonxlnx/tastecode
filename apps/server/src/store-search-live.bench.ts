import { afterAll, bench, describe } from 'vitest'
import { Store } from './store.js'

const OPTIONS = { time: 1_200, warmupTime: 300 }
const store = new Store(':memory:')
store.addProject('/search')
store.addThread({ id: 'thread', projectPath: '/search', provider: 'codex', title: 'Search' })
for (let index = 0; index < 100; index += 1) {
  store.append('thread', {
    type: 'item.completed',
    item: {
      id: `item-${index}`,
      turnId: `turn-${index}`,
      type: 'message',
      role: 'assistant',
      status: 'completed',
      text: index === 0 ? 'unique needle' : `shared needle result ${index}`,
      createdAt: index,
    },
  })
}

const broadStore = new Store(':memory:')
broadStore.addProject('/broad-search')
broadStore.addThread({
  id: 'broad-thread',
  projectPath: '/broad-search',
  provider: 'codex',
  title: 'Broad search',
})
for (let index = 0; index < 20_000; index += 1) {
  broadStore.append('broad-thread', {
    type: 'item.completed',
    item: {
      id: `broad-item-${index}`,
      turnId: `broad-turn-${index}`,
      type: 'message',
      role: 'assistant',
      status: 'completed',
      text: `Performance result ${index}: long thread output and command details for global search.`,
      createdAt: index,
    },
  })
}

afterAll(() => {
  store.close()
  broadStore.close()
})

describe('short global search', () => {
  bench(
    'repeats one exact result',
    () => {
      if (store.searchSessions({ query: 'unique', limit: 25 }).results.length !== 1) {
        throw new Error('missing exact result')
      }
    },
    OPTIONS,
  )

  bench(
    'repeats the first page of 100 results',
    () => {
      if (store.searchSessions({ query: 'needle', limit: 25 }).results.length !== 25) {
        throw new Error('missing result page')
      }
    },
    OPTIONS,
  )
})

describe('broad global search', () => {
  bench(
    'repeats the first page of 20,000 unchanged results',
    () => {
      if (broadStore.searchSessions({ query: 'performance', limit: 25 }).results.length !== 25) {
        throw new Error('missing broad result page')
      }
    },
    { iterations: 10, time: 0, warmupIterations: 3, warmupTime: 0 },
  )

  let coldIndex = 0
  bench(
    'returns the cold first page after the search index changes',
    () => {
      const index = coldIndex++
      broadStore.append('broad-thread', {
        type: 'item.completed',
        item: {
          id: `cold-item-${index}`,
          turnId: `cold-turn-${index}`,
          type: 'message',
          role: 'assistant',
          status: 'completed',
          text: `Unrelated cache invalidation ${index}`,
          createdAt: 20_000 + index,
        },
      })
      if (broadStore.searchSessions({ query: 'performance', limit: 25 }).results.length !== 25) {
        throw new Error('missing cold broad result page')
      }
    },
    { iterations: 10, time: 0, warmupIterations: 3, warmupTime: 0 },
  )
})
