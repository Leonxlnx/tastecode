import { mkdirSync } from 'node:fs'
import path from 'node:path'

const ADJECTIVES = [
  'amber',
  'azure',
  'brisk',
  'calm',
  'cedar',
  'clear',
  'coral',
  'crisp',
  'dusky',
  'ember',
  'fern',
  'frosty',
  'golden',
  'hazel',
  'ivory',
  'jade',
  'lunar',
  'maple',
  'misty',
  'mossy',
  'olive',
  'pearl',
  'quiet',
  'rapid',
  'rosy',
  'sage',
  'silver',
  'solar',
  'still',
  'sunny',
  'tidal',
  'velvet',
] as const

const NOUNS = [
  'badger',
  'birch',
  'brook',
  'canyon',
  'comet',
  'crane',
  'delta',
  'falcon',
  'finch',
  'fjord',
  'harbor',
  'heron',
  'island',
  'kestrel',
  'lagoon',
  'lark',
  'meadow',
  'otter',
  'pebble',
  'pine',
  'plover',
  'quartz',
  'raven',
  'reef',
  'ridge',
  'river',
  'robin',
  'spruce',
  'summit',
  'valley',
  'willow',
  'wren',
] as const

/** Random tries before a name falls back to a numbered one. */
const RANDOM_ATTEMPTS = 20

/** The local date as YYYY-MM-DD, the day the user sees on their own clock. */
function localDate(now: Date): string {
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

function pick<T>(list: readonly T[], random: () => number): T {
  return list[Math.min(list.length - 1, Math.floor(random() * list.length))]!
}

/** Creates `folder` unless it exists already; other failures are thrown. */
function make(folder: string): boolean {
  try {
    mkdirSync(folder)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  }
}

/**
 * Make an empty folder for a chat that belongs to no project, named after the
 * day and two random words: `2026-11-01-amber-heron`. An existing folder is
 * never reused, because another chat's files would be in it.
 */
export function createChatFolder(
  root: string,
  options: { now?: Date; random?: () => number } = {},
): string {
  const random = options.random ?? Math.random
  const date = localDate(options.now ?? new Date())
  const name = () => `${date}-${pick(ADJECTIVES, random)}-${pick(NOUNS, random)}`
  mkdirSync(root, { recursive: true })
  const first = name()
  for (let attempt = 0; attempt < RANDOM_ATTEMPTS; attempt += 1) {
    const folder = path.join(root, attempt === 0 ? first : name())
    if (make(folder)) return folder
  }
  for (let number = 2; ; number += 1) {
    const folder = path.join(root, `${first}-${number}`)
    if (make(folder)) return folder
  }
}

/** Whether `projectPath` is one of the folders createChatFolder made in `root`. */
export function isChatFolder(root: string, projectPath: string): boolean {
  return path.dirname(projectPath) === root
}
