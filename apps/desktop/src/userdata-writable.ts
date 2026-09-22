import { constants, accessSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Whether `directory` can be created or written to — walks up to the deepest
 * existing ancestor and checks it for write+execute. Used to distinguish a
 * real second instance from an unwritable profile directory, because
 * `requestSingleInstanceLock` returns false in both cases.
 */
export function writableOrCreatable(directory: string): boolean {
  let current = directory
  for (;;) {
    if (existsSync(current)) break
    const parent = dirname(current)
    if (parent === current) return false
    current = parent
  }
  try {
    accessSync(current, constants.W_OK | constants.X_OK)
    return true
  } catch {
    return false
  }
}
