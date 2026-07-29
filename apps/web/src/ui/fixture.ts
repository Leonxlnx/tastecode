import type { Item } from '@harness/contracts'

/**
 * A synthetic thread, generated locally.
 *
 * No network, no provider, no tokens — this is string concatenation. It exists
 * so performance can be measured against a session far longer than anyone
 * would sit through creating by hand, and so a regression in virtualisation
 * fails a test rather than being noticed by a user six weeks later.
 */

const WORDS =
  'the agent read the file and decided the change was safe enough to apply without asking again'.split(
    ' ',
  )

/** Deterministic, so a failing budget is reproducible rather than luck. */
function pseudoRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x100000000
  }
}

function sentence(rand: () => number, words: number): string {
  return Array.from({ length: words }, () => WORDS[Math.floor(rand() * WORDS.length)]).join(' ')
}

export function makeFixtureThread(itemCount: number, seed = 7): Item[] {
  const rand = pseudoRandom(seed)
  const items: Item[] = []
  let turn = 0

  while (items.length < itemCount) {
    turn += 1
    const turnId = `turn-${turn}`
    const at = 1_700_000_000_000 + turn * 1000

    items.push({
      id: `${turnId}-user`,
      turnId,
      type: 'message',
      role: 'user',
      status: 'completed',
      text: sentence(rand, 8 + Math.floor(rand() * 12)),
      createdAt: at,
    })

    // A real turn is mostly machinery: a couple of commands and some thinking
    // around one answer. The mix matters, because those rows are the cheap ones
    // and a fixture of pure prose would flatter us.
    const detail = 1 + Math.floor(rand() * 4)
    for (let i = 0; i < detail && items.length < itemCount; i++) {
      const kind = rand()
      items.push(
        kind < 0.4
          ? {
              id: `${turnId}-cmd-${i}`,
              turnId,
              type: 'command',
              status: 'completed',
              command: `pnpm ${sentence(rand, 2)}`,
              text: sentence(rand, 40),
              exitCode: 0,
              durationMs: Math.floor(rand() * 8000),
              createdAt: at,
            }
          : kind < 0.7
            ? {
                id: `${turnId}-think-${i}`,
                turnId,
                type: 'reasoning',
                status: 'completed',
                text: sentence(rand, 30),
                createdAt: at,
              }
            : {
                id: `${turnId}-file-${i}`,
                turnId,
                type: 'file_change',
                status: 'completed',
                path: `src/${sentence(rand, 1)}.ts`,
                linesAdded: Math.floor(rand() * 60),
                linesRemoved: Math.floor(rand() * 20),
                createdAt: at,
              },
      )
    }

    if (items.length < itemCount) {
      items.push({
        id: `${turnId}-agent`,
        turnId,
        type: 'message',
        role: 'assistant',
        status: 'completed',
        text: `${sentence(rand, 40)}\n\n\`\`\`ts\nconst x = ${turn}\n\`\`\`\n\n${sentence(rand, 25)}`,
        createdAt: at,
      })
    }
  }

  return items.slice(0, itemCount)
}
