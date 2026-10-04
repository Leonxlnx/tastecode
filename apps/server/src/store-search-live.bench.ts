import { afterAll, bench, describe } from 'vitest'
import { Store } from './store.js'

const OPTIONS = { time: 1_200, warmupTime: 300 }
const FILTERED_OPTIONS = { iterations: 50, time: 0, warmupIterations: 5, warmupTime: 0 }
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
broadStore.addProject('/outside-search')
broadStore.addThread({
  id: 'outside-thread',
  projectPath: '/outside-search',
  provider: 'codex',
  title: 'Outside search',
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

const selectiveStore = new Store(':memory:')
for (let project = 0; project < 10; project += 1) {
  selectiveStore.addProject(`/selective-${project}`)
  for (const provider of ['codex', 'grok'] as const) {
    selectiveStore.addThread({
      id: `selective-${project}-${provider}`,
      projectPath: `/selective-${project}`,
      provider,
      title: `Selective ${project} ${provider}`,
    })
  }
}
for (let index = 0; index < 20_000; index += 1) {
  const project = index % 10
  const provider = Math.floor(index / 10) % 2 === 0 ? 'codex' : 'grok'
  selectiveStore.append(`selective-${project}-${provider}`, {
    type: 'item.completed',
    item: {
      id: `selective-item-${index}`,
      turnId: `selective-turn-${index}`,
      type: 'message',
      role: 'assistant',
      status: 'completed',
      text: `Performance selective result ${index}: project and provider filtered search.`,
      createdAt: index,
    },
  })
}

afterAll(() => {
  store.close()
  broadStore.close()
  selectiveStore.close()
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
    'refreshes the first page after an unrelated search index change',
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

  let matchingIndex = 0
  bench(
    'refreshes the cold first page after a matching search index change',
    () => {
      const index = matchingIndex++
      broadStore.append('broad-thread', {
        type: 'item.completed',
        item: {
          id: `matching-item-${index}`,
          turnId: `matching-turn-${index}`,
          type: 'message',
          role: 'assistant',
          status: 'completed',
          text: `Performance newly matching cache invalidation ${index}`,
          createdAt: 30_000 + index,
        },
      })
      if (broadStore.searchSessions({ query: 'performance', limit: 25 }).results.length !== 25) {
        throw new Error('missing matching cold broad result page')
      }
    },
    { iterations: 10, time: 0, warmupIterations: 3, warmupTime: 0 },
  )

  let filteredMatchingIndex = 0
  bench(
    'refreshes a project-filtered page after a matching change inside the project',
    () => {
      const index = filteredMatchingIndex++
      broadStore.append('broad-thread', {
        type: 'item.completed',
        item: {
          id: `filtered-matching-item-${index}`,
          turnId: `filtered-matching-turn-${index}`,
          type: 'message',
          role: 'assistant',
          status: 'completed',
          text: `Performance inside project ${index}`,
          createdAt: 35_000 + index,
        },
      })
      if (
        broadStore.searchSessions({
          query: 'performance',
          projectPath: '/broad-search',
          limit: 25,
        }).results.length !== 25
      ) {
        throw new Error('missing filtered matching result page')
      }
    },
    FILTERED_OPTIONS,
  )

  let outsideProjectIndex = 0
  bench(
    'refreshes a project-filtered page after a matching change outside the project',
    () => {
      const index = outsideProjectIndex++
      broadStore.append('outside-thread', {
        type: 'item.completed',
        item: {
          id: `outside-item-${index}`,
          turnId: `outside-turn-${index}`,
          type: 'message',
          role: 'assistant',
          status: 'completed',
          text: `Performance outside project ${index}`,
          createdAt: 40_000 + index,
        },
      })
      if (
        broadStore.searchSessions({
          query: 'performance',
          projectPath: '/broad-search',
          limit: 25,
        }).results.length !== 25
      ) {
        throw new Error('missing filtered broad result page')
      }
    },
    FILTERED_OPTIONS,
  )
})

describe('selective filtered search', () => {
  let projectIndex = 0
  bench(
    'refreshes 2,000 of 20,000 matches inside one project',
    () => {
      const index = projectIndex++
      selectiveStore.append('selective-0-codex', {
        type: 'item.completed',
        item: {
          id: `project-refresh-${index}`,
          turnId: `project-refresh-${index}`,
          type: 'message',
          role: 'assistant',
          status: 'completed',
          text: `Performance selective project refresh ${index}`,
          createdAt: 50_000 + index,
        },
      })
      if (
        selectiveStore.searchSessions({
          query: 'performance',
          projectPath: '/selective-0',
          limit: 25,
        }).results.length !== 25
      ) {
        throw new Error('missing selective project page')
      }
    },
    { iterations: 25, time: 0, warmupIterations: 5, warmupTime: 0 },
  )

  let providerIndex = 0
  bench(
    'refreshes 1,000 of 20,000 matches inside one project and provider',
    () => {
      const index = providerIndex++
      selectiveStore.append('selective-0-codex', {
        type: 'item.completed',
        item: {
          id: `provider-refresh-${index}`,
          turnId: `provider-refresh-${index}`,
          type: 'message',
          role: 'assistant',
          status: 'completed',
          text: `Performance selective provider refresh ${index}`,
          createdAt: 60_000 + index,
        },
      })
      if (
        selectiveStore.searchSessions({
          query: 'performance',
          projectPath: '/selective-0',
          provider: 'codex',
          limit: 25,
        }).results.length !== 25
      ) {
        throw new Error('missing selective provider page')
      }
    },
    { iterations: 25, time: 0, warmupIterations: 5, warmupTime: 0 },
  )
})
