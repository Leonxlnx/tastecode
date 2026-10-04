import { stat } from 'node:fs/promises'

export const MAX_DROPPED_PROJECT_PATHS = 128

/**
 * Keeps only real folders from an operating-system file drop. The renderer
 * supplies paths obtained from Electron's webUtils bridge, but filesystem
 * validation stays in the trusted desktop process.
 */
export async function droppedFolderPaths(candidatePaths: readonly string[]): Promise<string[]> {
  const uniquePaths = [...new Set(candidatePaths.filter(Boolean))].slice(
    0,
    MAX_DROPPED_PROJECT_PATHS,
  )
  const folders = await Promise.all(
    uniquePaths.map(async (candidate) => {
      try {
        return (await stat(candidate)).isDirectory() ? candidate : undefined
      } catch {
        return undefined
      }
    }),
  )
  return folders.filter((candidate): candidate is string => candidate !== undefined)
}
